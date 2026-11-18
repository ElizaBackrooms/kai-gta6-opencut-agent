import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { loadState, saveState } from "../state.js";

export interface DriveFolderInfo {
  folderId: string;
  folderUrl: string;
}

export interface DriveUploadResult {
  fileId: string;
  webUrl: string;
  name: string;
}

function quoteWinArg(arg: string): string {
  if (/^[a-zA-Z0-9._:/\\=-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function resolveGdriveBin(): string {
  try {
    const checkCmd = process.platform === "win32" ? "where gdrive" : "command -v gdrive";
    execSync(checkCmd, { stdio: "ignore" });
    return "gdrive";
  } catch {
    if (config.binaries.gdriveBootstrapCmd && fs.existsSync(config.binaries.gdriveBootstrapCmd)) {
      return quoteWinArg(config.binaries.gdriveBootstrapCmd);
    }
    return "gdrive";
  }
}

let cachedGdriveBin: string | null = null;

function runGdrive(args: string[]): string {
  if (!cachedGdriveBin) {
    cachedGdriveBin = resolveGdriveBin();
  }
  const cmd = `${cachedGdriveBin} ${args.map(quoteWinArg).join(" ")}`;
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function getDriveWebUrl(fileId: string, isFolder = false): string {
  try {
    const out = runGdrive(["readonly", "url", fileId, "--json"]);
    const parsed = parseJsonSafe<{ url?: string; webViewLink?: string } | string>(out);
    if (typeof parsed === "string" && parsed.startsWith("http")) return parsed;
    if (parsed && typeof parsed === "object") {
      if (parsed.url) return parsed.url;
      if (parsed.webViewLink) return parsed.webViewLink;
    }
    const plain = out.match(/https:\/\/drive\.google\.com\/\S+/)?.[0];
    if (plain) return plain;
  } catch {
    // Fallback below
  }
  return isFolder
    ? `https://drive.google.com/drive/folders/${fileId}`
    : `https://drive.google.com/file/d/${fileId}/view`;
}

export function ensureKaiClipsFolder(
  folderName = config.drive.folderName,
): DriveFolderInfo {
  const state = loadState();

  if (state.driveFolderId) {
    try {
      const infoRaw = runGdrive(["readonly", "info", state.driveFolderId, "--json"]);
      const info = parseJsonSafe<{ id?: string; trashed?: boolean; name?: string }>(infoRaw);
      if (info?.id && !info.trashed) {
        const folderUrl = state.driveFolderUrl ?? getDriveWebUrl(info.id, true);
        return { folderId: info.id, folderUrl };
      }
    } catch {
      // Folder may have been moved/deleted; re-resolve below
    }
  }

  const searchRaw = runGdrive([
    "readonly",
    "search",
    "--name-exact",
    folderName,
    "--type",
    "folder",
    "--json",
  ]);
  const matches =
    parseJsonSafe<Array<{ id: string; name: string; trashed?: boolean }>>(searchRaw) ?? [];

  let folderId = matches.find((m) => !m.trashed)?.id;

  if (!folderId) {
    console.log(`[drive] Creating Google Drive folder '${folderName}'...`);
    const mkdirRaw = runGdrive(["mutate", "mkdir", folderName, "--json"]);
    const created = parseJsonSafe<{ id?: string }>(mkdirRaw);
    folderId = created?.id;

    if (!folderId) {
      const retryRaw = runGdrive([
        "readonly",
        "search",
        "--name-exact",
        folderName,
        "--type",
        "folder",
        "--json",
      ]);
      const retryMatches =
        parseJsonSafe<Array<{ id: string; name: string; trashed?: boolean }>>(retryRaw) ?? [];
      folderId = retryMatches.find((m) => !m.trashed)?.id;
    }
  }

  if (!folderId) {
    throw new Error(`Could not resolve or create Google Drive folder '${folderName}'`);
  }

  const folderUrl = getDriveWebUrl(folderId, true);
  state.driveFolderId = folderId;
  state.driveFolderUrl = folderUrl;
  saveState(state);

  console.log(`[drive] Using folder '${folderName}' (${folderId}) -> ${folderUrl}`);
  return { folderId, folderUrl };
}

export function uploadClipToDrive(
  mp4Path: string,
  folderId: string,
): DriveUploadResult {
  if (!fs.existsSync(mp4Path)) {
    throw new Error(`Cannot upload missing file: ${mp4Path}`);
  }
  const fileName = path.basename(mp4Path);

  // Check if file already exists in folder to avoid duplicates on retry
  let existingId: string | undefined;
  try {
    const existingRaw = runGdrive([
      "readonly",
      "search",
      "--parent-id",
      folderId,
      "--name-exact",
      fileName,
      "--json",
    ]);
    const existing =
      parseJsonSafe<Array<{ id: string; trashed?: boolean }>>(existingRaw) ?? [];
    existingId = existing.find((f) => !f.trashed)?.id;
  } catch {
    // Proceed with fresh upload
  }

  let fileId: string | undefined;
  if (existingId) {
    console.log(`[drive] Updating existing file '${fileName}' (${existingId})...`);
    const updateRaw = runGdrive(["mutate", "update", existingId, mp4Path, "--json"]);
    const updated = parseJsonSafe<{ id?: string }>(updateRaw);
    fileId = updated?.id ?? existingId;
  } else {
    console.log(`[drive] Uploading '${fileName}' to kaiclips (${folderId})...`);
    const uploadRaw = runGdrive([
      "mutate",
      "upload",
      mp4Path,
      "--parent",
      folderId,
      "--json",
    ]);
    const uploaded = parseJsonSafe<{ id?: string }>(uploadRaw);
    fileId = uploaded?.id;
  }

  if (!fileId) {
    const searchRaw = runGdrive([
      "readonly",
      "search",
      "--parent-id",
      folderId,
      "--name-exact",
      fileName,
      "--json",
    ]);
    const found =
      parseJsonSafe<Array<{ id: string; trashed?: boolean }>>(searchRaw) ?? [];
    fileId = found.find((f) => !f.trashed)?.id;
  }

  if (!fileId) {
    throw new Error(`Upload succeeded or ran, but could not determine Drive file ID for ${fileName}`);
  }

  const webUrl = getDriveWebUrl(fileId, false);
  console.log(`[drive] Uploaded '${fileName}' -> ${webUrl}`);
  return { fileId, webUrl, name: fileName };
}

export function listKaiClipsInDrive(
  folderId: string,
): Array<{ id: string; name: string; size?: string; mimeType?: string }> {
  const raw = runGdrive(["readonly", "ls", folderId, "--json"]);
  return parseJsonSafe<Array<{ id: string; name: string; size?: string; mimeType?: string }>>(raw) ?? [];
}
