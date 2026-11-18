import path from "node:path";
import { Command } from "commander";
import { config, ensureDirectories } from "./config.js";
import {
  ensureKaiClipsFolder,
  listKaiClipsInDrive,
  uploadClipToDrive,
} from "./drive/gdrive.js";
import { createOpenCutProject } from "./editor/opencutProject.js";
import { renderVerticalClip, type RenderBackend } from "./editor/render.js";
import { probeMedia, transcribeMedia } from "./editor/transcribe.js";
import {
  captureAndScoreLiveSegment,
  downloadTwitchClipMp4,
  extractClipSlug,
  fetchViralGta6Clips,
  getChannelStatus,
  type ClipCandidate,
} from "./sources/twitch.js";
import { loadState, recordProcessedClip, saveState } from "./state.js";

export interface CycleOptions {
  maxClips: number;
  includeLive: boolean;
  forceLive: boolean;
  liveDuration: number;
  minHype: number;
  period: "LAST_DAY" | "LAST_WEEK";
  renderer: RenderBackend;
  skipUpload: boolean;
}

async function processCandidate(
  candidate: ClipCandidate,
  folderId: string | undefined,
  opts: { renderer: RenderBackend; skipUpload: boolean },
): Promise<void> {
  const projectWorkDir = path.join(config.projectsDir, candidate.slug);
  const probe = probeMedia(candidate.rawPath);
  const durationSec = probe.durationSec || candidate.durationSeconds || 25;

  console.log(
    `\n[pipeline] Processing '${candidate.slug}' (${candidate.sourceType}, ${durationSec.toFixed(1)}s): "${candidate.title}"`,
  );

  const transcription = transcribeMedia({
    mediaPath: candidate.rawPath,
    workDir: projectWorkDir,
    fallbackText: candidate.title,
    durationSec,
  });

  console.log(
    `[whisper] Transcribed ${transcription.words.length} words into ${transcription.segments.length} OpenCut subtitle segments${transcription.usedFallback ? " (fallback)" : ""}`,
  );

  const builtProject = createOpenCutProject({
    slug: candidate.slug,
    title: candidate.title,
    rawVideoPath: candidate.rawPath,
    durationSec,
    subtitles: transcription.segments,
    words: transcription.words,
    gameName: candidate.gameName,
  });

  const outputPath = path.join(config.outDir, `${candidate.slug}.mp4`);
  await renderVerticalClip({
    slug: candidate.slug,
    title: candidate.title,
    gameName: candidate.gameName,
    rawVideoPath: candidate.rawPath,
    outputPath,
    subtitles: transcription.segments,
    keywords: builtProject.keywords,
    mode: opts.renderer,
  });

  let driveFileId: string | undefined;
  let driveUrl: string | undefined;
  if (!opts.skipUpload && folderId) {
    const uploaded = uploadClipToDrive(outputPath, folderId);
    driveFileId = uploaded.fileId;
    driveUrl = uploaded.webUrl;
  }

  recordProcessedClip({
    id: candidate.id,
    slug: candidate.slug,
    title: candidate.title,
    sourceType: candidate.sourceType,
    createdAt: candidate.createdAt,
    processedAt: new Date().toISOString(),
    rawPath: candidate.rawPath,
    outputPath,
    opencutTimelinePath: builtProject.timelinePath,
    driveFileId,
    driveUrl,
    hypeScore: candidate.hypeScore,
    transcript: transcription.fullText,
    durationSec,
    viewCount: candidate.viewCount,
    gameName: candidate.gameName,
  });
}

export async function runOnceCycle(opts: CycleOptions): Promise<number> {
  ensureDirectories();
  const state = loadState();
  state.lastCheckedAt = new Date().toISOString();
  saveState(state);

  let folderId: string | undefined;
  if (!opts.skipUpload) {
    const folder = ensureKaiClipsFolder();
    folderId = folder.folderId;
  }

  const status = await getChannelStatus(config.streamer.channelLogin);
  if (status.isLive) {
    console.log(
      `[twitch] ${status.displayName} is LIVE playing '${status.gameName ?? "Unknown"}' (${status.viewersCount ?? 0} viewers): ${status.title}`,
    );
  } else {
    console.log(`[twitch] ${status.displayName} is currently offline.`);
  }

  const candidates: ClipCandidate[] = [];

  if (opts.includeLive && status.isLive && (status.isGta6 || opts.forceLive)) {
    try {
      const liveSeg = await captureAndScoreLiveSegment({
        durationSec: opts.liveDuration,
        minHypeScore: opts.minHype,
        forceKeep: opts.forceLive,
      });
      if (liveSeg) {
        candidates.push(liveSeg);
      }
    } catch (err) {
      console.warn(`[live] Live capture warning: ${String(err)}`);
    }
  }

  const latestState = loadState();
  const excludeSlugs = new Set(Object.keys(latestState.processedClips));
  if (opts.maxClips > 0) {
    const viralClips = await fetchViralGta6Clips({
      limit: opts.maxClips,
      period: opts.period,
      excludeSlugs,
    });
    console.log(`[twitch] Found ${viralClips.length} new GTA 6 viral clip(s) to process.`);
    candidates.push(...viralClips);
  }

  let processedCount = 0;
  for (const candidate of candidates) {
    try {
      await processCandidate(candidate, folderId, {
        renderer: opts.renderer,
        skipUpload: opts.skipUpload,
      });
      processedCount++;
    } catch (err) {
      console.error(`[pipeline] Failed processing ${candidate.slug}: ${String(err)}`);
    }
  }

  console.log(`[cycle] Completed cycle: ${processedCount}/${candidates.length} clip(s) finished.`);
  return processedCount;
}

const program = new Command();

program
  .name("kai-gta6-clipper")
  .description("Auto-clipper & OpenCut editor for Kai Cenat GTA 6 live stream -> Google Drive kaiclips")
  .version("1.0.0");

program
  .command("once")
  .description("Run one fetch + live capture + OpenCut edit + Google Drive upload cycle")
  .option("--max-clips <number>", "Max new viral Twitch clips to process", "2")
  .option("--include-live", "Capture & score live stream segment when live on GTA 6", true)
  .option("--no-include-live", "Skip live stream capture")
  .option("--force-live", "Keep live segment regardless of hype score threshold", false)
  .option("--live-duration <seconds>", "Duration of live stream capture segment", "25")
  .option("--min-hype <score>", "Minimum hype score (0-100) to keep live segment", "35")
  .option("--period <period>", "Twitch clip period: LAST_DAY or LAST_WEEK", "LAST_WEEK")
  .option("--renderer <backend>", "Render backend: ffmpeg or remotion", "ffmpeg")
  .option("--skip-upload", "Skip Google Drive upload", false)
  .action(async (rawOpts) => {
    await runOnceCycle({
      maxClips: Number(rawOpts.maxClips),
      includeLive: Boolean(rawOpts.includeLive),
      forceLive: Boolean(rawOpts.forceLive),
      liveDuration: Number(rawOpts.liveDuration),
      minHype: Number(rawOpts.minHype),
      period: rawOpts.period === "LAST_DAY" ? "LAST_DAY" : "LAST_WEEK",
      renderer: rawOpts.renderer === "remotion" ? "remotion" : "ffmpeg",
      skipUpload: Boolean(rawOpts.skipUpload),
    });
  });

program
  .command("watch")
  .description("Continuously monitor Kai Cenat live stream + new GTA 6 clips and upload to Google Drive")
  .option("--interval <seconds>", "Polling interval between cycles", "180")
  .option("--max-clips <number>", "Max new viral clips per cycle", "2")
  .option("--live-duration <seconds>", "Duration of each live stream capture", "25")
  .option("--min-hype <score>", "Minimum hype score (0-100) to keep live segment", "40")
  .option("--renderer <backend>", "Render backend: ffmpeg or remotion", "ffmpeg")
  .action(async (rawOpts) => {
    const intervalSec = Math.max(30, Number(rawOpts.interval));
    console.log(
      `[watch] Starting continuous Kai Cenat GTA 6 auto-clipper (interval=${intervalSec}s, folder='${config.drive.folderName}')`,
    );

    let cycleNum = 0;
    while (true) {
      cycleNum++;
      console.log(`\n========== Cycle #${cycleNum} @ ${new Date().toISOString()} ==========`);
      try {
        await runOnceCycle({
          maxClips: Number(rawOpts.maxClips),
          includeLive: true,
          forceLive: false,
          liveDuration: Number(rawOpts.liveDuration),
          minHype: Number(rawOpts.minHype),
          period: "LAST_DAY",
          renderer: rawOpts.renderer === "remotion" ? "remotion" : "ffmpeg",
          skipUpload: false,
        });
      } catch (err) {
        console.error(`[watch] Cycle #${cycleNum} error (will retry next interval): ${String(err)}`);
      }
      console.log(`[watch] Sleeping ${intervalSec}s before next check...`);
      await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
    }
  });

program
  .command("clip-url <urlOrSlug>")
  .description("Download, OpenCut-edit, and upload a specific Twitch clip URL or slug")
  .option("--title <text>", "Custom hook title override")
  .option("--renderer <backend>", "Render backend: ffmpeg or remotion", "ffmpeg")
  .option("--skip-upload", "Skip Google Drive upload", false)
  .action(async (urlOrSlug: string, rawOpts) => {
    ensureDirectories();
    const slug = extractClipSlug(urlOrSlug);
    const rawPath = path.join(config.rawDir, `${slug}.mp4`);
    const info = await downloadTwitchClipMp4(slug, rawPath);

    let folderId: string | undefined;
    if (!rawOpts.skipUpload) {
      folderId = ensureKaiClipsFolder().folderId;
    }

    await processCandidate(
      {
        id: info.id,
        slug: info.slug,
        title: rawOpts.title ?? info.title,
        viewCount: info.viewCount,
        createdAt: info.createdAt,
        durationSeconds: info.durationSeconds,
        url: info.url,
        gameName: info.gameName,
        sourceType: "twitch-clip",
        rawPath,
      },
      folderId,
      {
        renderer: rawOpts.renderer === "remotion" ? "remotion" : "ffmpeg",
        skipUpload: Boolean(rawOpts.skipUpload),
      },
    );
  });

program
  .command("status")
  .description("Show live stream status, kaiclips Drive folder, and processed clips")
  .action(async () => {
    const status = await getChannelStatus(config.streamer.channelLogin);
    const state = loadState();

    console.log("\n=== Kai Cenat Live Status ===");
    if (status.isLive) {
      console.log(
        `LIVE: ${status.displayName} | Game: ${status.gameName ?? "Unknown"} | Viewers: ${status.viewersCount} | Title: ${status.title}`,
      );
    } else {
      console.log(`OFFLINE: ${status.displayName}`);
    }

    console.log("\n=== Google Drive (kaiclips) ===");
    if (state.driveFolderId) {
      console.log(`Folder ID: ${state.driveFolderId}`);
      console.log(`Folder URL: ${state.driveFolderUrl ?? "unknown"}`);
      try {
        const files = listKaiClipsInDrive(state.driveFolderId);
        console.log(`Files in kaiclips (${files.length}):`);
        for (const f of files) {
          console.log(`  - ${f.name} (${f.id})`);
        }
      } catch (err) {
        console.warn(`Could not list Drive folder: ${String(err)}`);
      }
    } else {
      console.log("Not initialized yet. Run `npm run once` to create/resolve kaiclips.");
    }

    const entries = Object.values(state.processedClips);
    console.log(`\n=== Processed Clips (${entries.length}) ===`);
    for (const c of entries) {
      console.log(
        `  - [${c.sourceType}] ${c.slug} | "${c.title}" | out=${path.basename(c.outputPath)} | drive=${c.driveUrl ?? "not uploaded"}`,
      );
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
