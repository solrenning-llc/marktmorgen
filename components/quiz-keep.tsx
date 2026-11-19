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
  words: { quizKeptBack: string; quizKeptClear: string; quizKeptCleared: string; quizKeepDevice: string; quizKeepDeviceHint: string };
}) {
  const mark = useRef<HTMLSpanElement>(null);
  const key = quizKeepKey(who);
  const ready = useHydrated();
  const [back, setBack] = useState(false);
  const [said, setSaid] = useState("");
  // Kept in this tab's session storage by default; on the device only once the student chooses it (review of #4324).
  const [onDevice, setOnDevice] = useState(false);
  const device = useRef(false);
  const saveNow = useRef<() => void>(() => {});

  useEffect(() => {
    const form = mark.current?.closest("form");
    if (!form) return;
    const choices = () => [...form.querySelectorAll<HTMLInputElement>('input[name^="q_"]')].filter((i) => i.type === "radio" || i.type === "checkbox");
    const snapshot = (): ChoiceInput[] => choices().map((i) => ({ name: i.name, value: i.value, checked: i.checked }));
    const local = storageArea("local");
    const session = storageArea("session");
    const read = (area: Storage | null) => {
      try {
        return area?.getItem(key) ?? null;
      } catch {
        return null;
      }
    };
    // A draft on the device is there only because the student chose it: the choice shows as made.
    const fromDevice = read(local);
    const raw = fromDevice ?? read(session);
    device.current = fromDevice !== null;
    const draft = draftToRestore(raw, shown, tries, Date.now(), version);
    let pending: ReturnType<typeof setTimeout> | undefined;
    if (draft) {
      for (const input of choices()) input.checked = checkedAfter({ name: input.name, value: input.value, checked: input.checked }, draft);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the DOM was just changed outside React; the button to clear follows it.
      setBack(true);
      setOnDevice(device.current);
      // Said a moment after the status line is in the page, so a screen reader hears it (4.1.3).
      pending = setTimeout(() => setSaid(words.quizKeptBack), 150);
    } else if (raw !== null) {
      forget(key);
      device.current = false;
    }
    const save = () => {
      const now = draftOf(snapshot(), shown, tries, Date.now(), version);
      const [here, other] = device.current ? [local, session] : [session, local];
      try {
        if (hasAnswers(now)) here?.setItem(key, JSON.stringify(now));
        else here?.removeItem(key);
        other?.removeItem(key);
      } catch {
        // Storage closed (a private window): the answers simply are not kept.
      }
    };
    saveNow.current = save;
    form.addEventListener("change", save);
    return () => {
      if (pending) clearTimeout(pending);
      form.removeEventListener("change", save);
    };
  }, [key, shown, tries, version, words.quizKeptBack]);

  return (
    <span ref={mark} className="block" data-quiz-keep>
      {ready ? (
        <span className="mt-3 flex flex-col gap-2 text-sm">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
                  forget(key);
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
          {/* Off by default: the answers stay in this tab only. No name, so the quiz never sends it. */}
          <label className="inline-flex min-h-11 items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0"
              checked={onDevice}
              aria-describedby={`${key}-device-hint`}
              onChange={(event) => {
                device.current = event.target.checked;
                setOnDevice(event.target.checked);
                saveNow.current();
              }}
            />
            <span>
              {words.quizKeepDevice}
              <span id={`${key}-device-hint`} className="st-muted block">
                {words.quizKeepDeviceHint}
              </span>
            </span>
          </label>
        </span>
      ) : null}
    </span>
  );
}

/** One of the browser's storage areas, or null where it cannot be opened (a private window, storage blocked). */
function storageArea(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Removes a draft from this tab and from the device. */
function forget(key: string): void {
  for (const area of [storageArea("session"), storageArea("local")]) {
    try {
      area?.removeItem(key);
    } catch {
      // Storage closed: nothing kept there either.
    }
  }
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
    // In this tab and, where the student chose it, on the device.
    for (const storage of [storageArea("session"), storageArea("local")]) {
      if (storage) forgetClosedDraft(storage, key, tries, final, Date.now());
    }
  }, [key, tries, final]);
  return <span hidden data-quiz-forget />;
}
