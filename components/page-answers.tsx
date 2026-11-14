"use client";

import { useState } from "react";
import { toast, toastProblem } from "@/components/toast";
import { WHY_NOT, WHY_NOT_NAMES, type WhyNot } from "@/lib/why-not-rules";
import type { VideoReach } from "@/lib/page-depth";
import { READ_SAMPLE } from "@/lib/page-read-sample";

const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

/**
 * What a sales page's measured visitors said and did beyond how far they read
 * (lib/page-depth.ts): what stopped those who did not buy, when the page asks,
 * and how far into the page's video those who pressed play got. With the
 * switch for the question, for whoever may change settings.
 */
export function PageAnswers({
  whyNot,
  videos,
  reachOf,
  asking,
  canSet,
  blockName,
}: {
  whyNot: Partial<Record<WhyNot, number>>;
  videos: Record<string, VideoReach>;
  /** Of the measured visitors, how many got as far as a block; null below the fewest to say. */
  reachOf: (block: string) => number | null;
  asking: boolean;
  canSet: boolean;
  blockName: (block: string) => string;
}) {
  const [on, setOn] = useState(asking);
  const [busy, setBusy] = useState(false);
  const answered = WHY_NOT.reduce((n, a) => n + (whyNot[a] ?? 0), 0);
  const videoRows = Object.entries(videos).filter(([, v]) => v.played > 0);

  async function toggle() {
    setBusy(true);
    try {
      const response = await fetch("/api/store/why-not-ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ask: !on }) });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; ask?: boolean };
      if (body.ok && typeof body.ask === "boolean") {
        setOn(body.ask);
        toast(body.ask ? "Your sales pages ask it now." : "Your sales pages no longer ask it.");
      } else toastProblem("That did not save. Try again.");
    } catch {
      toastProblem("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-[12px] bg-paper px-4 py-4 text-sm ring-1 ring-line">
      <p className="font-bold text-ink">What stops visitors from buying</p>
      {answered > 0 ? (
        <ul className="mt-2 divide-y divide-line">
          {WHY_NOT.filter((a) => whyNot[a]).sort((a, b) => (whyNot[b] ?? 0) - (whyNot[a] ?? 0)).map((a) => (
            <li key={a} className="flex items-baseline justify-between gap-3 py-1.5">
              <span className="text-ink">{WHY_NOT_NAMES[a]}</span>
              <span className="tabular-nums text-ink-soft">{`${whyNot[a]} · ${share(whyNot[a] ?? 0, answered)}`}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-ink-soft">{on ? "No answers yet." : "Not asked."}</p>
      )}
      <p className="mt-2 text-xs text-ink-soft">
        {`When it is on, a visitor who has seen the buy box, stayed ${25} seconds and not started to pay is asked once, in your store's language, with five answers to tap. Only one visitor in ${READ_SAMPLE} is measured, so at most one in ${READ_SAMPLE} is ever asked, and once per product on a device. `}
        {canSet ? (
          <button type="button" className="font-semibold text-violet-deep underline underline-offset-4" disabled={busy} onClick={() => void toggle()}>
            {on ? "Stop asking" : "Ask on my sales pages"}
          </button>
        ) : null}
      </p>

      {videoRows.length ? (
        <>
          <p className="mt-4 font-bold text-ink">How far the video is watched</p>
          <ul className="mt-2 space-y-2">
            {videoRows.map(([block, v]) => {
              const reached = reachOf(block);
              return (
                <li key={block}>
                  <p className="font-semibold text-ink">{blockName(block)}</p>
                  <p className="tabular-nums text-ink-soft">
                    {`${reached ? `${share(v.played, reached)} of those who reach it press play · ` : ""}of those who play: ${share(v.quarter, v.played)} watch a quarter, ${share(v.half, v.played)} half, ${share(v.end, v.played)} to the end`}
                  </p>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-ink-soft">
            YouTube and Vimeo say how far they are played; Loom says only that it was. From October 11, 2026, on the same visitors as how far the page is read.
          </p>
        </>
      ) : null}
    </div>
  );
}
