"use client";

import { useEffect, useRef, useState } from "react";
import { READ_SAMPLE } from "@/lib/page-read-sample";
import { framePlayer, frameTarget, messagePlayer } from "@/lib/player-origin";
import { WHY_NOT, type WhyNot } from "@/lib/why-not-rules";
import type { WhyNotWords } from "@/lib/buyer-words/why-not";

/** Sends a page's reading to /api/store/read, by beacon where the browser has one. */
export function sendRead(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  try {
    if (navigator.sendBeacon?.("/api/store/read", new Blob([body], { type: "text/plain" }))) return;
  } catch {}
  fetch("/api/store/read", { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
}

/** Seconds on the page, with the buy box seen, before a visitor not buying is asked what stops them. */
const ASK_AFTER_SECONDS = 25;
const askedKey = (product: string) => `nl_whynot:${product}`;

/** How far into a video somebody got: played, a quarter, half, three quarters, the end. */
function quartile(percent: number): string {
  return percent >= 0.95 ? "100" : percent >= 0.75 ? "75" : percent >= 0.5 ? "50" : percent >= 0.25 ? "25" : "p";
}

/**
 * Which player a message came from, by its exact origin: the page's videos
 * are framed from these (embedUrl, VIDEO_FRAME_ORIGINS in lib/sales-page.ts).
 * Any other origin, "https://evilyoutube.example" among them, is no player.
 */
export function playerOfOrigin(origin: string): "youtube" | "vimeo" | null {
  if (origin === "https://www.youtube-nocookie.com" || origin === "https://www.youtube.com") return "youtube";
  if (origin === "https://player.vimeo.com") return "vimeo";
  return null;
}

/**
 * How a sales page was read, for one visitor in READ_SAMPLE, chosen here at
 * random, so the measure stays inside what a visit costs (lib/page-read.ts):
 * sent once, when they leave the page or switch away from it, as one count.
 *
 *   - the furthest block they saw (lib/page-depth.ts);
 *   - how far into the page's video they got, if they pressed play: the
 *     players of YouTube and Vimeo say where they are, Loom's only that it
 *     was played (added 11 October 2026);
 *   - where the creator turned it on and the visitor has seen the buy box,
 *     stayed a while and not started to pay: what stops them, if they tap an
 *     answer (`ask`). Asked once per product on a device, and only of the
 *     visitors measured, so at most one in eight is ever asked.
 *
 * No cookie, nothing about the visitor.
 */
export function PageDepth({ token, product, ask = null }: { token: string; product: string; ask?: WhyNotWords | null }) {
  const [asking, setAsking] = useState<"no" | "yes" | "done">("no");
  const answer = useRef<WhyNot | "">("");
  // The thanks goes by itself after a moment.
  useEffect(() => {
    if (asking !== "done") return;
    const t = window.setTimeout(() => setAsking("no"), 2500);
    return () => window.clearTimeout(t);
  }, [asking]);

  useEffect(() => {
    if (!token || Math.random() * READ_SAMPLE >= 1) return;
    const blocks = [...document.querySelectorAll<HTMLElement>("[data-block]")];
    if (blocks.length === 0 || typeof IntersectionObserver === "undefined") return;
    let furthest = -1;
    let sent = false;
    let started = false;
    let sawBuy = false;
    // The video played: its block, and how far into it, the furthest reached.
    let videoBlock = "";
    let videoAt = "";
    let youtubeLength = 0;
    const buy = document.getElementById("buy");
    const watch = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === buy) {
            sawBuy = true;
            continue;
          }
          const at = blocks.indexOf(entry.target as HTMLElement);
          if (at > furthest) furthest = at;
        }
      },
      { threshold: 0.4 },
    );
    blocks.forEach((block) => watch.observe(block));
    if (buy) watch.observe(buy);

    const rank = (q: string) => ["", "p", "25", "50", "75", "100"].indexOf(q);
    const reached = (q: string) => {
      if (rank(q) > rank(videoAt)) videoAt = q;
    };
    // Pressing play on a video of the page (components/video-embed.tsx).
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const play = event.target.closest(".sp-video-play");
      if (play) {
        const block = play.closest<HTMLElement>("[data-block]")?.dataset.block ?? "";
        if (block && (!videoBlock || videoBlock === block)) {
          videoBlock = block;
          reached("p");
          // Ask the player to say where it is, once it has loaded.
          window.setTimeout(listen, 1500);
          window.setTimeout(listen, 4000);
        }
      }
      if (event.target.closest("form[data-checkout] button:not([data-no-checkout]), form[data-checkout] [type=submit]:not([data-no-checkout])")) started = true;
    };
    const listen = () => {
      for (const frame of document.querySelectorAll<HTMLIFrameElement>(".sp-video iframe")) {
        try {
          const player = framePlayer(frame.src);
          // Sent to the frame's own player origin only, never "*" (lib/player-origin.ts).
          const target = frameTarget(frame.src);
          if (!target) continue;
          if (player === "youtube") frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), target);
          if (player === "vimeo") frame.contentWindow?.postMessage(JSON.stringify({ method: "addEventListener", value: "timeupdate" }), target);
        } catch {}
      }
    };
    // What the players say back: YouTube its time and length, Vimeo its share played.
    // Only from the exact origin of a player frame this page drew, and only
    // from that frame's own window (lib/player-origin.ts): any other window
    // can post a message here too.
    const onMessage = (event: MessageEvent) => {
      if (!videoBlock) return;
      const player = messagePlayer(document.querySelectorAll<HTMLIFrameElement>(".sp-video iframe"), event.source, event.origin);
      if (!player) return;
      let data: unknown = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!data || typeof data !== "object") return;
      const message = data as { event?: string; info?: { currentTime?: number; duration?: number }; data?: { percent?: number } };
      if (player === "youtube" && (message.event === "infoDelivery" || message.event === "initialDelivery")) {
        // YouTube says the length once, near the start, and the time on every
        // message after: the length is kept from whichever message carried it.
        const d = Number(message.info?.duration);
        if (d > 0) youtubeLength = d;
        const t = Number(message.info?.currentTime);
        if (t > 0 && youtubeLength > 0) reached(quartile(t / youtubeLength));
      } else if (player === "vimeo" && message.event === "timeupdate") {
        const p = Number(message.data?.percent);
        if (p > 0) reached(quartile(p));
      }
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("message", onMessage);

    // What stops a visitor who is not buying: asked once they have seen the
    // buy box and stayed, if they have not started to pay and were not asked
    // about this product before on this device.
    let timer = 0;
    if (ask && buy) {
      let askedBefore = false;
      try {
        askedBefore = Boolean(localStorage.getItem(askedKey(product)));
      } catch {}
      if (!askedBefore) {
        timer = window.setInterval(() => {
          if (sawBuy && !started && document.visibilityState === "visible") {
            window.clearInterval(timer);
            try {
              localStorage.setItem(askedKey(product), String(Date.now()));
            } catch {}
            setAsking("yes");
          }
        }, ASK_AFTER_SECONDS * 1000);
      }
    }

    const send = () => {
      if (sent || furthest < 0) return;
      sent = true;
      sendRead({
        t: token,
        k: "d",
        p: product,
        b: blocks[furthest].dataset.block ?? "",
        ...(answer.current ? { w: answer.current } : {}),
        ...(videoBlock && videoAt ? { v: `${videoBlock}.${videoAt}` } : {}),
      });
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") send();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", send);
    return () => {
      watch.disconnect();
      window.clearInterval(timer);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", send);
    };
  }, [token, product, ask]);

  if (!ask || asking === "no") return null;
  return (
    <aside aria-labelledby="whynot-title" className="st-card fixed inset-x-3 bottom-3 z-40 mx-auto max-w-md p-5 sm:inset-x-auto sm:right-6 sm:bottom-6">
      {asking === "done" ? (
        <p className="font-semibold" role="status">
          {ask.thanks}
        </p>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <p id="whynot-title" className="font-semibold leading-snug">
              {ask.question}
            </p>
            <button type="button" className="btn st-btn-ghost btn-sm shrink-0" onClick={() => setAsking("no")} aria-label={ask.close}>
              ×
            </button>
          </div>
          <p className="st-muted mt-1 text-sm">{ask.note}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {WHY_NOT.map((a) => (
              <button
                key={a}
                type="button"
                className="btn st-btn-ghost btn-sm"
                onClick={() => {
                  answer.current = a;
                  setAsking("done");
                }}
              >
                {ask.choices[a]}
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
