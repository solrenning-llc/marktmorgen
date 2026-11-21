"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const never = () => () => {};
const REDUCE = "(prefers-reduced-motion: reduce)";
const onMotionSetting = (changed: () => void) => {
  const query = typeof window.matchMedia === "function" ? window.matchMedia(REDUCE) : null;
  query?.addEventListener("change", changed);
  return () => query?.removeEventListener("change", changed);
};
const asksForLessMotion = () => typeof window.matchMedia === "function" && window.matchMedia(REDUCE).matches;

/** What the countdown says, in the store's language (lib/buyer-words), and how it writes a date. */
export type CountdownWords = {
  units: { days: string; hours: string; min: string; sec: string };
  /** "Until {when}", with {when} where the moment goes. */
  until: string;
  /** The button that stops the numbers changing, and the one that starts them again. */
  pause: string;
  resume: string;
  locale: string;
};

const ENGLISH: CountdownWords = {
  units: { days: "days", hours: "hours", min: "min", sec: "sec" },
  until: "Until {when}",
  pause: "Pause countdown",
  resume: "Resume countdown",
  locale: "en-US",
};

/**
 * A countdown to one moment (lib/sales-page.ts, CountdownBlock): the same
 * moment for every visitor, never one that starts again for each of them.
 * When it has passed, nothing is drawn.
 *
 * `now` is the server's clock at the moment the page was drawn, so the first
 * numbers are the same on the server and in the browser; from then on the
 * browser's own clock counts. The exact time is shown in the visitor's own
 * time zone once the browser is there to say which one that is.
 *
 * Numbers that change every second beside the rest of the page are moving
 * content (WCAG 2.2.2 Pause, Stop, Hide; 2.3.3 and COGA, less distraction):
 * a button stops them, and a visitor who asked for less motion
 * (prefers-reduced-motion) starts with them stopped. Stopped, the numbers are
 * not drawn at all, since numbers that no longer count would be wrong a minute
 * later; "Until {when}" names the same moment and never changes. `paused`
 * starts it stopped. Screen readers hear none of the ticking either way.
 */
export function Countdown({
  until,
  now,
  heading,
  note,
  words = ENGLISH,
  paused = false,
}: {
  until: number;
  now?: number;
  heading: string;
  note: string;
  words?: CountdownWords;
  paused?: boolean;
}) {
  const [clock, setClock] = useState<number | null>(now ?? null);
  // True only in the browser, after the page drawn on the server has been taken over.
  const here = useSyncExternalStore(never, () => true, () => false);
  // Counting on the server, until the browser says the visitor asked for less motion.
  const still = useSyncExternalStore(onMotionSetting, asksForLessMotion, () => false);
  // The visitor's own choice, once made, wins over the setting.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const stopped = chosen ?? (paused || still);

  useEffect(() => {
    const tick = () => setClock(Math.floor(Date.now() / 1000));
    // Read once even when stopped, so a moment that has passed is no longer shown.
    const first = window.setTimeout(tick, 0);
    const timer = stopped ? undefined : window.setInterval(tick, 1000);
    // Stopped, read once more when the moment comes, so an ended countdown leaves the page as a counting one does,
    // without ticking until then; a timer holds at most 2^31 - 1 ms (about 24.8 days), so a later moment is waited
    // for again from there.
    let end: number | undefined;
    const wake = () => {
      const ms = until * 1000 - Date.now();
      if (ms < 0) tick();
      else end = window.setTimeout(wake, Math.min(ms + 50, 2_147_483_647));
    };
    if (stopped) wake();
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.clearTimeout(end);
    };
  }, [stopped, until]);

  const left = clock === null ? null : until - clock;
  if (left !== null && left <= 0) return null;
  const seconds = left ?? 0;
  const parts: [number, string][] = [
    [Math.floor(seconds / 86_400), words.units.days],
    [Math.floor((seconds % 86_400) / 3_600), words.units.hours],
    [Math.floor((seconds % 3_600) / 60), words.units.min],
    [seconds % 60, words.units.sec],
  ];
  const when = here
    ? new Date(until * 1000).toLocaleString(words.locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
    : "";
  return (
    <div className="sp-countdown" role="timer" aria-live="off">
      {heading ? <p className="font-display text-xl font-semibold leading-snug">{heading}</p> : null}
      {stopped ? null : (
        <div className="sp-countdown-units" aria-hidden="true">
          {parts.map(([value, word]) => (
            <span key={word} className="sp-countdown-unit">
              <span className="sp-countdown-number">{left === null ? "–" : String(value).padStart(2, "0")}</span>
              <span className="sp-countdown-word st-muted">{word}</span>
            </span>
          ))}
        </div>
      )}
      {when ? <p className={stopped ? "mt-4 text-base font-semibold" : "st-muted mt-4 text-sm"}>{words.until.replace("{when}", when)}</p> : null}
      {note ? <p className="mt-2 text-sm font-semibold">{note}</p> : null}
      <button type="button" className="sp-countdown-toggle" onClick={() => setChosen(!stopped)}>
        {stopped ? words.resume : words.pause}
      </button>
    </div>
  );
}
