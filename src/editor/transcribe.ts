import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SubtitleSegment, Word } from "opencut";
import { config } from "../config.js";

export interface MediaProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec?: string;
}

export interface TranscriptionResult {
  words: Word[];
  segments: SubtitleSegment[];
  fullText: string;
  usedFallback: boolean;
}

interface WhisperTokenJson {
  text?: string;
  offsets?: { from?: number; to?: number };
}

interface WhisperItemJson {
  offsets?: { from?: number; to?: number };
  text?: string;
  tokens?: WhisperTokenJson[];
}

interface WhisperJsonOutput {
  transcription?: WhisperItemJson[];
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    words?: Array<{ word?: string; start?: number; end?: number }>;
  }>;
}

export function probeMedia(mediaPath: string): MediaProbeInfo {
  const stdout = execFileSync(
    config.binaries.ffprobe,
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      mediaPath,
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
    }>;
  };

  const vStream = parsed.streams?.find((s) => s.codec_type === "video");
  const aStream = parsed.streams?.find((s) => s.codec_type === "audio");
  const durationSec = Number(
    parsed.format?.duration ?? vStream?.duration ?? aStream?.duration ?? "0",
  );

  return {
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
    width: vStream?.width ?? 1920,
    height: vStream?.height ?? 1080,
    hasAudio: Boolean(aStream),
    videoCodec: vStream?.codec_name ?? "unknown",
    audioCodec: aStream?.codec_name,
  };
}

function isSpecialWhisperToken(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^\[_.*\]$/.test(t)) return true;
  if (/^\[.*\]$/.test(t)) return true;
  if (/^\(.*\)$/.test(t)) return true;
  return false;
}

function cleanWordText(raw: string): string {
  return raw
    .replace(/\[_[^\]]+\]/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/[^\w'’!?.,-]/g, "")
    .trim();
}

export function parseWhisperOutput(jsonPath: string): Word[] {
  if (!fs.existsSync(jsonPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as WhisperJsonOutput;
    const words: Word[] = [];

    if (data.segments?.length) {
      for (const seg of data.segments) {
        for (const w of seg.words ?? []) {
          const text = cleanWordText(w.word ?? "");
          if (!text || w.start == null || w.end == null) continue;
          const start = Number(w.start.toFixed(3));
          const end = Math.max(start + 0.08, Number(w.end.toFixed(3)));
          words.push({ word: text, start, end });
        }
      }
      if (words.length > 0) return words;
    }

    if (data.transcription?.length) {
      for (const item of data.transcription) {
        const rawText = item.text ?? "";
        if (isSpecialWhisperToken(rawText)) {
          // Still inspect tokens in case non-special tokens exist
          if (item.tokens?.length) {
            for (const tok of item.tokens) {
              const tRaw = tok.text ?? "";
              if (isSpecialWhisperToken(tRaw)) continue;
              const cleaned = cleanWordText(tRaw);
              if (!cleaned || tok.offsets?.from == null || tok.offsets?.to == null) continue;
              const startsNewWord = /^\s/.test(tRaw) || words.length === 0;
              const start = Number((tok.offsets.from / 1000).toFixed(3));
              const end = Math.max(start + 0.08, Number((tok.offsets.to / 1000).toFixed(3)));
              if (!startsNewWord && !/^['’.,!?-]/.test(cleaned) && words.length > 0) {
                const prev = words[words.length - 1]!;
                prev.word += cleaned;
                prev.end = Math.max(prev.end, end);
              } else {
                words.push({ word: cleaned, start, end });
              }
            }
          }
          continue;
        }

        const cleanedItem = cleanWordText(rawText);
        if (
          cleanedItem &&
          !cleanedItem.includes(" ") &&
          item.offsets?.from != null &&
          item.offsets?.to != null
        ) {
          const start = Number((item.offsets.from / 1000).toFixed(3));
          const end = Math.max(start + 0.08, Number((item.offsets.to / 1000).toFixed(3)));
          words.push({ word: cleanedItem, start, end });
          continue;
        }

        if (item.tokens?.length) {
          for (const tok of item.tokens) {
            const tRaw = tok.text ?? "";
            if (isSpecialWhisperToken(tRaw)) continue;
            const cleaned = cleanWordText(tRaw);
            if (!cleaned || tok.offsets?.from == null || tok.offsets?.to == null) continue;
            const startsNewWord = /^\s/.test(tRaw) || words.length === 0;
            const start = Number((tok.offsets.from / 1000).toFixed(3));
            const end = Math.max(start + 0.08, Number((tok.offsets.to / 1000).toFixed(3)));
            if (!startsNewWord && words.length > 0) {
              const prev = words[words.length - 1]!;
              prev.word += cleaned;
              prev.end = Math.max(prev.end, end);
            } else {
              words.push({ word: cleaned, start, end });
            }
          }
        }
      }
    }

    return words;
  } catch {
    return [];
  }
}

export function groupWordsIntoSubtitleSegments(
  words: Word[],
  maxWordsPerSegment = 5,
): SubtitleSegment[] {
  if (!words.length) return [];
  const segments: SubtitleSegment[] = [];
  let bucket: Word[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    bucket.push(w);
    const endsSentence = /[.?!]$/.test(w.word);
    const endsClause = /,$/.test(w.word) && bucket.length >= 3;
    const isLast = i === words.length - 1;

    if (isLast || endsSentence || endsClause || bucket.length >= maxWordsPerSegment) {
      const start = bucket[0]!.start;
      const end = Math.max(start + 0.15, bucket[bucket.length - 1]!.end);
      segments.push({
        start,
        end,
        text: bucket.map((item) => item.word).join(" "),
        words: bucket,
      });
      bucket = [];
    }
  }

  return segments;
}

export function buildFallbackSegments(
  fallbackText: string,
  durationSec: number,
): TranscriptionResult {
  const safeDur = Math.max(3, durationSec || 15);
  const rawWords = fallbackText
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
  const tokens = rawWords.length > 0 ? rawWords : ["KAI", "CENAT", "GTA", "6", "LIVE"];
  const span = Math.min(safeDur * 0.7, tokens.length * 0.45);
  const slot = span / tokens.length;
  const words: Word[] = tokens.map((word, idx) => ({
    word: word.toUpperCase(),
    start: Number((0.4 + idx * slot).toFixed(3)),
    end: Number((0.4 + (idx + 1) * slot).toFixed(3)),
  }));
  return {
    words,
    segments: groupWordsIntoSubtitleSegments(words, 4),
    fullText: words.map((w) => w.word).join(" "),
    usedFallback: true,
  };
}

export function transcribeMedia(opts: {
  mediaPath: string;
  workDir: string;
  fallbackText?: string;
  durationSec?: number;
}): TranscriptionResult {
  const workDir = path.resolve(opts.workDir);
  const mediaPath = path.resolve(opts.mediaPath);
  fs.mkdirSync(workDir, { recursive: true });
  const wavPath = path.join(workDir, "audio16k.wav");
  const outBase = path.join(workDir, "transcript");

  const probe = probeMedia(mediaPath);
  const durationSec = opts.durationSec ?? probe.durationSec;

  if (!probe.hasAudio) {
    return buildFallbackSegments(opts.fallbackText ?? "KAI CENAT GTA VI", durationSec);
  }

  try {
    execFileSync(
      config.binaries.ffmpeg,
      [
        "-y",
        "-i",
        mediaPath,
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        wavPath,
      ],
      { stdio: "pipe", maxBuffer: 20 * 1024 * 1024 },
    );
  } catch {
    return buildFallbackSegments(opts.fallbackText ?? "KAI CENAT GTA VI", durationSec);
  }

  if (
    !config.binaries.whisperBin ||
    !fs.existsSync(config.binaries.whisperBin) ||
    !config.binaries.whisperModel ||
    !fs.existsSync(config.binaries.whisperModel)
  ) {
    return buildFallbackSegments(opts.fallbackText ?? "KAI CENAT GTA VI", durationSec);
  }

  try {
    execFileSync(
      config.binaries.whisperBin,
      [
        "-m",
        config.binaries.whisperModel,
        "-f",
        wavPath,
        "-l",
        "en",
        "-ojf",
        "-of",
        outBase,
        "-ml",
        "1",
        "-sow",
        "-np",
        "-ng",
      ],
      {
        cwd: path.dirname(config.binaries.whisperBin),
        stdio: "pipe",
        maxBuffer: 20 * 1024 * 1024,
      },
    );
  } catch {
    return buildFallbackSegments(opts.fallbackText ?? "KAI CENAT GTA VI", durationSec);
  }

  const words = parseWhisperOutput(`${outBase}.json`);
  if (!words.length) {
    return buildFallbackSegments(opts.fallbackText ?? "KAI CENAT GTA VI", durationSec);
  }

  return {
    words,
    segments: groupWordsIntoSubtitleSegments(words, 5),
    fullText: words.map((w) => w.word).join(" "),
    usedFallback: false,
  };
}
