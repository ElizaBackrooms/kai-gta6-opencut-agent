import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import {
  AudioWaveform,
  BackgroundEffects,
  KeywordOverlay,
  SubtitleOverlay,
  type KeywordEntry,
  type SubtitleSegment,
} from "opencut";

export type KaiClipProps = {
  title: string;
  gameName: string;
  facecamAsset: string;
  subtitles: SubtitleSegment[];
  keywords: KeywordEntry[];
  durationSec: number;
  playbackRate: number;
  facecamCrop?: {
    xRatio: number;
    yRatio: number;
    wRatio: number;
    hRatio: number;
  };
};

export const KaiClipComposition: React.FC<KaiClipProps> = ({
  title,
  gameName,
  facecamAsset,
  subtitles,
  keywords,
  playbackRate,
  facecamCrop = { xRatio: 0.0, yRatio: 0.0, wRatio: 0.32, hRatio: 0.38 },
}) => {
  const videoSrc = facecamAsset.startsWith("http")
    ? facecamAsset
    : staticFile(facecamAsset);

  const topWidth = 1080;
  const topHeight = 680;
  const bottomHeight = 1240;

  // Scale a 16:9 source video so the facecam region fills the 1080x680 top container
  const scaledWidth = Math.round(topWidth / Math.max(0.15, facecamCrop.wRatio));
  const scaledHeight = Math.round((scaledWidth * 9) / 16);
  const offsetX = -Math.round(facecamCrop.xRatio * scaledWidth);
  const offsetY = -Math.round(facecamCrop.yRatio * scaledHeight);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#07070d",
        fontFamily: "Montserrat, Arial Black, sans-serif",
      }}
    >
      {/* Top 1080x680 Facecam Split */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: topWidth,
          height: topHeight,
          overflow: "hidden",
          backgroundColor: "#0d0d16",
        }}
      >
        <OffthreadVideo
          src={videoSrc}
          muted
          playbackRate={playbackRate}
          style={{
            position: "absolute",
            left: offsetX,
            top: offsetY,
            width: scaledWidth,
            height: scaledHeight,
            objectFit: "cover",
          }}
        />

        {/* Top gradient scrim for legibility */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, rgba(7,7,13,0.78) 0%, rgba(7,7,13,0.08) 38%, rgba(7,7,13,0.55) 100%)",
          }}
        />

        {/* LIVE • KAI CENAT • GTA VI Badge */}
        <div
          style={{
            position: "absolute",
            top: 34,
            left: 36,
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "rgba(10, 10, 18, 0.85)",
            border: "2px solid #ff2a85",
            borderRadius: 999,
            padding: "10px 22px",
            boxShadow: "0 0 22px rgba(255, 42, 133, 0.45)",
          }}
        >
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              backgroundColor: "#ff2a85",
            }}
          />
          <span
            style={{
              color: "#ffffff",
              fontSize: 24,
              fontWeight: 900,
              letterSpacing: 1.5,
            }}
          >
            LIVE • KAI CENAT • {gameName.toUpperCase()}
          </span>
        </div>

        {/* Hook Title Banner */}
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: 36,
            right: 36,
            textAlign: "center",
          }}
        >
          <div
            style={{
              display: "inline-block",
              background: "rgba(10, 10, 20, 0.82)",
              borderLeft: "6px solid #00e5ff",
              borderRight: "6px solid #ff2a85",
              padding: "12px 24px",
              borderRadius: 12,
              color: "#ffffff",
              fontSize: 36,
              fontWeight: 900,
              lineHeight: 1.15,
              textTransform: "uppercase",
              textShadow: "0 3px 10px rgba(0,0,0,0.85)",
            }}
          >
            {title}
          </div>
        </div>
      </div>

      {/* Neon Vice City Divider */}
      <div
        style={{
          position: "absolute",
          top: topHeight - 4,
          left: 0,
          width: topWidth,
          height: 8,
          background: "linear-gradient(90deg, #ff2a85 0%, #ffb84d 50%, #00e5ff 100%)",
          boxShadow: "0 0 20px rgba(255, 42, 133, 0.85)",
          zIndex: 10,
        }}
      />

      {/* Bottom 1080x1240 Gameplay Split */}
      <div
        style={{
          position: "absolute",
          top: topHeight,
          left: 0,
          width: topWidth,
          height: bottomHeight,
          overflow: "hidden",
          backgroundColor: "#05050a",
        }}
      >
        <OffthreadVideo
          src={videoSrc}
          playbackRate={playbackRate}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />

        <BackgroundEffects
          config={{
            type: "vignette",
            accentColor: "#ff2a85",
            intensity: 0.35,
          }}
        />

        <KeywordOverlay
          keywords={keywords}
          segmentRawStartSec={0}
          playbackRate={playbackRate}
          style={{
            color: "#00e5ff",
            fontSize: 64,
            topOffset: 48,
          }}
        />

        <AudioWaveform
          barCount={28}
          color="#ff2a85"
          height={44}
          position="bottom"
          intensity={0.85}
        />

        <SubtitleOverlay
          segments={subtitles}
          segmentRawStartSec={0}
          faceBubblePosition="hidden"
          playbackRate={playbackRate}
          style={{
            activeColor: "#ffe56a",
            inactiveColor: "#ffffff",
            fontSize: 64,
            bottomOffset: 150,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
