import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { KeywordEntry, SubtitleSegment } from "opencut";
import { config } from "../config.js";
import { probeMedia, type MediaProbeInfo } from "./transcribe.js";

export type RenderBackend = "ffmpeg" | "remotion";

function formatAssTime(sec: number): string {
  const safe = Math.max(0, sec);
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const cs = Math.min(99, Math.round((safe - Math.floor(safe)) * 100));
  return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(
    2,
    "0",
  )}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, " ");
}

function wrapTitleLines(title: string, maxCharsPerLine = 26): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (current && (current + " " + w).length > maxCharsPerLine) {
      lines.push(current);
      current = w;
    } else {
      current = current ? `${current} ${w}` : w;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2).join("\\N");
}

export function generateAssSubtitles(opts: {
  outAssPath: string;
  title: string;
  gameName: string;
  durationSec: number;
  subtitles: SubtitleSegment[];
  keywords: KeywordEntry[];
}): string {
  const totalEnd = formatAssTime(Math.max(1, opts.durationSec));
  const safeTitle = wrapTitleLines(escapeAssText(opts.title.toUpperCase()));
  const safeBadge = escapeAssText(`LIVE  •  KAI CENAT  •  ${opts.gameName.toUpperCase()}`);

  const lines: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Caption,Arial Black,64,&H00FFFFFF,&H006AE5FF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,6,3,2,60,60,90,1",
    "Style: HookTitle,Arial Black,48,&H00FFFFFF,&H006AE5FF,&H00120816,&HAA0A0A14,-1,0,0,0,100,100,0.5,0,3,14,0,8,50,50,565,1",
    "Style: LiveBadge,Arial Black,28,&H00FFFFFF,&H00FFFFFF,&H00852AFF,&HCC0A0A14,-1,0,0,0,100,100,1,0,3,12,0,7,40,40,36,1",
    "Style: KeywordPop,Arial Black,76,&H00FFE500,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,7,4,8,60,60,720,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 2,0:00:00.00,${totalEnd},LiveBadge,,0,0,0,,{\\c&H00852AFF&}● {\\c&H00FFFFFF&}${safeBadge}`,
    `Dialogue: 2,0:00:00.00,${totalEnd},HookTitle,,0,0,0,,${safeTitle}`,
  ];

  for (const kw of opts.keywords) {
    const start = formatAssTime(kw.startSec);
    const end = formatAssTime(Math.min(opts.durationSec, kw.endSec));
    if (kw.endSec <= kw.startSec) continue;
    lines.push(
      `Dialogue: 3,${start},${end},KeywordPop,,0,0,0,,{\\fad(120,150)}${escapeAssText(kw.text)}`,
    );
  }

  for (const seg of opts.subtitles) {
    if (!seg.words.length) continue;
    for (let i = 0; i < seg.words.length; i++) {
      const w = seg.words[i]!;
      const next = seg.words[i + 1];
      const startSec = Math.max(0, w.start);
      const endSec = next
        ? Math.max(startSec + 0.05, next.start)
        : Math.max(startSec + 0.12, seg.end);
      const text = seg.words
        .map((wordObj, idx) => {
          const clean = escapeAssText(wordObj.word.toUpperCase());
          if (idx === i) {
            return `{\\c&H006AE5FF&\\fscx110\\fscy110}${clean}{\\c&H00FFFFFF&\\fscx100\\fscy100}`;
          }
          return clean;
        })
        .join(" ");

      lines.push(
        `Dialogue: 4,${formatAssTime(startSec)},${formatAssTime(endSec)},Caption,,0,0,0,,${text}`,
      );
    }
  }

  fs.mkdirSync(path.dirname(opts.outAssPath), { recursive: true });
  fs.writeFileSync(opts.outAssPath, lines.join("\n"), "utf8");
  return opts.outAssPath;
}

async function renderWithRemotion(opts: {
  slug: string;
  title: string;
  gameName: string;
  rawVideoPath: string;
  outputPath: string;
  durationSec: number;
  subtitles: SubtitleSegment[];
  keywords: KeywordEntry[];
}): Promise<void> {
  const { bundle } = await import("@remotion/bundler");
  const { renderMedia, selectComposition } = await import("@remotion/renderer");

  const entry = path.join(config.projectRoot, "src", "video", "index.ts");
  const publicDir = path.join(config.projectRoot, "public");
  const facecamAsset = path
    .relative(publicDir, opts.rawVideoPath)
    .replace(/\\/g, "/");

  const inputProps = {
    title: opts.title,
    gameName: opts.gameName,
    facecamAsset,
    subtitles: opts.subtitles,
    keywords: opts.keywords,
    durationSec: opts.durationSec,
    playbackRate: config.video.playbackRate,
    facecamCrop: config.video.facecamCrop,
  };

  console.log(`[render:remotion] Bundling OpenCut composition for ${opts.slug}...`);
  const bundled = await bundle({
    entryPoint: entry,
    publicDir,
  });

  const composition = await selectComposition({
    serveUrl: bundled,
    id: "KaiGta6Vertical",
    inputProps,
  });

  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: "h264",
    outputLocation: opts.outputPath,
    inputProps,
  });
}

function renderWithFfmpeg(opts: {
  slug: string;
  title: string;
  gameName: string;
  rawVideoPath: string;
  outputPath: string;
  durationSec: number;
  subtitles: SubtitleSegment[];
  keywords: KeywordEntry[];
  hasAudio: boolean;
}): void {
  const assPath = path.join(config.projectsDir, opts.slug, "captions.ass");
  generateAssSubtitles({
    outAssPath: assPath,
    title: opts.title,
    gameName: opts.gameName,
    durationSec: opts.durationSec,
    subtitles: opts.subtitles,
    keywords: opts.keywords,
  });

  // Relative forward-slash path from projectRoot avoids Windows C:\ colon filter escaping issues
  const relAssPath = path
    .relative(config.projectRoot, assPath)
    .replace(/\\/g, "/");

  const { xRatio, yRatio, wRatio, hRatio } = config.video.facecamCrop;
  const topH = config.video.topHeight;
  const botH = config.video.bottomHeight;
  const outW = config.video.width;

  const filterComplex = [
    `[0:v]crop=iw*${wRatio}:ih*${hRatio}:iw*${xRatio}:ih*${yRatio},scale=${outW}:${topH}:force_original_aspect_ratio=increase,crop=${outW}:${topH},setsar=1[top]`,
    `[0:v]scale=${outW}:${botH}:force_original_aspect_ratio=increase,crop=${outW}:${botH},setsar=1[bot]`,
    `[top][bot]vstack=inputs=2,drawbox=x=0:y=${topH - 4}:w=${outW}:h=8:color=#ff2a85@1:t=fill,drawbox=x=0:y=${topH - 6}:w=${outW}:h=2:color=#00e5ff@0.85:t=fill,ass=${relAssPath}[vout]`,
  ].join(";");

  const args: string[] = ["-y", "-i", opts.rawVideoPath];
  if (!opts.hasAudio) {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }

  args.push(
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    "-map",
    opts.hasAudio ? "0:a" : "1:a",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(config.video.fps),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
  );

  if (!opts.hasAudio) {
    args.push("-shortest");
  }

  args.push(opts.outputPath);

  console.log(`[render:ffmpeg] Rendering 1080x1920 OpenCut vertical edit for ${opts.slug}...`);
  execFileSync(config.binaries.ffmpeg, args, {
    cwd: config.projectRoot,
    stdio: "pipe",
    maxBuffer: 25 * 1024 * 1024,
  });
}

export async function renderVerticalClip(opts: {
  slug: string;
  title: string;
  gameName: string;
  rawVideoPath: string;
  outputPath: string;
  subtitles: SubtitleSegment[];
  keywords: KeywordEntry[];
  mode?: RenderBackend;
}): Promise<MediaProbeInfo> {
  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
  const inputProbe = probeMedia(opts.rawVideoPath);
  const durationSec = inputProbe.durationSec || 25;
  const mode = opts.mode ?? "ffmpeg";

  if (mode === "remotion") {
    await renderWithRemotion({
      slug: opts.slug,
      title: opts.title,
      gameName: opts.gameName,
      rawVideoPath: opts.rawVideoPath,
      outputPath: opts.outputPath,
      durationSec,
      subtitles: opts.subtitles,
      keywords: opts.keywords,
    });
  } else {
    renderWithFfmpeg({
      slug: opts.slug,
      title: opts.title,
      gameName: opts.gameName,
      rawVideoPath: opts.rawVideoPath,
      outputPath: opts.outputPath,
      durationSec,
      subtitles: opts.subtitles,
      keywords: opts.keywords,
      hasAudio: inputProbe.hasAudio,
    });
  }

  const outProbe = probeMedia(opts.outputPath);
  if (
    outProbe.durationSec <= 0 ||
    outProbe.width !== config.video.width ||
    outProbe.height !== config.video.height ||
    outProbe.videoCodec !== "h264" ||
    !outProbe.hasAudio
  ) {
    throw new Error(
      `Rendered video verification failed for ${opts.outputPath}: ${JSON.stringify(outProbe)}`,
    );
  }

  console.log(
    `[render] Verified ${path.basename(opts.outputPath)}: ${outProbe.width}x${outProbe.height} ${outProbe.videoCodec}, ${outProbe.durationSec.toFixed(1)}s, audio=${outProbe.audioCodec}`,
  );
  return outProbe;
}
