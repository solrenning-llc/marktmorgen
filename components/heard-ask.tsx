"use client";

import { useState } from "react";
import { HEARD_ANSWERS, type HeardAnswer } from "@/lib/heard-rules";
import { heardWords } from "@/lib/buyer-words/heard";

/**
 * "Where did you hear about us?" on the page a buyer lands on after paying
 * (lib/heard.ts): one tap, or none. Answered once; the answer is counted and
 * nothing about the buyer is kept with it.
 */
export function HeardAsk({ handle, session, storeName, lang }: { handle: string; session: string; storeName: string; lang: string }) {
  const w = heardWords(lang);
  const [state, setState] = useState<"asking" | "sending" | "done" | "failed">("asking");
  const [chosen, setChosen] = useState<HeardAnswer | null>(null);

  async function answer(a: HeardAnswer) {
    setChosen(a);
    setState("sending");
    try {
      const response = await fetch("/api/store/heard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ h: handle, s: session, a }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean };
      setState(body.ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <section aria-labelledby="heard-title" className="st-card mt-6 p-7 sm:p-10">
      <h2 id="heard-title" className="font-display text-xl font-semibold leading-tight tracking-[-0.02em]">
        {w.question(storeName)}
      </h2>
      {state === "done" ? (
        <p className="st-muted mt-3" role="status">
          {w.thanks}
        </p>
      ) : (
        <>
          <p className="st-muted mt-2 text-sm leading-relaxed">{w.note}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            {HEARD_ANSWERS.map((a) => (
              <button
                key={a}
                type="button"
                className="btn st-btn-ghost btn-sm min-w-11"
                aria-pressed={chosen === a}
                disabled={state === "sending"}
                onClick={() => void answer(a)}
              >
                {w.choices[a]}
              </button>
            ))}
          </div>
          {state === "failed" ? (
            <p className="mt-3 text-sm" role="alert">
              {w.failed}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
