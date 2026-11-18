import React from "react";
import { Composition } from "remotion";
import { KaiClipComposition, type KaiClipProps } from "./KaiClipComposition.js";

const DEFAULT_PROPS: KaiClipProps = {
  title: "KAI CENAT REACTS TO GTA 6",
  gameName: "Grand Theft Auto VI",
  facecamAsset: "",
  subtitles: [],
  keywords: [],
  durationSec: 30,
  playbackRate: 1.0,
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="KaiGta6Vertical"
      component={KaiClipComposition}
      durationInFrames={30 * 30}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={DEFAULT_PROPS}
      calculateMetadata={({ props }) => {
        const safeDur = Math.max(1, props.durationSec || 30);
        const rate = Math.max(0.5, props.playbackRate || 1.0);
        return {
          durationInFrames: Math.max(30, Math.round((safeDur / rate) * 30)),
          fps: 30,
          width: 1080,
          height: 1920,
        };
      }}
    />
  );
};
