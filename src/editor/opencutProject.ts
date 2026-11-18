import fs from "node:fs";
import path from "node:path";
import type {
  KeywordEntry,
  SubtitleSegment,
  TimelineSegment,
  VideoConfig,
  Word,
} from "opencut";
import type { VideoProjectConfig } from "opencut/dist/workflow/types.js";
import { validateProject } from "opencut/dist/workflow/validator.js";
import { config } from "../config.js";

const HYPE_TRIGGER_WORDS = new Set([
  "gta",
  "crazy",
  "insane",
  "bro",
  "chat",
  "wtf",
  "damn",
  "police",
  "wasted",
  "fire",
  "wild",
  "dead",
  "no",
  "way",
  "yo",
  "shoot",
]);

export interface BuiltOpenCutProject {
  slug: string;
  projectDir: string;
  projectJsonPath: string;
  subtitlesJsonPath: string;
  timelinePath: string;
  projectConfig: VideoProjectConfig;
  videoConfig: VideoConfig;
  timeline: TimelineSegment[];
  keywords: KeywordEntry[];
}

export function extractKeywordsFromWords(words: Word[]): KeywordEntry[] {
  const keywords: KeywordEntry[] = [];
  let lastEnd = -2;

  for (const w of words) {
    const clean = w.word.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!HYPE_TRIGGER_WORDS.has(clean)) continue;
    if (w.start - lastEnd < 3.0) continue;

    const startSec = Number(Math.max(0, w.start - 0.1).toFixed(2));
    const endSec = Number((w.start + 1.35).toFixed(2));
    keywords.push({
      text: w.word.toUpperCase().replace(/[.,!?]+$/, ""),
      startSec,
      endSec,
    });
    lastEnd = endSec;
    if (keywords.length >= 4) break;
  }

  return keywords;
}

export function createOpenCutProject(opts: {
  slug: string;
  title: string;
  rawVideoPath: string;
  durationSec: number;
  subtitles: SubtitleSegment[];
  words: Word[];
  gameName?: string;
}): BuiltOpenCutProject {
  const projectDir = path.join(config.projectsDir, opts.slug);
  fs.mkdirSync(projectDir, { recursive: true });

  const safeDuration = Number(Math.max(1, opts.durationSec).toFixed(3));
  const publicDir = path.join(config.projectRoot, "public");
  const facecamRelativeAsset = path
    .relative(publicDir, opts.rawVideoPath)
    .replace(/\\/g, "/");

  const keywords = extractKeywordsFromWords(opts.words);

  const projectConfig: VideoProjectConfig = {
    name: `kai-gta6-${opts.slug}`,
    format: "vertical",
    facecam: facecamRelativeAsset,
    playbackRate: config.video.playbackRate,
    title: opts.title,
    subtitle: `KAI CENAT • ${opts.gameName ?? "GTA VI"}`,
    segments: [
      {
        id: "main-clip",
        type: "split-screen",
        duration: safeDuration,
        faceBubble: "hidden",
        showSubtitles: true,
        showTitleCard: true,
        keywords,
        splitContent: {
          faceSide: "left",
          contentType: "image",
          bgColor: "#0a0a12",
          accentColor: "#ff2a85",
        },
        audioWaveform: {
          barCount: 28,
          color: "#ff2a85",
          height: 48,
          position: "bottom",
          intensity: 0.85,
        },
      },
    ],
  };

  const validationErrors = validateProject(projectConfig);
  if (validationErrors.length > 0) {
    throw new Error(
      `OpenCut project validation failed for '${opts.slug}': ${validationErrors.join("; ")}`,
    );
  }

  const videoConfig: VideoConfig = {
    playbackRate: config.video.playbackRate,
    fps: config.video.fps,
    width: config.video.width,
    height: config.video.height,
    crossfadeFrames: 6,
    facecamAsset: facecamRelativeAsset,
  };

  const timeline: TimelineSegment[] = [
    {
      id: "main-clip",
      type: "split-screen",
      facecamStartSec: 0,
      durationSec: safeDuration,
      faceBubble: "hidden",
      showSubtitles: true,
      showTitleCard: true,
      keywords,
      splitContent: {
        faceSide: "left",
        contentType: "image",
        bgColor: "#0a0a12",
        accentColor: "#ff2a85",
      },
      audioWaveform: {
        barCount: 28,
        color: "#ff2a85",
        height: 48,
        position: "bottom",
        intensity: 0.85,
      },
    },
  ];

  const projectJsonPath = path.join(projectDir, "project.json");
  const subtitlesJsonPath = path.join(projectDir, "subtitles.json");
  const timelinePath = path.join(projectDir, "timeline.ts");

  fs.writeFileSync(
    projectJsonPath,
    JSON.stringify(
      {
        slug: opts.slug,
        title: opts.title,
        gameName: opts.gameName ?? "Grand Theft Auto VI",
        projectConfig,
        videoConfig,
        timeline,
        keywords,
      },
      null,
      2,
    ),
    "utf8",
  );

  fs.writeFileSync(
    subtitlesJsonPath,
    JSON.stringify(opts.subtitles, null, 2),
    "utf8",
  );

  const timelineTsContent = `// Auto-generated OpenCut timeline for ${opts.slug}
import type { KeywordEntry, SubtitleSegment, TimelineSegment, VideoConfig } from "opencut";
import type { VideoProjectConfig } from "opencut/dist/workflow/types.js";

export const PROJECT_CONFIG: VideoProjectConfig = ${JSON.stringify(projectConfig, null, 2)};

export const VIDEO_CONFIG: VideoConfig = ${JSON.stringify(videoConfig, null, 2)};

export const TIMELINE: TimelineSegment[] = ${JSON.stringify(timeline, null, 2)};

export const KEYWORDS: KeywordEntry[] = ${JSON.stringify(keywords, null, 2)};

export const SUBTITLES: SubtitleSegment[] = ${JSON.stringify(opts.subtitles, null, 2)};
`;
  fs.writeFileSync(timelinePath, timelineTsContent, "utf8");

  console.log(`[opencut] Validated and generated OpenCut project at ${projectDir}`);

  return {
    slug: opts.slug,
    projectDir,
    projectJsonPath,
    subtitlesJsonPath,
    timelinePath,
    projectConfig,
    videoConfig,
    timeline,
    keywords,
  };
}
