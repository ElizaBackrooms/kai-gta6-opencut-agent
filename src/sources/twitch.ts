import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDirectories } from "../config.js";
import { transcribeMedia } from "../editor/transcribe.js";

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

  const edges = data.user?.clips.edges ?? [];
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
}): Promise<ClipCandidate | null> {
  ensureDirectories();
  const durationSec = opts?.durationSec ?? 25;
  const minHypeScore = opts?.minHypeScore ?? 45;
  const forceKeep = opts?.forceKeep ?? false;

  const status = await getChannelStatus(config.streamer.channelLogin);
  if (!status.isLive) {
    console.log(`[live] ${config.streamer.channelLogin} is currently offline.`);
    return null;
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

  const { meanVolumeDb, maxVolumeDb } = measureAudioDb(rawPath);
  const transcriptRes = transcribeMedia({
    mediaPath: rawPath,
    workDir: probeWorkDir,
    fallbackText: status.title ?? "KAI CENAT GTA VI LIVE",
    durationSec,
  });

  if (/commercial break/i.test(transcriptRes.fullText)) {
    console.log(`[live] Segment was a Twitch commercial break; discarding.`);
    fs.rmSync(rawPath, { force: true });
    fs.rmSync(path.join(config.projectsDir, slug), { recursive: true, force: true });
    return null;
  }

  const { score, matchedKeywords } = scoreHypeMoment({
    meanVolumeDb,
    maxVolumeDb,
    transcript: transcriptRes.fullText,
    wordCount: transcriptRes.words.length,
    durationSec,
  });

  console.log(
    `[live] Hype score=${score}/100 (max=${maxVolumeDb}dB, mean=${meanVolumeDb}dB, words=${transcriptRes.words.length}, kw=[${matchedKeywords.join(", ")}])`,
  );

  if (!forceKeep && score < minHypeScore) {
    console.log(`[live] Score ${score} below threshold ${minHypeScore}; discarding segment.`);
    fs.rmSync(rawPath, { force: true });
    fs.rmSync(path.join(config.projectsDir, slug), { recursive: true, force: true });
    return null;
  }

  return {
    id: status.streamId ?? slug,
    slug,
    title: buildLiveTitle(transcriptRes.fullText, status.title),
    viewCount: status.viewersCount ?? 0,
    createdAt: new Date().toISOString(),
    durationSeconds: durationSec,
    url: `https://www.twitch.tv/${config.streamer.channelLogin}`,
    gameName: status.gameName ?? "Grand Theft Auto VI",
    sourceType: "live-stream",
    rawPath,
    hypeScore: score,
    transcript: transcriptRes.fullText,
  };
}
