"use client";

import { type ComponentProps, useEffect, useRef, useState } from "react";
import {
  SPEED_KEY,
  clockOf,
  keptSpeed,
  placeToRemove,
  positionKey,
  readPlace,
  readSpeed,
  resumeFrom,
  saveDue,
  sayAt,
  writePlace,
  type ResumeWords,
} from "@/lib/lesson-position-rules";


/** The browser's storage, or null where it is blocked (a private window, a setting): then nothing is kept. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * A lesson's hosted video that remembers where the student stopped, on their
 * own device (650 [WG10], lib/lesson-position-rules.ts). The video is the
 * same element as before, with its own controls; what this adds:
 *
 *   - for a signed-in student only (`learner`, their learner key), the place
 *     is written at most every 15 seconds while it plays and when it is
 *     paused or the page is left, and offered back above the video as
 *     "Continue at 12:40" and "Start over": two buttons, nothing jumps on its
 *     own, and the choice moves focus to the video so the keyboard can play;
 *   - the speed the student picked is used again in the next lessons;
 *   - the screen stays on while it plays, where the browser allows it
 *     (Screen Wake Lock); without it the video plays the same.
 */
export function LessonPlayer({
  courseId,
  lessonId,
  learner,
  words,
  ...video
}: { courseId: string; lessonId: string; learner: string | null; words: ResumeWords } & Omit<ComponentProps<"video">, "ref">) {
  const ref = useRef<HTMLVideoElement>(null);
  const [offer, setOffer] = useState<number | null>(null);
  const key = learner ? positionKey(courseId, lessonId, learner) : null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const store = storage();
    let lastSaved: number | null = null;
    let lock: { release: () => Promise<void> } | null = null;

    const save = (force: boolean) => {
      if (!store || !key) return;
      const now = Date.now();
      if (!force && !saveDue(lastSaved, now)) return;
      lastSaved = now;
      const duration = Number.isFinite(el.duration) ? el.duration : null;
      try {
        // Watched to its end: nothing to continue.
        if (resumeFrom({ seconds: Math.floor(el.currentTime), at: now }, duration) === null && duration !== null && el.currentTime > 0) store.removeItem(key);
        else if (el.currentTime > 0) store.setItem(key, writePlace(el.currentTime, now));
      } catch {
        // Full or blocked: the video plays all the same.
      }
    };
    const askOffer = () => {
      if (!store || !key) return;
      let raw: string | null = null;
      try {
        raw = store.getItem(key);
      } catch {}
      const now = Date.now();
      // Past KEEP_DAYS, or not one we wrote: removed as it is read, never offered.
      if (placeToRemove(raw, now)) {
        try {
          store.removeItem(key);
        } catch {}
      }
      const duration = Number.isFinite(el.duration) ? el.duration : null;
      const from = resumeFrom(readPlace(raw, now), duration);
      // Offered only before the student starts playing; once they play, it is theirs.
      setOffer(el.currentTime === 0 && el.paused ? from : null);
    };
    const speed = () => {
      if (!store) return;
      try {
        el.playbackRate = readSpeed(store.getItem(SPEED_KEY));
      } catch {}
    };
    const keepSpeed = () => {
      if (!store || !keptSpeed(el.playbackRate)) return;
      try {
        store.setItem(SPEED_KEY, String(el.playbackRate));
      } catch {}
    };
    const wake = async () => {
      const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
      if (lock || !nav.wakeLock || document.visibilityState !== "visible") return;
      try {
        lock = await nav.wakeLock.request("screen");
      } catch {
        lock = null;
      }
    };
    const sleep = () => {
      const held = lock;
      lock = null;
      void held?.release().catch(() => {});
    };
    const onPlay = () => {
      setOffer(null);
      void wake();
    };
    const onPause = () => {
      save(true);
      sleep();
    };
    const onEnded = () => {
      if (store && key) {
        try {
          store.removeItem(key);
        } catch {}
      }
      sleep();
    };
    const onTime = () => {
      if (!el.paused) save(false);
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        save(true);
        sleep();
      } else if (!el.paused) void wake();
    };
    const onLeave = () => save(true);

    speed();
    askOffer();
    el.addEventListener("loadedmetadata", askOffer);
    el.addEventListener("loadedmetadata", speed);
    el.addEventListener("ratechange", keepSpeed);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("timeupdate", onTime);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onLeave);
    return () => {
      el.removeEventListener("loadedmetadata", askOffer);
      el.removeEventListener("loadedmetadata", speed);
      el.removeEventListener("ratechange", keepSpeed);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("timeupdate", onTime);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onLeave);
      save(true);
      sleep();
    };
  }, [key]);

  const choose = (from: number | null) => {
    const el = ref.current;
    if (!el) return;
    if (from === null && key) {
      try {
        storage()?.removeItem(key);
      } catch {}
    }
    el.currentTime = from ?? 0;
    setOffer(null);
    el.focus();
  };

  return (
    <>
      {offer !== null ? (
        <div role="group" aria-label={words.label} data-lesson-resume="" className="flex flex-wrap items-center gap-3 bg-black p-3 text-sm text-white">
          <p className="min-w-0 flex-1">{sayAt(words.stopped, clockOf(offer))}</p>
          <button type="button" className="btn st-btn" onClick={() => choose(offer)}>
            {sayAt(words.resume, clockOf(offer))}
          </button>
          <button type="button" className="btn st-btn" onClick={() => choose(null)}>
            {words.startOver}
          </button>
        </div>
      ) : null}
      <video ref={ref} {...video} />
    </>
  );
}
