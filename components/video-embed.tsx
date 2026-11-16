"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";
import { PROVIDER_NAMES, type Video, embedUrl } from "@/lib/sales-page";
import { blockWords } from "@/lib/buyer-words/blocks";

/**
 * A video that loads nothing until it is asked to.
 *
 * The page draws a still — the product's own picture, or the store's colours
 * — with a play button, and only when the visitor presses it does the
 * player's frame appear, from the one address lib/sales-page.ts builds for
 * that player. So a visitor who never presses play is never seen by YouTube,
 * Vimeo or Loom, and the page is as fast as if the video were not there.
 */
export function VideoEmbed({
  video,
  title,
  poster,
  inert = false,
  lang = "en",
}: {
  video: Video;
  title: string;
  /**
   * A picture of the store's own to show before play; none draws the colours. Its width and height go on the
   * element so the box is kept from the first paint (281 [SF1]; the CSS still draws it at the frame's 16:9).
   */
  poster: { src: string; alt: string; width: number; height: number } | null;
  /** In the studio's preview: drawn, never played. */
  inert?: boolean;
  /** The page's language, for the button and the frame's name (lib/buyer-words/blocks.ts). */
  lang?: string;
}) {
  const words = blockWords(lang);
  const [playing, setPlaying] = useState(false);
  const provider = PROVIDER_NAMES[video.provider];

  if (playing) {
    return (
      <div className="sp-video">
        <iframe
          src={embedUrl(video)}
          title={words.videoFrame(title, provider)}
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          loading="lazy"
        />
      </div>
    );
  }

  return (
    <div className="sp-video">
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster.src} alt="" width={poster.width} height={poster.height} className="sp-video-poster" />
      ) : (
        <span aria-hidden="true" className="sp-video-poster sp-video-colours" />
      )}
      <button
        type="button"
        className="sp-video-play"
        onClick={() => {
          if (!inert) setPlaying(true);
        }}
        aria-label={words.videoPlayLabel(title, provider)}
      >
        <span className="sp-video-disc" aria-hidden="true">
          <Icon name="play" size={26} strokeWidth={2} />
        </span>
        <span className="sp-video-note">{words.videoPlay(provider)}</span>
      </button>
    </div>
  );
}
