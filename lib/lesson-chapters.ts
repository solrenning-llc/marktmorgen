/**
 * Chapters of a lesson video (382 [TB8], unit 1; 7 November 2026).
 *
 * The creator writes them in the lesson's own text, one line each, the way
 * people already write them under a video:
 *
 *   0:00 Welcome
 *   2:15 Setup
 *   1:02:03 Wrap up
 *
 * The lesson page lists them under a video uploaded as a file, and each one
 * moves that video to its time (components/lesson-chapters.tsx). Nothing is
 * stored, read or sent for them: the text is the one the page already reads,
 * and the list is worked out from it each time. The text itself is shown as
 * the creator typed it; the list is only another way into the same video.
 *
 * A list is the creator's on purpose or it is not shown: lines in a row (a
 * blank line between them is allowed), starting at 0:00, each later than the
 * one before, at least two. A line of other words or a block of code ends
 * it, and a line at 0:00 starts a new one; a time in between that goes back
 * or repeats makes that list wrong, and it is not shown. So a stray "3:15 pm"
 * in a sentence never turns into a button. Times in code are never read.
 *
 * Videos played by the video service (lib/stream.ts) get no list in this
 * unit: that player sits in another site's frame, and moving it needs the
 * service's own documented way, which is unit 2.
 */
import { lessonBlocks } from "@/lib/lesson-blocks";

/** Fewer than this is a time in a sentence, not a list of chapters. */
export const MIN_CHAPTERS = 2;
export const MAX_CHAPTERS = 50;
export const MAX_CHAPTER_TITLE = 100;
/** The id of the lesson page's own <video>, which the list moves. */
export const LESSON_VIDEO_ID = "lesson-video";

export type Chapter = { at: number; time: string; title: string };
/** What the list needs of a video: where it is, and a way to play. */
export type Seekable = { currentTime: number; play: () => Promise<void> | void };

const TWO = /^\d{2}$/;
const ONE_OR_TWO = /^\d{1,2}$/;

/**
 * Seconds from a time typed as m:ss, mm:ss or h:mm:ss, or null when it is not
 * one: seconds and minutes under 60, two digits of seconds, two digits of
 * minutes after hours, and under a day.
 */
export function chapterTime(raw: string): number | null {
  const parts = raw.split(":");
  if (parts.length === 2) {
    const [m, s] = parts;
    if (!ONE_OR_TWO.test(m) || !TWO.test(s)) return null;
    const minutes = Number(m);
    const seconds = Number(s);
    return minutes < 60 && seconds < 60 ? minutes * 60 + seconds : null;
  }
  if (parts.length === 3) {
    const [h, m, s] = parts;
    if (!ONE_OR_TWO.test(h) || !TWO.test(m) || !TWO.test(s)) return null;
    const hours = Number(h);
    const minutes = Number(m);
    const seconds = Number(s);
    return hours < 24 && minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : null;
  }
  return null;
}

/** A time the short way: 0:00, 2:15, 10:00, 1:02:03. */
export function formatChapterTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A time, a space, an optional dash or bar with a space after it, and a title. */
const LINE = /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(?:[-–—|]\s+)?(\S.*)$/;

function chapterLine(raw: string): Chapter | null {
  const match = LINE.exec(raw.trim());
  if (!match) return null;
  const at = chapterTime(match[1]);
  const title = match[2].replace(/\s+/g, " ").trim().slice(0, MAX_CHAPTER_TITLE).trim();
  return at === null || !title ? null : { at, time: formatChapterTime(at), title };
}

/** A run of chapter lines is a list only from 0:00, each later than the last, two or more. */
function isList(run: Chapter[]): boolean {
  return run.length >= MIN_CHAPTERS && run[0].at === 0 && run.every((one, i) => i === 0 || one.at > run[i - 1].at);
}

/** The chapters in a lesson's text: the first good list, at most MAX_CHAPTERS, or none. */
export function lessonChapters(text: string): Chapter[] {
  let run: Chapter[] = [];
  const found = (): Chapter[] | null => (isList(run) ? run.slice(0, MAX_CHAPTERS) : null);
  for (const block of lessonBlocks(text)) {
    const lines = block.kind === "paragraph" ? block.lines : block.kind === "list" ? block.items : null;
    if (!lines) {
      // Code ends a list, and nothing in it is read.
      const list = found();
      if (list) return list;
      run = [];
      continue;
    }
    for (const line of lines) {
      const chapter = chapterLine(line);
      if (chapter && !(chapter.at === 0 && run.length)) {
        run.push(chapter);
        continue;
      }
      // A line at 0:00 after others starts a list of its own.
      const list = found();
      if (list) return list;
      run = chapter ? [chapter] : [];
    }
  }
  return found() ?? [];
}

/**
 * The chapters that start inside a video of this length, once the browser
 * knows it; all of them while it does not, or for a video with no end. With
 * fewer than two left, none: one button is not a list.
 */
export function chaptersWithin(chapters: Chapter[], duration: number): Chapter[] {
  if (!Number.isFinite(duration) || duration <= 0) return chapters;
  const inside = chapters.filter((one) => one.at < duration);
  return inside.length >= MIN_CHAPTERS ? inside : [];
}

/** Which chapter the video is in at this second; -1 when that is not known. */
export function currentChapter(chapters: Chapter[], seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return -1;
  let at = -1;
  chapters.forEach((one, i) => {
    if (one.at <= seconds) at = i;
  });
  return at;
}

/**
 * Moves the video to a chapter and plays it. A browser that will not play
 * (it can refuse) leaves the video at the chapter, paused, with no error.
 */
export function jumpTo(video: Seekable, at: number): void {
  if (!Number.isFinite(at) || at < 0) return;
  video.currentTime = at;
  const played = video.play();
  if (played && typeof played.catch === "function") played.catch(() => {});
}
