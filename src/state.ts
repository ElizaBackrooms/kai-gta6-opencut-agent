import fs from "node:fs";
import path from "node:path";
import { config, ensureDirectories } from "./config.js";

export interface ProcessedClipRecord {
  id: string;
  slug: string;
  title: string;
  sourceType: "twitch-clip" | "live-stream";
  createdAt: string;
  processedAt: string;
  rawPath: string;
  outputPath: string;
  opencutTimelinePath: string;
  driveFileId?: string;
  driveUrl?: string;
  hypeScore?: number;
  transcript?: string;
  durationSec?: number;
  viewCount?: number;
  gameName?: string;
}

export interface BotState {
  driveFolderId?: string;
  driveFolderUrl?: string;
  lastCheckedAt?: string;
  processedClips: Record<string, ProcessedClipRecord>;
}

const DEFAULT_STATE: BotState = {
  processedClips: {},
};

export function loadState(): BotState {
  ensureDirectories();
  if (!fs.existsSync(config.stateFile)) {
    return { ...DEFAULT_STATE, processedClips: {} };
  }
  try {
    const raw = fs.readFileSync(config.stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<BotState>;
    return {
      driveFolderId: parsed.driveFolderId,
      driveFolderUrl: parsed.driveFolderUrl,
      lastCheckedAt: parsed.lastCheckedAt,
      processedClips: parsed.processedClips ?? {},
    };
  } catch {
    return { ...DEFAULT_STATE, processedClips: {} };
  }
}

export function saveState(state: BotState): void {
  ensureDirectories();
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2), "utf8");
}

export function isClipProcessed(slug: string): boolean {
  const state = loadState();
  return Boolean(state.processedClips[slug]);
}

export function recordProcessedClip(entry: ProcessedClipRecord): BotState {
  const state = loadState();
  state.processedClips[entry.slug] = entry;
  state.lastCheckedAt = new Date().toISOString();
  saveState(state);
  return state;
}
