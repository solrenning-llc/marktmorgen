"use client";

import { useEffect, useRef, useState } from "react";
import { useHydrated } from "@/components/use-hydrated";
import { type ChoiceInput, checkedAfter, draftOf, draftToRestore, forgetClosedDraft, hasAnswers, quizKeepKey } from "@/lib/quiz-keep-rules";

/**
 * Keeps a quiz's answers in the student's own browser while they answer
 * (297 [SQ8]), by the rules of lib/quiz-keep-rules.ts. Drawn inside the quiz
 * form, only for a signed-in student who may answer, under the code the
 * server made for this lesson and them (`who`, lib/quiz-keep-key.ts), so the
 * key names no course and another student on the same browser never gets it back.
 *
 * When they come back to the lesson with a draft for the same questions and
 * the same number of recorded tries, their choices are put back and the
 * status line says so; "Clear my answers" forgets them and empties the
 * choices. Pressing the quiz's own button sends the answers as before and
 * forgets nothing: if the send fails, the draft is still there; once the
 * server records the try, `tries` goes up and the draft is forgotten the next
 * time the lesson opens. Nothing is sent to us before that, and nothing
 * happens without scripts: the quiz is the plain form it always was.
 */
export function QuizKeep({
  who,
  shown,
  tries,
  version,
  words,
}: {
  who: string;
  shown: string;
  tries: number;
  /** The server's code for the quiz's words and choices (lib/quiz-keep-key.ts quizVersion). */
  version: string;
  words: { quizKeptBack: string; quizKeptClear: string; quizKeptCleared: string };
}) {
  const mark = useRef<HTMLSpanElement>(null);
  const key = quizKeepKey(who);
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
    const draft = draftToRestore(raw, shown, tries, Date.now(), version);
    let pending: ReturnType<typeof setTimeout> | undefined;
    if (draft) {
      for (const input of choices()) input.checked = checkedAfter({ name: input.name, value: input.value, checked: input.checked }, draft);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the DOM was just changed outside React; the button to clear follows it.
      setBack(true);
      // Said a moment after the status line is in the page, so a screen reader hears it (4.1.3).
      pending = setTimeout(() => setSaid(words.quizKeptBack), 150);
    } else if (raw !== null) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Storage closed: nothing to forget.
      }
    }
    const save = () => {
      const now = draftOf(snapshot(), shown, tries, Date.now(), version);
      try {
        if (hasAnswers(now)) window.localStorage.setItem(key, JSON.stringify(now));
        else window.localStorage.removeItem(key);
      } catch {
        // Storage closed (a private window): the answers simply are not kept.
      }
    };
    form.addEventListener("change", save);
    return () => {
      if (pending) clearTimeout(pending);
      form.removeEventListener("change", save);
    };
  }, [key, shown, tries, version, words.quizKeptBack]);

  return (
    <span ref={mark} className="block" data-quiz-keep>
      {ready ? (
        <span className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {/* One status line, in the page from the start and empty until there is something to say. */}
          <span role="status" className="st-muted">{said}</span>
          {back ? (
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
                // The button goes with the draft: the focus moves to the quiz's first choice, never to nowhere (2.4.3).
                form?.querySelector<HTMLInputElement>('input[name^="q_"]')?.focus();
              }}
            >
              {words.quizKeptClear}
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Drawn instead of QuizKeep while the quiz cannot be answered (passed, out of
 * tries, or waiting between tries), for the same signed-in student: removes
 * the draft a recorded try made useless, by forgetClosedDraft, the moment the
 * lesson opens (Codex L's review of #4324). Draws nothing visible.
 */
export function QuizForget({ who, tries, final }: { who: string; tries: number; final: boolean }) {
  const key = quizKeepKey(who);
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    if (storage) forgetClosedDraft(storage, key, tries, final, Date.now());
  }, [key, tries, final]);
  return <span hidden data-quiz-forget />;
}
