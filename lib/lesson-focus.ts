/**
 * Focus mode on a lesson (queue item 295 [SQ6]): the rules behind the button
 * in components/lesson-focus.tsx, pure so tests/sq6-focus-mode.test.ts checks
 * them. Focus mode hides what is around the lesson (the course's path, the
 * list of lessons, the comments); it costs nothing per student and calls no
 * supplier. The choice is remembered only in the student's own browser.
 */

/** Where the choice is remembered, in this browser only, as a convenience. */
export const LESSON_FOCUS_KEY = "mm:lesson-focus";

/** What is kept while focus mode is on; it is removed when it is turned off. */
export const LESSON_FOCUS_ON = "on";

/** The remembered choice, read back: on only for exactly what was kept. */
export function readLessonFocus(saved: string | null | undefined): boolean {
  return saved === LESSON_FOCUS_ON;
}

/**
 * Whether the element a key was pressed in takes typing, so Esc belongs to it
 * (clearing a search, closing a list) rather than to the page.
 */
export function typingInto(tag: string, editable: boolean, type?: string): boolean {
  if (editable) return true;
  const name = tag.toUpperCase();
  if (name === "TEXTAREA" || name === "SELECT") return true;
  if (name !== "INPUT") return false;
  const kind = (type ?? "text").toLowerCase();
  return !["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"].includes(kind);
}

/** A key pressed on the page, as much of it as the rule needs. */
export type FocusKey = {
  key: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  typing: boolean;
  fullScreen: boolean;
  /** A dialog is open on the page (the store's chat or assistant, say): Esc closes it first. */
  dialogOpen: boolean;
};

/**
 * Whether a key leaves focus mode: Esc, while it is on, unless it was typed
 * into a field, was part of a word being composed, was already used by
 * something on the page, is leaving a video's full screen, or belongs to a
 * dialog open on the page.
 */
export function leavesFocus(on: boolean, press: FocusKey): boolean {
  return on && press.key === "Escape" && !press.defaultPrevented && !press.isComposing && !press.typing && !press.fullScreen && !press.dialogOpen;
}
