"use client";

import { useEffect, useRef, useState } from "react";
import { type Chapter, MIN_CHAPTERS, chaptersWithin, currentChapter, jumpTo } from "@/lib/lesson-chapters";

// The quiet line is emptied on each click and written this long after, so a
// screen reader says it again when the same chapter is chosen twice.
const SAY_AFTER_MS = 100;

/**
 * The chapters of a lesson video, under it (382 [TB8], unit 1): one button
 * each, in order, that moves the page's own video (the <video> with
 * `videoId`) to that time and plays it. Focus stays on the button, so
 * nothing moves unless asked; a quiet line tells a screen reader where the
 * video went. The chapter the video is in is marked in words for a screen
 * reader (aria-current) and in weight and a mark, never by color alone.
 *
 * Once the browser knows the video's length, a chapter after its end is not
 * offered, and with fewer than two left there is no list. Nothing is stored
 * or sent: the chapters come from the lesson's text (lib/lesson-chapters.ts),
 * and `announce` is each one's line in the store's language.
 */
export function LessonChapters({ chapters, videoId, heading, announce }: { chapters: Chapter[]; videoId: string; heading: string; announce: string[] }) {
  const [shown, setShown] = useState(chapters);
  const [current, setCurrent] = useState(-1);
  const [said, setSaid] = useState("");
  const wait = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (wait.current) clearTimeout(wait.current);
    },
    [],
  );

  useEffect(() => {
    const video = document.getElementById(videoId);
    if (!(video instanceof HTMLVideoElement)) return;
    const measure = () => setShown(chaptersWithin(chapters, video.duration));
    const follow = () => setCurrent(currentChapter(chapters, video.currentTime));
    measure();
    video.addEventListener("loadedmetadata", measure);
    video.addEventListener("durationchange", measure);
    video.addEventListener("timeupdate", follow);
    video.addEventListener("seeked", follow);
    return () => {
      video.removeEventListener("loadedmetadata", measure);
      video.removeEventListener("durationchange", measure);
      video.removeEventListener("timeupdate", follow);
      video.removeEventListener("seeked", follow);
    };
  }, [chapters, videoId]);

  if (shown.length < MIN_CHAPTERS) return null;
  const headingId = `${videoId}-chapters`;
  return (
    <nav aria-labelledby={headingId} className="mt-4">
      <h2 id={headingId} className="st-label">{heading}</h2>
      <ol className="mt-2 grid gap-1">
        {shown.map((chapter, i) => {
          const here = i === current;
          return (
            <li key={chapter.at}>
              <button
                type="button"
                aria-current={here ? "true" : undefined}
                onClick={() => {
                  const video = document.getElementById(videoId);
                  if (!(video instanceof HTMLVideoElement)) return;
                  jumpTo(video, chapter.at);
                  setCurrent(i);
                  const line = announce[i] ?? "";
                  setSaid("");
                  if (wait.current) clearTimeout(wait.current);
                  wait.current = setTimeout(() => setSaid(line), SAY_AFTER_MS);
                }}
                className={`flex min-h-11 w-full items-baseline gap-3 rounded-xl px-3 py-2 text-left text-sm ${here ? "font-semibold" : ""}`}
                style={{ color: "var(--st-text)", border: `1px solid ${here ? "var(--st-text)" : "var(--st-line)"}` }}
              >
                <span aria-hidden="true" className="w-3 shrink-0">{here ? "▶" : ""}</span>
                <span className="shrink-0 tabular-nums underline underline-offset-2">{chapter.time}</span>
                <span className="min-w-0 break-words">{chapter.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p role="status" className="sr-only">{said}</p>
    </nav>
  );
}
