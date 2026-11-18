import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, "..");
const homeDir = os.homedir();

function pickExistingPath(envVar: string | undefined, candidates: string[]): string {
  if (envVar && fs.existsSync(envVar)) return envVar;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1] ?? "";
}

export const config = {
  projectRoot,
  rawDir: path.join(projectRoot, "public", "raw"),
  projectsDir: path.join(projectRoot, "public", "projects"),
  outDir: path.join(projectRoot, "out"),
  dataDir: path.join(projectRoot, "data"),
  stateFile: path.join(projectRoot, "data", "state.json"),

  binaries: {
    ffmpeg: pickExistingPath(process.env.FFMPEG_PATH, [
      path.join(
        homeDir,
        "AppData",
        "Local",
        "Microsoft",
        "WinGet",
        "Packages",
        "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
        "ffmpeg-9.0.1-full_build",
        "bin",
        "ffmpeg.exe",
      ),
      "ffmpeg",
    ]),
    ffprobe: pickExistingPath(process.env.FFPROBE_PATH, [
      path.join(
        homeDir,
        "AppData",
        "Local",
        "Microsoft",
        "WinGet",
        "Packages",
        "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
        "ffmpeg-9.0.1-full_build",
        "bin",
        "ffprobe.exe",
      ),
      "ffprobe",
    ]),
    whisperBin: pickExistingPath(process.env.WHISPER_BIN, [
      path.join(
        homeDir,
        "Projects",
        "daily-tech-explainer",
        "tools",
        "whisper",
        "bin",
        "whisper-cli.exe",
      ),
      "whisper-cli",
    ]),
    whisperModel: pickExistingPath(process.env.WHISPER_MODEL, [
      path.join(
        homeDir,
        "Projects",
        "daily-tech-explainer",
        "tools",
        "whisper",
        "models",
        "ggml-base.en.bin",
      ),
      path.join(projectRoot, "models", "ggml-base.en.bin"),
    ]),
    gdriveBootstrapCmd: path.join(
      homeDir,
      ".gemini",
      "config",
      "plugins",
      "gdrive",
      "skills",
      "gdrive",
      "scripts",
      "gdrive.cmd",
    ),
  },

  streamer: {
    channelLogin: process.env.TWITCH_CHANNEL ?? "kaicenat",
    twitchClientId: "kimne78kx3ncx6brgo4mv6wki5h1ko",
    targetGameKeywords: [
      "Grand Theft Auto VI",
      "GTA 6",
      "GTA VI",
      "Grand Theft Auto",
    ],
  },

  drive: {
    folderName: process.env.GDRIVE_FOLDER_NAME ?? "kaiclips",
  },

  video: {
    width: 1080,
    height: 1920,
    fps: 30,
    playbackRate: 1.0,
    topHeight: 680,
    bottomHeight: 1240,
    facecamCrop: {
      xRatio: Number(process.env.FACECAM_X_RATIO ?? "0.0"),
      yRatio: Number(process.env.FACECAM_Y_RATIO ?? "0.65"),
      wRatio: Number(process.env.FACECAM_W_RATIO ?? "0.26"),
      hRatio: Number(process.env.FACECAM_H_RATIO ?? "0.35"),
    },
  },
} as const;

export function ensureDirectories(): void {
  for (const dir of [
    config.rawDir,
    config.projectsDir,
    config.outDir,
    config.dataDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
