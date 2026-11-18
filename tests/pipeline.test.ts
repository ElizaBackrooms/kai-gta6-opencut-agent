import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDirectories } from "../src/config.js";
import { createOpenCutProject } from "../src/editor/opencutProject.js";
import { renderVerticalClip } from "../src/editor/render.js";
import {
  buildFallbackSegments,
  groupWordsIntoSubtitleSegments,
  probeMedia,
  transcribeMedia,
} from "../src/editor/transcribe.js";
import {
  extractClipSlug,
  isGta6Related,
  scoreHypeMoment,
} from "../src/sources/twitch.js";

async function runTests(): Promise<void> {
  ensureDirectories();
  const slug = "_test_kai_gta6_smoke";
  const rawPath = path.join(config.rawDir, `${slug}.mp4`);
  const projectDir = path.join(config.projectsDir, slug);
  const outPath = path.join(config.outDir, `${slug}.mp4`);

  try {
    // 1. Twitch helper unit checks
    assert.equal(
      extractClipSlug("https://www.twitch.tv/kaicenat/clip/SincereMoldyGaragePartyTime-C2fuK1XJ2UtVfHel"),
      "SincereMoldyGaragePartyTime-C2fuK1XJ2UtVfHel",
    );
    assert.equal(isGta6Related("Grand Theft Auto VI", "stream"), true);
    assert.equal(isGta6Related("Just Chatting", "playing GTA 6!"), true);
    assert.equal(isGta6Related("Minecraft", "building house"), false);

    const hype = scoreHypeMoment({
      meanVolumeDb: -14,
      maxVolumeDb: -1,
      transcript: "NO WAY BRO THIS IS CRAZY CHAT GTA VI IS INSANE",
      wordCount: 11,
      durationSec: 4,
    });
    assert.ok(hype.score >= 70, `Expected high hype score, got ${hype.score}`);

    // 2. Generate synthetic 3s 1280x720 video with audio
    execFileSync(
      config.binaries.ffmpeg,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=1280x720:rate=30:duration=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        rawPath,
      ],
      { stdio: "pipe" },
    );

    // 3. Transcribe (handles sparse/non-speech audio cleanly) + word grouping
    const transcription = transcribeMedia({
      mediaPath: rawPath,
      workDir: projectDir,
      fallbackText: "NO WAY BRO GTA VI IS LIVE",
      durationSec: 3,
    });
    assert.ok(transcription.words.length >= 1);
    assert.ok(transcription.segments.length >= 1);

    const fallback = buildFallbackSegments("NO WAY BRO GTA VI IS LIVE", 3);
    assert.ok(fallback.words.length >= 4);
    const grouped = groupWordsIntoSubtitleSegments(fallback.words, 3);
    assert.ok(grouped.length >= 2);

    // 4. OpenCut project generation & validation
    const built = createOpenCutProject({
      slug,
      title: "KAI CENAT CRAZY GTA 6 MOMENT",
      rawVideoPath: rawPath,
      durationSec: 3,
      subtitles: fallback.segments,
      words: fallback.words,
      gameName: "Grand Theft Auto VI",
    });
    assert.ok(fs.existsSync(built.projectJsonPath));
    assert.ok(fs.existsSync(built.subtitlesJsonPath));
    assert.ok(fs.existsSync(built.timelinePath));
    assert.equal(built.videoConfig.width, 1080);
    assert.equal(built.videoConfig.height, 1920);

    // 5. Render 1080x1920 vertical video via ffmpeg OpenCut compositor & verify with ffprobe
    const outProbe = await renderVerticalClip({
      slug,
      title: "KAI CENAT CRAZY GTA 6 MOMENT",
      gameName: "Grand Theft Auto VI",
      rawVideoPath: rawPath,
      outputPath: outPath,
      subtitles: fallback.segments,
      keywords: built.keywords,
      mode: "ffmpeg",
    });

    assert.equal(outProbe.width, 1080);
    assert.equal(outProbe.height, 1920);
    assert.equal(outProbe.videoCodec, "h264");
    assert.equal(outProbe.hasAudio, true);
    assert.ok(outProbe.durationSec >= 2.5);

    const directProbe = probeMedia(outPath);
    assert.equal(directProbe.width, 1080);

    console.log("ALL PIPELINE TESTS PASSED");
  } finally {
    fs.rmSync(rawPath, { force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(outPath, { force: true });
  }
}

runTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
