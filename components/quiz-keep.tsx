"use client";

import { useEffect, useRef, useState } from "react";
import { useHydrated } from "@/components/use-hydrated";
import { type ChoiceInput, checkedAfter, draftOf, draftToRestore, hasAnswers, quizKeepKey } from "@/lib/quiz-keep-rules";

/**
 * Keeps a quiz's answers in the student's own browser while they answer
 * (297 [SQ8]), by the rules of lib/quiz-keep-rules.ts. Drawn inside the quiz
 * form, only while the student may answer. When they come back to the lesson
 * with a draft for the same questions, their choices are put back and a line
 * says so; "Clear my answers" forgets them and empties the choices. Pressing
 * the quiz's own button sends the answers as before and forgets the draft.
 * Nothing is sent to us before that, and nothing happens without scripts:
 * the quiz is the plain form it always was.
 */
export function QuizKeep({ handle, product, lesson, shown, words }: { handle: string; product: string; lesson: string; shown: string; words: { quizKeptBack: string; quizKeptClear: string; quizKeptCleared: string } }) {
  const mark = useRef<HTMLSpanElement>(null);
  const key = quizKeepKey(handle, product, lesson);
  const ready = useHydrated();
  const [back, setBack] = useState(false);
  const [said, setSaid] = useState("");

  useEffect(() => {
    const form = mark.current?.closest("form");
    if (!form) return;
    const choices = () => [...form.querySelectorAll<HTMLInputElement>('input[name^="q_"]')].filter((i) => i.type === "radio" || i.type === "checkbox");
    const snapshot = (): ChoiceInput[] => choices().map((i) => ({ name: i.name, value: i.value, checked: i.checked }));
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      raw = null;
    }
    const draft = draftToRestore(raw, shown, Date.now());
    if (draft) {
      for (const input of choices()) input.checked = checkedAfter({ name: input.name, value: input.value, checked: input.checked }, draft);
      // Shown once the choices are back, so the line never claims what did not happen.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the DOM was just changed outside React; the line follows it.
      setBack(true);
    } else if (raw !== null) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Storage closed: nothing to forget.
      }
    }
    const save = () => {
      const now = draftOf(snapshot(), shown, Date.now());
      try {
        if (hasAnswers(now)) window.localStorage.setItem(key, JSON.stringify(now));
        else window.localStorage.removeItem(key);
      } catch {
        // Storage closed (a private window): the answers simply are not kept.
      }
    };
    const sent = () => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Nothing kept.
      }
    };
    form.addEventListener("change", save);
    form.addEventListener("submit", sent);
    return () => {
      form.removeEventListener("change", save);
      form.removeEventListener("submit", sent);
    };
  }, [key, shown]);

  return (
    <span ref={mark} className="block" data-quiz-keep>
      {ready && back ? (
        <span className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span role="status" className="st-muted">{words.quizKeptBack}</span>
          <button
            type="button"
            className="st-footer-link inline-flex min-h-11 items-center font-semibold"
            onClick={() => {
              const form = mark.current?.closest("form");
              form?.querySelectorAll<HTMLInputElement>('input[name^="q_"]').forEach((input) => {
                input.checked = false;
              });
              try {
                window.localStorage.removeItem(key);
              } catch {
                // Nothing kept.
              }
              setBack(false);
              setSaid(words.quizKeptCleared);
            }}
          >
            {words.quizKeptClear}
          </button>
        </span>
      ) : null}
      {ready && said ? <span role="status" className="st-muted mt-3 block text-sm">{said}</span> : null}
    </span>
  );
}
