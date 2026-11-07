/** Chapters of a lesson video (382 [TB8], unit 1). Not built yet. */
export const MIN_CHAPTERS = 2;
export const MAX_CHAPTERS = 50;
export const MAX_CHAPTER_TITLE = 100;
export const LESSON_VIDEO_ID = "lesson-video";

export type Chapter = { at: number; time: string; title: string };
export type Seekable = { currentTime: number; play: () => Promise<void> | void };

export function chapterTime(raw: string): number | null {
  void raw;
  return null;
}

export function formatChapterTime(seconds: number): string {
  void seconds;
  return "";
}

export function lessonChapters(text: string): Chapter[] {
  void text;
  return [];
}

export function chaptersWithin(chapters: Chapter[], duration: number): Chapter[] {
  void duration;
  return chapters;
}

export function currentChapter(chapters: Chapter[], seconds: number): number {
  void chapters;
  void seconds;
  return -1;
}

export function jumpTo(video: Seekable, at: number): void {
  void video;
  void at;
}
