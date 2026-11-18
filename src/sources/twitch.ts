import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDirectories } from "../config.js";
import { probeMedia, transcribeMedia } from "../editor/transcribe.js";

const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";

export interface StreamStatus {
  isLive: boolean;
  channelLogin: string;
  displayName: string;
  streamId?: string;
  title?: string;
  viewersCount?: number;
  createdAt?: string;
  gameName?: string;
  isGta6: boolean;
}

export interface ClipCandidate {
  id: string;
  slug: string;
  title: string;
  viewCount: number;
  createdAt: string;
  durationSeconds: number;
  url: string;
  gameName: string;
  sourceType: "twitch-clip" | "live-stream";
  rawPath: string;
  hypeScore?: number;
  transcript?: string;
}

interface GqlClipNode {
  id: string;
  slug: string;
  title: string;
  viewCount: number;
  createdAt: string;
  durationSeconds: number;
  url: string;
  game?: { name?: string | null } | null;
}

async function twitchGql<T>(query: string): Promise<T> {
  const res = await fetch(TWITCH_GQL_URL, {
    method: "POST",
    headers: {
      "Client-ID": config.streamer.twitchClientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`Twitch GQL HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length && !json.data) {
    throw new Error(`Twitch GQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) {
    throw new Error("Twitch GQL returned empty data");
  }
  return json.data;
}

export function isGta6Related(gameName?: string | null, title?: string | null): boolean {
  const g = (gameName ?? "").toLowerCase();
  const t = (title ?? "").toLowerCase();
  if (g === "grand theft auto vi" || g.includes("gta vi") || g.includes("gta 6")) {
    return true;
  }
  if (/gta\s*(6|vi)\b|grand theft auto\s*(6|vi)/i.test(t)) {
    return true;
  }
  return false;
}

export async function getChannelStatus(
  channelLogin = config.streamer.channelLogin,
): Promise<StreamStatus> {
  const query = `{
    user(login: ${JSON.stringify(channelLogin)}) {
      id
      displayName
      stream {
        id
        title
        type
        viewersCount
        createdAt
        game { name }
      }
    }
  }`;

  const data = await twitchGql<{
    user: {
      id: string;
      displayName: string;
      stream: {
        id: string;
        title: string;
        type: string;
        viewersCount: number;
        createdAt: string;
        game?: { name?: string | null } | null;
      } | null;
    } | null;
  }>(query);

  const user = data.user;
  if (!user || !user.stream) {
    return {
      isLive: false,
      channelLogin,
      displayName: user?.displayName ?? channelLogin,
      isGta6: false,
    };
  }

  const gameName = user.stream.game?.name ?? undefined;
  return {
    isLive: true,
    channelLogin,
    displayName: user.displayName,
    streamId: user.stream.id,
    title: user.stream.title,
    viewersCount: user.stream.viewersCount,
    createdAt: user.stream.createdAt,
    gameName,
    isGta6: isGta6Related(gameName, user.stream.title),
  };
}

export function extractClipSlug(urlOrSlug: string): string {
  const trimmed = urlOrSlug.trim();
  const match = trimmed.match(/\/clip\/([A-Za-z0-9_-]+)/) ?? trimmed.match(/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/);
  if (match?.[1]) return match[1];
  return trimmed.replace(/[^A-Za-z0-9_-]/g, "");
}

export async function downloadTwitchClipMp4(
  slug: string,
  destPath: string,
): Promise<{
  id: string;
  slug: string;
  title: string;
  durationSeconds: number;
  viewCount: number;
  createdAt: string;
  url: string;
  gameName: string;
}> {
  const query = `{
    clip(slug: ${JSON.stringify(slug)}) {
      id
      slug
      title
      viewCount
      createdAt
      durationSeconds
      url
      game { name }
      playbackAccessToken(params: { platform: "web", playerBackend: "mediaplayer", playerType: "site" }) {
        signature
        value
      }
      videoQualities {
        frameRate
        quality
        sourceURL
      }
    }
  }`;

  const data = await twitchGql<{
    clip: {
      id: string;
      slug: string;
      title: string;
      viewCount: number;
      createdAt: string;
      durationSeconds: number;
      url: string;
      game?: { name?: string | null } | null;
      playbackAccessToken: { signature: string; value: string } | null;
      videoQualities: Array<{ frameRate: number; quality: string; sourceURL: string }>;
    } | null;
  }>(query);

  const clip = data.clip;
  if (!clip || !clip.playbackAccessToken || !clip.videoQualities.length) {
    throw new Error(`Clip '${slug}' unavailable or missing playback qualities`);
  }

  const sortedQualities = [...clip.videoQualities].sort(
    (a, b) => Number(b.quality) - Number(a.quality),
  );
  const chosen = sortedQualities[0]!;
  const mp4Url = `${chosen.sourceURL}?sig=${encodeURIComponent(
    clip.playbackAccessToken.signature,
  )}&token=${encodeURIComponent(clip.playbackAccessToken.value)}`;

  const res = await fetch(mp4Url);
  if (!res.ok) {
    throw new Error(`Failed downloading clip MP4 (${res.status}) for ${slug}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);

  return {
    id: clip.id,
    slug: clip.slug,
    title: clip.title,
    durationSeconds: clip.durationSeconds,
    viewCount: clip.viewCount,
    createdAt: clip.createdAt,
    url: clip.url,
    gameName: clip.game?.name ?? "Grand Theft Auto VI",
  };
}

export async function fetchViralGta6Clips(opts: {
  limit: number;
  period?: "LAST_DAY" | "LAST_WEEK";
  excludeSlugs?: Set<string>;
}): Promise<ClipCandidate[]> {
  ensureDirectories();
  const period = opts.period ?? "LAST_WEEK";
  const channelLogin = config.streamer.channelLogin;
  const exclude = opts.excludeSlugs ?? new Set<string>();

  const query = `{
    user(login: ${JSON.stringify(channelLogin)}) {
      clips(first: 25, criteria: { period: ${period} }) {
        edges {
          node {
            id
            slug
            title
            viewCount
            createdAt
            durationSeconds
            url
            game { name }
          }
        }
      }
    }
  }`;

  const data = await twitchGql<{
    user: {
      clips: {
        edges: Array<{ node: GqlClipNode }>;
      };
    } | null;
  }>(query);

  const edges = data.user?.clips?.edges ?? [];
  const nowMs = Date.now();

  const gtaClips = edges
    .map((e) => e.node)
    .filter((node) => !exclude.has(node.slug))
    .filter((node) => isGta6Related(node.game?.name, node.title))
    .map((node) => {
      const ageHours = Math.max(1, (nowMs - new Date(node.createdAt).getTime()) / 3600000);
      const isExactGta6Game =
        (node.game?.name ?? "").toLowerCase() === "grand theft auto vi" ? 1.5 : 1.0;
      const viralScore = (Math.log10(Math.max(10, node.viewCount)) * 30 * isExactGta6Game) / Math.pow(ageHours, 0.25);
      return { node, viralScore };
    })
    .sort((a, b) => b.viralScore - a.viralScore);

  const results: ClipCandidate[] = [];
  for (const { node } of gtaClips) {
    if (results.length >= opts.limit) break;
    const rawPath = path.join(config.rawDir, `${node.slug}.mp4`);
    try {
      const info = await downloadTwitchClipMp4(node.slug, rawPath);
      results.push({
        id: info.id,
        slug: info.slug,
        title: info.title,
        viewCount: info.viewCount,
        createdAt: info.createdAt,
        durationSeconds: info.durationSeconds,
        url: info.url,
        gameName: info.gameName,
        sourceType: "twitch-clip",
        rawPath,
      });
    } catch (err) {
      console.warn(`[twitch] Skipping clip ${node.slug}: ${String(err)}`);
    }
  }

  return results;
}

function parseHlsVariantUrl(masterPlaylist: string): string | null {
  const lines = masterPlaylist.split(/\r?\n/).map((l) => l.trim());
  const candidates: Array<{ quality: string; url: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const next = lines[i + 1];
      if (next && next.startsWith("http")) {
        const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
        const quality = resMatch?.[1] ?? "unknown";
        candidates.push({ quality, url: next });
      }
    }
  }

  const p1080 = candidates.find((c) => c.quality === "1920x1080");
  if (p1080) return p1080.url;
  const p720 = candidates.find((c) => c.quality === "1280x720");
  if (p720) return p720.url;
  return candidates[0]?.url ?? lines.find((l) => l.startsWith("http")) ?? null;
}

export function measureAudioDb(mediaPath: string): {
  meanVolumeDb: number;
  maxVolumeDb: number;
} {
  const proc = spawnSync(
    config.binaries.ffmpeg,
    ["-hide_banner", "-i", mediaPath, "-af", "volumedetect", "-f", "null", "NUL"],
    { encoding: "utf8" },
  );
  const combined = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
  const meanMatch = combined.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  const maxMatch = combined.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  return {
    meanVolumeDb: meanMatch ? Number(meanMatch[1]) : -25,
    maxVolumeDb: maxMatch ? Number(maxMatch[1]) : -8,
  };
}

const HYPE_KEYWORDS = [
  "no way",
  "bro",
  "wtf",
  "oh my god",
  "chat",
  "crazy",
  "police",
  "wasted",
  "vice city",
  "gta",
  "shoot",
  "yo",
  "insane",
  "clip",
  "what",
  "damn",
  "fire",
  "let's go",
];

export function scoreHypeMoment(opts: {
  meanVolumeDb: number;
  maxVolumeDb: number;
  transcript: string;
  wordCount: number;
  durationSec: number;
}): { score: number; matchedKeywords: string[] } {
  const lower = opts.transcript.toLowerCase();
  const matchedKeywords = HYPE_KEYWORDS.filter((kw) => lower.includes(kw));

  // Audio score (0..45)
  const maxScore = Math.max(0, Math.min(25, (opts.maxVolumeDb + 20) * 1.3));
  const meanScore = Math.max(0, Math.min(20, (opts.meanVolumeDb + 35) * 1.0));

  // Speech pace score (0..25)
  const wordsPerSec = opts.durationSec > 0 ? opts.wordCount / opts.durationSec : 0;
  const paceScore = Math.max(0, Math.min(25, wordsPerSec * 8));

  // Keyword hype score (0..30)
  const kwScore = Math.min(30, matchedKeywords.length * 8);

  const total = Math.round(Math.min(100, maxScore + meanScore + paceScore + kwScore));
  return { score: total, matchedKeywords };
}

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface LoudnessPoint {
  time: number;
  rms: number;
  peak: number;
}

export interface MinedClipWindow {
  startSec: number;
  endSec: number;
  score: number;
  matchedKeywords: string[];
  transcript: string;
  wordCount: number;
}

export const MINED_CLIP_SEC = 40;
export const MINED_CLIP_STEP_SEC = 10;
export const MINED_CLIP_MAX = 3;
const MINE_RECORDING_SEC = 90;

function finiteDb(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : -60;
}

export function parseLoudnessTimeline(text: string): LoudnessPoint[] {
  const points: LoudnessPoint[] = [];
  let time = 0;
  let rms: number | null = null;
  let peak: number | null = null;
  const flush = () => {
    if (rms == null && peak == null) return;
    points.push({
      time,
      rms: rms ?? peak ?? -40,
      peak: peak ?? rms ?? -40,
    });
    rms = null;
    peak = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const timeMatch = line.match(/pts_time:([0-9.]+)/);
    if (timeMatch) {
      flush();
      time = Number(timeMatch[1]);
      continue;
    }
    const rmsMatch = line.match(/Overall\.RMS_level=(-?[\d.]+|inf|-inf)/i);
    if (rmsMatch) {
      rms = finiteDb(rmsMatch[1]);
      continue;
    }
    const peakMatch = line.match(/Overall\.Peak_level=(-?[\d.]+|inf|-inf)/i);
    if (peakMatch) peak = finiteDb(peakMatch[1]);
  }
  flush();
  return points;
}

export function volumeInWindow(
  points: LoudnessPoint[],
  startSec: number,
  endSec: number,
): { meanVolumeDb: number; maxVolumeDb: number } {
  const slice = points.filter((point) => point.time >= startSec && point.time < endSec);
  if (!slice.length) return { meanVolumeDb: -25, maxVolumeDb: -8 };
  const meanVolumeDb = slice.reduce((sum, point) => sum + point.rms, 0) / slice.length;
  const maxVolumeDb = Math.max(...slice.map((point) => point.peak));
  return { meanVolumeDb, maxVolumeDb };
}

export function pickMinedClips(opts: {
  words: TimedWord[];
  durationSec: number;
  minHypeScore: number;
  maxClips?: number;
  clipSec?: number;
  stepSec?: number;
  forceKeep?: boolean;
  volumeForWindow?: (startSec: number, endSec: number) => { meanVolumeDb: number; maxVolumeDb: number };
}): MinedClipWindow[] {
  const clipSec = opts.clipSec ?? MINED_CLIP_SEC;
  const stepSec = opts.stepSec ?? MINED_CLIP_STEP_SEC;
  const maxClips = opts.maxClips ?? MINED_CLIP_MAX;
  const durationSec = Math.max(0, opts.durationSec);
  const volumeForWindow =
    opts.volumeForWindow ?? (() => ({ meanVolumeDb: -22, maxVolumeDb: -6 }));

  const starts: number[] = [];
  if (durationSec <= clipSec + 1) {
    starts.push(0);
  } else {
    for (let start = 0; start + 12 <= durationSec; start += stepSec) {
      starts.push(Number(start.toFixed(3)));
      if (start + clipSec >= durationSec) break;
    }
    const tail = Number(Math.max(0, durationSec - clipSec).toFixed(3));
    const last = starts[starts.length - 1];
    if (last == null || tail - last > stepSec * 0.5) starts.push(tail);
  }

  const ranked: MinedClipWindow[] = [];
  for (const startSec of starts) {
    const endSec = Number(Math.min(durationSec, startSec + clipSec).toFixed(3));
    const span = endSec - startSec;
    if (span < 12) continue;
    const slice = opts.words.filter((word) => word.start >= startSec && word.start < endSec);
    const transcript = slice.map((word) => word.word).join(" ");
    if (/commercial break/i.test(transcript)) continue;
    const volume = volumeForWindow(startSec, endSec);
    const { score, matchedKeywords } = scoreHypeMoment({
      meanVolumeDb: volume.meanVolumeDb,
      maxVolumeDb: volume.maxVolumeDb,
      transcript,
      wordCount: slice.length,
      durationSec: span,
    });
    ranked.push({ startSec, endSec, score, matchedKeywords, transcript, wordCount: slice.length });
  }

  const pool = opts.forceKeep ? ranked : ranked.filter((window) => window.score >= opts.minHypeScore);
  const sorted = [...pool].sort((a, b) => b.score - a.score || a.startSec - b.startSec);
  const picked: MinedClipWindow[] = [];
  for (const window of sorted) {
    if (picked.length >= maxClips) break;
    const overlaps = picked.some(
      (kept) => window.startSec < kept.endSec - 1 && window.endSec > kept.startSec + 1,
    );
    if (!overlaps) picked.push(window);
  }
  return picked.sort((a, b) => a.startSec - b.startSec);
}

function measureLoudnessTimeline(mediaPath: string, workDir: string): LoudnessPoint[] {
  fs.mkdirSync(workDir, { recursive: true });
  const statsPath = path.join(workDir, "loudness.txt");
  fs.rmSync(statsPath, { force: true });
  try {
    execFileSync(
      config.binaries.ffmpeg,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        mediaPath,
        "-vn",
        "-af",
        "aresample=1000,astats=reset=1000:metadata=1,ametadata=print:file=loudness.txt",
        "-f",
        "null",
        "NUL",
      ],
      { cwd: workDir, stdio: "pipe", maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {
    return [];
  }
  if (!fs.existsSync(statsPath)) return [];
  return parseLoudnessTimeline(fs.readFileSync(statsPath, "utf8"));
}

function cutLiveClip(sourcePath: string, destPath: string, startSec: number, durationSec: number): void {
  execFileSync(
    config.binaries.ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      startSec.toFixed(3),
      "-i",
      sourcePath,
      "-t",
      durationSec.toFixed(3),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      destPath,
    ],
    { stdio: "pipe", maxBuffer: 10 * 1024 * 1024 },
  );
}

function deleteRecording(rawPath: string, projectDir: string): void {
  fs.rmSync(rawPath, { force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
}

function buildLiveTitle(transcript: string, streamTitle?: string): string {
  const clean = transcript.replace(/\s+/g, " ").trim();
  if (clean.length >= 12) {
    const snippet = clean.split(" ").slice(0, 8).join(" ");
    return `KAI LIVE GTA 6: ${snippet.toUpperCase()}`;
  }
  return streamTitle ? `KAI LIVE: ${streamTitle}` : "KAI CENAT GTA 6 LIVE MOMENT";
}

export async function captureAndScoreLiveSegment(opts?: {
  durationSec?: number;
  minHypeScore?: number;
  forceKeep?: boolean;
}): Promise<ClipCandidate[]> {
  ensureDirectories();
  const durationSec = opts?.durationSec ?? 600;
  const minHypeScore = opts?.minHypeScore ?? 45;
  const forceKeep = opts?.forceKeep ?? false;

  const status = await getChannelStatus(config.streamer.channelLogin);
  if (!status.isLive) {
    console.log(`[live] ${config.streamer.channelLogin} is currently offline.`);
    return [];
  }

  const query = `{
    streamPlaybackAccessToken(channelName: ${JSON.stringify(
      config.streamer.channelLogin,
    )}, params: { platform: "web", playerBackend: "mediaplayer", playerType: "site" }) {
      value
      signature
    }
  }`;

  const tokenData = await twitchGql<{
    streamPlaybackAccessToken: { value: string; signature: string } | null;
  }>(query);

  const tok = tokenData.streamPlaybackAccessToken;
  if (!tok) {
    throw new Error("Could not obtain streamPlaybackAccessToken for live stream");
  }

  const masterUrl =
    `https://usher.ttvnw.net/api/channel/hls/${config.streamer.channelLogin}.m3u8` +
    `?client_id=${config.streamer.twitchClientId}` +
    `&token=${encodeURIComponent(tok.value)}` +
    `&sig=${encodeURIComponent(tok.signature)}` +
    `&allow_source=true&allow_audio_only=true`;

  const masterRes = await fetch(masterUrl);
  if (!masterRes.ok) {
    throw new Error(`Failed fetching live HLS playlist: HTTP ${masterRes.status}`);
  }
  const masterText = await masterRes.text();
  const variantUrl = parseHlsVariantUrl(masterText);
  if (!variantUrl) {
    throw new Error("No playable HLS variant stream found in master playlist");
  }

  const tsStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = `LiveGta6-${tsStamp}`;
  const rawPath = path.join(config.rawDir, `${slug}.mp4`);
  const probeWorkDir = path.join(config.projectsDir, slug, "probe");

  console.log(`[live] Recording ${durationSec}s live segment (skipping 34s Twitch pre-roll) from ${status.displayName} (${status.gameName ?? "Live"})...`);
  execFileSync(
    config.binaries.ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      variantUrl,
      "-ss",
      "34",
      "-t",
      String(durationSec),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      rawPath,
    ],
    { stdio: "pipe", maxBuffer: 25 * 1024 * 1024 },
  );

  const recordedSec = probeMedia(rawPath).durationSec || durationSec;
  const projectDir = path.join(config.projectsDir, slug);
  const transcriptRes = transcribeMedia({
    mediaPath: rawPath,
    workDir: probeWorkDir,
    fallbackText: status.title ?? "KAI CENAT GTA VI LIVE",
    durationSec: recordedSec,
  });

  if (recordedSec < MINE_RECORDING_SEC) {
    if (/commercial break/i.test(transcriptRes.fullText)) {
      console.log(`[live] Segment was a Twitch commercial break; discarding.`);
      deleteRecording(rawPath, projectDir);
      return [];
    }

    const { meanVolumeDb, maxVolumeDb } = measureAudioDb(rawPath);
    const { score, matchedKeywords } = scoreHypeMoment({
      meanVolumeDb,
      maxVolumeDb,
      transcript: transcriptRes.fullText,
      wordCount: transcriptRes.words.length,
      durationSec: recordedSec,
    });

    console.log(
      `[live] Hype score=${score}/100 (max=${maxVolumeDb}dB, mean=${meanVolumeDb}dB, words=${transcriptRes.words.length}, kw=[${matchedKeywords.join(", ")}])`,
    );

    if (!forceKeep && score < minHypeScore) {
      console.log(`[live] Score ${score} below threshold ${minHypeScore}; discarding segment.`);
      deleteRecording(rawPath, projectDir);
      return [];
    }

    return [
      {
        id: status.streamId ?? slug,
        slug,
        title: buildLiveTitle(transcriptRes.fullText, status.title),
        viewCount: status.viewersCount ?? 0,
        createdAt: new Date().toISOString(),
        durationSeconds: recordedSec,
        url: `https://www.twitch.tv/${config.streamer.channelLogin}`,
        gameName: status.gameName ?? "Grand Theft Auto VI",
        sourceType: "live-stream",
        rawPath,
        hypeScore: score,
        transcript: transcriptRes.fullText,
      },
    ];
  }

  if (transcriptRes.usedFallback) {
    console.warn(`[live] No word timings for the ${recordedSec.toFixed(0)}s recording; deleting it without cutting clips.`);
    deleteRecording(rawPath, projectDir);
    return [];
  }

  const timeline = measureLoudnessTimeline(rawPath, probeWorkDir);
  const fallbackVolume = timeline.length > 0 ? null : measureAudioDb(rawPath);
  const windows = pickMinedClips({
    words: transcriptRes.words,
    durationSec: recordedSec,
    minHypeScore,
    forceKeep,
    volumeForWindow: (startSec, endSec) =>
      fallbackVolume ?? volumeInWindow(timeline, startSec, endSec),
  });

  if (windows.length === 0) {
    console.log(`[live] No viral windows in the ${recordedSec.toFixed(0)}s recording; deleting it.`);
    deleteRecording(rawPath, projectDir);
    return [];
  }

  console.log(
    `[live] Mined ${windows.length} clip(s) from ${recordedSec.toFixed(0)}s: ${windows
      .map((window) => `${window.startSec.toFixed(0)}-${window.endSec.toFixed(0)}s score=${window.score}`)
      .join(", ")}`,
  );

  const mined: ClipCandidate[] = [];
  for (const window of windows) {
    const clipSlug = `${slug}-t${Math.round(window.startSec)}`;
    const clipPath = path.join(config.rawDir, `${clipSlug}.mp4`);
    const span = Math.max(1, window.endSec - window.startSec);
    try {
      cutLiveClip(rawPath, clipPath, window.startSec, span);
      mined.push({
        id: `${status.streamId ?? slug}-${Math.round(window.startSec)}`,
        slug: clipSlug,
        title: buildLiveTitle(window.transcript, status.title),
        viewCount: status.viewersCount ?? 0,
        createdAt: new Date().toISOString(),
        durationSeconds: span,
        url: `https://www.twitch.tv/${config.streamer.channelLogin}`,
        gameName: status.gameName ?? "Grand Theft Auto VI",
        sourceType: "live-stream",
        rawPath: clipPath,
        hypeScore: window.score,
        transcript: window.transcript,
      });
    } catch (err) {
      console.warn(`[live] Failed cutting ${clipSlug}: ${String(err)}`);
      fs.rmSync(clipPath, { force: true });
    }
  }

  if (mined.length === 0) {
    console.warn(`[live] Cutting failed; keeping the ${recordedSec.toFixed(0)}s recording.`);
    return [];
  }

  deleteRecording(rawPath, projectDir);
  console.log(`[cleanup] Deleted the ${recordedSec.toFixed(0)}s source after cutting ${mined.length} clip(s).`);
  return mined;
}
