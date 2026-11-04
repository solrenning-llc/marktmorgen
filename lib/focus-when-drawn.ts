/**
 * Moves the keyboard's focus to something that is about to be drawn: now if
 * it is there, otherwise at each of the next animation frames until it is,
 * for at most `frames` frames (375 [TB1]). The page editor uses it after a
 * block or a part of a row is added: the new field may be drawn a frame or
 * more after the change (a part of the page still loading, a slow first
 * build), and a focus asked for once and dropped when the field was not there
 * yet left the focus on the Add button, so a typed space added it again.
 *
 * Pure apart from what it is given, so tests/focus-when-drawn.test.ts drives
 * it with its own frames.
 */

export type Focusable = { focus: (options?: { preventScroll?: boolean }) => void };

export type Frames = {
  request: (step: () => void) => number;
  cancel: (handle: number) => void;
};

/** About half a second at 60 frames a second: long enough for a late field, short enough never to take the focus long after. */
export const FOCUS_FRAMES = 30;

/** Returns a stop function, for an effect's clean-up; it does nothing once the focus has moved or the frames ran out. */
export function focusWhenDrawn(find: () => Focusable | null | undefined, frames: Frames, most = FOCUS_FRAMES): () => void {
  let handle: number | null = null;
  let left = most;
  const tryNow = () => {
    handle = null;
    const target = find();
    if (target) {
      target.focus();
      return;
    }
    if (left <= 0) return;
    left -= 1;
    handle = frames.request(tryNow);
  };
  tryNow();
  return () => {
    if (handle !== null) frames.cancel(handle);
    handle = null;
  };
}

/** The browser's own frames. */
export function browserFrames(): Frames {
  return {
    request: (step) => window.requestAnimationFrame(step),
    cancel: (handle) => window.cancelAnimationFrame(handle),
  };
}
