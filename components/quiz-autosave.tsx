"use client";

import { useEffect, useRef, useState } from "react";
import { useHydrated } from "@/components/use-hydrated";
import type { CoursesWords } from "@/lib/buyer-words/courses";
import { keptQuizAnswers, onQuizLoad, pickedIn, sentKept, type QuizKept, type QuizLoad } from "@/lib/quiz-autosave";

// Every use of the browser's storage is here, each in its own try: a private
// window or blocked site data throws, and then the picks simply are not kept.
function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, kept: QuizKept): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}
function drop(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing kept, or storage closed: nothing to forget.
  }
}
/** Whether this browser lets the page keep anything at all; asked once, so the sentence is never a promise it cannot keep. */
function canKeep(): boolean {
  const probe = "mm-quiz:probe";
  try {
    window.localStorage.setItem(probe, "1");
  } catch {
    return false;
  }
  drop(probe);
  return true;
}

/** What this browser kept and whether it can keep anything, looked at once as the page opens. */
function firstLook(keepKey: string, fit: string, open: boolean, marked: boolean): { look: QuizLoad; keeping: boolean } {
  if (typeof window === "undefined") return { look: { kind: "none" }, keeping: false };
  return { look: onQuizLoad(load(keepKey), { fit, open, marked, now: Date.now() }), keeping: open && canKeep() };
}

const picks = (form: HTMLFormElement) =>
  [...form.querySelectorAll<HTMLInputElement>('input[name^="q_"]')].filter((input) => input.type === "radio" || input.type === "checkbox");

/**
 * 297 [SQ8]: keeps a quiz's picks in this browser as the student makes them
 * and puts them back when they return (rules in lib/quiz-autosave.ts). It
 * sits inside the quiz's form and draws nothing until the page runs scripts
 * and the browser can keep things; then one quiet line says the answers are
 * being saved, and after putting them back a status line says so, with a
 * button to clear them. It never moves the page or the focus by itself.
 */
export function QuizAutosave({
  keepKey,
  fit,
  open,
  marked,
  words,
}: {
  keepKey: string;
  fit: string;
  /** The student may answer now; when not, whatever was kept is forgotten. */
  open: boolean;
  /** The page came straight back from marking a try. */
  marked: boolean;
  words: Pick<CoursesWords, "quizKeepNote" | "quizKeepBack" | "quizKeepClear" | "quizKeepCleared">;
}) {
  const mark = useRef<HTMLSpanElement>(null);
  const said = useRef<HTMLSpanElement>(null);
  const ready = useHydrated();
  // Read once, in the browser (the server sees nothing kept); drawn only after
  // hydration, so the server's page and the browser's first render agree.
  const [first] = useState(() => firstLook(keepKey, fit, open, marked));
  const keeping = first.keeping;
  const [state, setState] = useState<"saving" | "back" | "cleared">(first.look.kind === "restore" ? "back" : "saving");

  useEffect(() => {
    const form = mark.current?.closest("form");
    if (!form) return;
    const { look } = first;
    if (look.kind === "forget") drop(keepKey);
    if (!first.keeping) return;
    if (look.kind === "restore") {
      for (const input of picks(form)) input.checked = pickedIn(look.answers, input.name, input.value);
      if (look.resave) store(keepKey, look.resave);
    }

    const save = () => {
      const answers = keptQuizAnswers(new FormData(form).entries() as Iterable<[string, unknown]>);
      if (answers.length === 0) drop(keepKey);
      else store(keepKey, { at: Date.now(), fit, answers });
    };
    // Kept as sent, not forgotten: if the try never comes back marked, the picks come back.
    const sending = () => {
      save();
      const kept = sentKept(load(keepKey), Date.now());
      if (kept) store(keepKey, kept);
    };
    form.addEventListener("change", save);
    form.addEventListener("submit", sending);
    return () => {
      form.removeEventListener("change", save);
      form.removeEventListener("submit", sending);
    };
  }, [first, keepKey, fit]);

  const clear = () => {
    const form = mark.current?.closest("form");
    if (form) for (const input of picks(form)) input.checked = input.defaultChecked;
    drop(keepKey);
    setState("cleared");
    // The button goes away with the click; the focus goes to the line that says what happened.
    requestAnimationFrame(() => said.current?.focus());
  };

  return (
    <span ref={mark} className="block" data-quiz-keep={keepKey} data-quiz-fit={fit} data-quiz-open={open ? "yes" : "no"} data-quiz-marked={marked ? "yes" : "no"}>
      {ready && keeping ? (
        <span className="mt-4 flex flex-wrap items-center gap-3">
          {state === "saving" ? <span className="st-muted text-sm">{words.quizKeepNote}</span> : null}
          {/* One live line, there from the start, so what changes in it is announced. */}
          <span ref={said} tabIndex={-1} role="status" className="text-sm">
            {state === "back" ? words.quizKeepBack : state === "cleared" ? words.quizKeepCleared : ""}
          </span>
          {state === "back" ? (
            <button type="button" className="btn st-btn-ghost" onClick={clear}>
              {words.quizKeepClear}
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
