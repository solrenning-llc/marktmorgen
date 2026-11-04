"use client";

import { useEffect, useRef, useState } from "react";
import { useHydrated } from "@/components/use-hydrated";
import type { FormWords } from "@/lib/buyer-words/form";

/** How long answers kept on a device are kept, at most: thirty days. */
export const KEEP_DAYS = 30;
const KEEP_MS = KEEP_DAYS * 86_400_000;
/** Where a form's answers are kept in this browser, and only there. */
export const keepKey = (handle: string, form: string) => `mm-form:${handle}:${form}`;

type Kept = { at: number; answers: [string, string][] };

/** What is kept: the questions' own answers (q_…), never the hidden fields or the box to hear from the creator. */
export function keptAnswers(entries: Iterable<[string, unknown]>): [string, string][] {
  return [...entries].flatMap(([name, value]) => (name.startsWith("q_") && typeof value === "string" && value ? [[name, value] as [string, string]] : []));
}
const answersOf = (form: HTMLFormElement) => keptAnswers(new FormData(form).entries());

/** What this browser kept for a form, or null; anything unreadable or older than KEEP_DAYS is forgotten. */
export function read(key: string): Kept | null {
  if (typeof window === "undefined") return null;
  const now = Date.now();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const kept = JSON.parse(raw) as Kept;
    if (!kept || typeof kept.at !== "number" || now - kept.at > KEEP_MS || !Array.isArray(kept.answers)) {
      window.localStorage.removeItem(key);
      return null;
    }
    return kept;
  } catch {
    return null;
  }
}

export function forget(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing kept, or storage closed: nothing to forget.
  }
}

/**
 * 639 [GL7](26) unit 3: a box, empty until the visitor checks it, that keeps
 * their answers in this browser until they send them, so a long form can be
 * finished later. Nothing is sent anywhere before they press the button;
 * sending, unchecking or thirty days forget them. Drawn only once the page
 * runs scripts, since without them it could do nothing.
 */
export function FormKeep({ handle, form, words }: { handle: string; form: string; words: Pick<FormWords, "keepLabel" | "keepHelp" | "keepBack"> }) {
  const mark = useRef<HTMLSpanElement>(null);
  const key = keepKey(handle, form);
  // Read once, in the browser; drawn only after hydration, so the server's page and the browser's first agree.
  const [kept] = useState(() => read(key));
  const ready = useHydrated();
  const [on, setOn] = useState(kept !== null);
  const back = kept !== null;

  useEffect(() => {
    const el = mark.current?.closest("form");
    if (!el) return;
    for (const [name, value] of kept?.answers ?? []) {
      el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(`[name="${CSS.escape(name)}"]`).forEach((input) => {
        if (input instanceof HTMLInputElement && (input.type === "radio" || input.type === "checkbox")) {
          if (input.value === value) input.checked = true;
        } else {
          input.value = value;
        }
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    const sent = () => forget(key);
    el.addEventListener("submit", sent);
    return () => el.removeEventListener("submit", sent);
  }, [key, kept]);

  useEffect(() => {
    const el = mark.current?.closest("form");
    if (!el || !on) return;
    const save = () => {
      try {
        window.localStorage.setItem(key, JSON.stringify({ at: Date.now(), answers: answersOf(el) } satisfies Kept));
      } catch {
        // Storage closed (a private window): the answers simply are not kept.
      }
    };
    save();
    el.addEventListener("input", save);
    el.addEventListener("change", save);
    return () => {
      el.removeEventListener("input", save);
      el.removeEventListener("change", save);
    };
  }, [on, key]);

  return (
    <span ref={mark} className="block">
      {ready ? (
        <label className="sp-form-option">
          {/* No name: the box itself is never sent with the answers. */}
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => {
              setOn(e.target.checked);
              if (!e.target.checked) forget(key);
            }}
            aria-describedby={`keep-${form}-help`}
          />
          <span className="text-sm">
            {words.keepLabel}
            <span id={`keep-${form}-help`} className="st-muted block">{words.keepHelp}</span>
          </span>
        </label>
      ) : null}
      {ready && back ? <span role="status" className="st-muted block text-sm">{words.keepBack}</span> : null}
    </span>
  );
}
