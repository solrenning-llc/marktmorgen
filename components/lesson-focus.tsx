"use client";

/**
 * Focus mode on a lesson (queue item 295 [SQ6]). One button above the lesson
 * hides the course's path, the list of lessons and the comments, so only the
 * lesson shows: its video with the player's own controls, its text, its
 * downloads, its quiz or task, and the button that marks it done. The same
 * button, now "Exit focus mode", brings them back; so does Esc.
 *
 * The hidden parts stay on the page with the hidden attribute, never taken
 * off it, so a comment being typed is still there afterward. The button stays
 * where it was, so the keyboard's focus stays on it on the way in and out.
 * Nothing moves or fades, whatever "reduce motion" says. The choice is kept
 * only in this browser's own storage (lib/lesson-focus.ts) and nothing is
 * sent anywhere: no cost per student and no supplier.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { CoursesWords } from "@/lib/buyer-words/courses";
import { LESSON_FOCUS_KEY, LESSON_FOCUS_ON, leavesFocus, readLessonFocus, typingInto } from "@/lib/lesson-focus";

/** The four sentences the button and its note need, in the store's language. */
export type FocusWords = { enter: string; exit: string; onNote: string; offNote: string };

/** Picks them from the course's words, so the page passes plain strings to the browser. */
export function focusWordsOf(w: CoursesWords): FocusWords {
  return { enter: w.focusMode, exit: w.exitFocusMode, onNote: w.focusOnNote, offNote: w.focusOffNote };
}

type Parts = {
  /** The course's path above the lesson. */
  crumb: ReactNode;
  /** The lesson itself: always shown. */
  article: ReactNode;
  /** The list of the course's lessons beside it. */
  side: ReactNode;
  /** The comments under it, when the reader has any. */
  below?: ReactNode;
};

const PATH_ID = "lesson-focus-path";
const LIST_ID = "lesson-focus-list";
const COMMENTS_ID = "lesson-focus-comments";

/** The page around a lesson, with focus mode off or on. Pure, so the test draws both. */
export function FocusLayout({
  on,
  message,
  words,
  onToggle,
  crumb,
  article,
  side,
  below,
}: Parts & { on: boolean; message: string; words: FocusWords; onToggle: () => void }) {
  const hasBelow = below !== null && below !== undefined && below !== false;
  const controls = [PATH_ID, LIST_ID, ...(hasBelow ? [COMMENTS_ID] : [])].join(" ");
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div id={PATH_ID} hidden={on} className="min-w-0">
          {crumb}
        </div>
        <button
          type="button"
          aria-controls={controls}
          onClick={onToggle}
          className="st-footer-link ml-auto inline-flex min-h-11 min-w-11 items-center text-sm font-semibold"
        >
          {on ? words.exit : words.enter}
        </button>
      </div>
      <p role="status" className={on ? "st-note mt-3 text-sm" : "sr-only"}>
        {message}
      </p>
      <div className={on ? "mx-auto mt-4 grid max-w-3xl gap-6" : "mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]"}>
        {article}
        <div id={LIST_ID} hidden={on} className="min-w-0 lg:row-span-2">
          {side}
        </div>
        {hasBelow ? (
          <div id={COMMENTS_ID} hidden={on} className="min-w-0 lg:col-start-1 lg:row-start-2">
            {below}
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * The lesson page's layout with the switch. Off until this browser's kept
 * choice is read; a press made before that read wins over it.
 */
export function LessonFocus({ words, ...parts }: Parts & { words: FocusWords }) {
  const [on, setOn] = useState(false);
  const [message, setMessage] = useState("");
  const pressed = useRef(false);

  useEffect(() => {
    const first = window.setTimeout(() => {
      if (pressed.current) return;
      let kept = false;
      try {
        kept = readLessonFocus(window.localStorage.getItem(LESSON_FOCUS_KEY));
      } catch {
        // Storage blocked: focus mode stays off.
      }
      if (kept) {
        setOn(true);
        setMessage(words.onNote);
      }
    }, 0);
    return () => window.clearTimeout(first);
  }, [words.onNote]);

  const choose = useCallback(
    (next: boolean) => {
      pressed.current = true;
      setOn(next);
      setMessage(next ? words.onNote : words.offNote);
      try {
        if (next) window.localStorage.setItem(LESSON_FOCUS_KEY, LESSON_FOCUS_ON);
        else window.localStorage.removeItem(LESSON_FOCUS_KEY);
      } catch {
        // Not remembered; the choice still holds on this page.
      }
    },
    [words.onNote, words.offNote],
  );

  useEffect(() => {
    if (!on) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const press = {
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        typing: target ? typingInto(target.tagName, target.isContentEditable, target.getAttribute("type") ?? undefined) : false,
        fullScreen: Boolean(document.fullscreenElement),
      };
      if (leavesFocus(true, press)) choose(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [on, choose]);

  return <FocusLayout on={on} message={message} words={words} onToggle={() => choose(!on)} {...parts} />;
}
