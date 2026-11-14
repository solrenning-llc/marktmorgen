"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { leftWords } from "@/lib/welcome-offer";

const REDUCE = "(prefers-reduced-motion: reduce)";
const onMotionSetting = (changed: () => void) => {
  const query = typeof window.matchMedia === "function" ? window.matchMedia(REDUCE) : null;
  query?.addEventListener("change", changed);
  return () => query?.removeEventListener("change", changed);
};
const asksForLessMotion = () => typeof window.matchMedia === "function" && window.matchMedia(REDUCE).matches;

/**
 * The time left on a person's welcome offer (lib/welcome-offer.ts), and the
 * moment it ends in the visitor's own time. When it reaches the end the page
 * is read again, so the button goes.
 *
 * Numbers changing beside the rest of the page are moving content (WCAG 2.2.2
 * Pause, Stop, Hide; 2.3.3): a button pauses them (they are not drawn while
 * paused, since numbers that no longer count would be wrong) and starts them
 * again, as the sales page countdown does. A visitor who asked for less motion
 * (prefers-reduced-motion) sees hours and minutes, changing once a minute. The
 * moment it ends, "Yours until …", never changes.
 */
export function WelcomeCountdown({
  until,
  left,
  untilWords,
  locale,
  pause,
  resume,
}: {
  until: number;
  left: string;
  untilWords: string;
  locale: string;
  pause: string;
  resume: string;
}) {
  const [now, setNow] = useState<number | null>(null);
  const [stopped, setStopped] = useState(false);
  // Seconds on the server, until the browser says the visitor asked for less motion.
  const still = useSyncExternalStore(onMotionSetting, asksForLessMotion, () => false);
  useEffect(() => {
    const tick = () => {
      const seconds = Math.floor(Date.now() / 1000);
      setNow(seconds);
      if (seconds >= until) window.location.reload();
    };
    const first = window.setTimeout(tick, 0);
    const id = stopped ? undefined : window.setInterval(tick, still ? 60_000 : 1000);
    // Paused, or counting by the minute, the page is still read again when the moment comes; a timer holds at most
    // 2^31 - 1 ms (about 24.8 days), so a later moment is waited for again from there.
    let end: number | undefined;
    const wake = () => {
      const ms = until * 1000 - Date.now();
      if (ms < 0) tick();
      else end = window.setTimeout(wake, Math.min(ms + 50, 2_147_483_647));
    };
    if (stopped || still) wake();
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      window.clearTimeout(end);
    };
  }, [until, stopped, still]);
  const when = new Date(until * 1000).toLocaleString(locale, { month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const counted = now === null ? null : leftWords(until, now);
  // Less motion: hours and minutes only ("2:05"), so what is shown changes once a minute.
  const shown = counted && still ? counted.replace(/:\d\d$/, "") : counted;
  return (
    <>
      <p className="st-muted mt-2 text-sm" suppressHydrationWarning>
        {untilWords.replace("{when}", when)}
      </p>
      {shown && !stopped ? (
        <p className="mt-3 font-display text-2xl font-semibold tabular-nums" role="timer" aria-live="off" data-welcome-left>
          <span className="st-muted mr-1 text-sm font-normal">{left}</span>{" "}
          {shown}
        </p>
      ) : null}
      {counted ? (
        <button type="button" className="mt-2 inline-flex min-h-11 items-center text-sm underline underline-offset-4" onClick={() => setStopped(!stopped)}>
          {stopped ? resume : pause}
        </button>
      ) : null}
    </>
  );
}
