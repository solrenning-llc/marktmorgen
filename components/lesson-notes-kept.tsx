"use client";

import { useEffect, useRef, useState } from "react";
import { lessonNotesWords } from "@/lib/buyer-words/lesson-notes";
import type { LanguageCode } from "@/lib/store-language";

type Step = "idle" | "asking" | "busy" | "done" | "failed" | "slow";

/**
 * A student's private lesson notes on a course whose access has ended (290
 * [SQ1], third review of #3031, M2 and M4): they stay theirs, so the course's
 * page offers to download them and to delete them, which they still count
 * against in this store. Shown only to a signed-in student whose access ended
 * (app/[handle]/course/[product]/page.tsx); a student with the course open
 * has the same download on each lesson and empties notes there.
 *
 * Deleting asks first (AX274 3.3.6: it cannot be undone), with keeping them
 * as the answer focus lands on; focus never falls to the page when a control
 * goes away. Said in the store's `language`.
 */
export function LessonNotesKept({ handle, product, language = "en" }: { handle: string; product: string; language?: LanguageCode }) {
  const w = lessonNotesWords(language);
  const [step, setStep] = useState<Step>("idle");
  const opener = useRef<HTMLButtonElement | null>(null);
  const keep = useRef<HTMLButtonElement | null>(null);
  const said = useRef<HTMLParagraphElement | null>(null);
  const back = useRef(false);

  useEffect(() => {
    if (step === "asking") keep.current?.focus();
    // While deleting, the question and its focused button are gone: focus goes to the status that says so (N3).
    else if (step === "busy" || step === "done" || step === "failed" || step === "slow") said.current?.focus();
    else if (step === "idle" && back.current) {
      back.current = false;
      opener.current?.focus();
    }
  }, [step]);

  async function clear() {
    setStep("busy");
    try {
      const response = await fetch("/api/store/course/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, product, clear: true }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: unknown; error?: unknown };
      setStep(data.ok === true ? "done" : data.error === "slow" ? "slow" : "failed");
    } catch {
      setStep("failed");
    }
  }

  const status = step === "done" ? w.clearedAll : step === "failed" ? w.clearFailed : step === "slow" ? w.slow : step === "busy" ? w.clearing : "";

  return (
    <section className="mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }} aria-labelledby="lesson-notes-kept-heading">
      <h2 id="lesson-notes-kept-heading" className="text-lg font-semibold">{w.keptHeading}</h2>
      <p className="st-muted mt-1 text-sm">{w.keptLine}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a
          href={`/api/store/course/note?h=${encodeURIComponent(handle)}&p=${encodeURIComponent(product)}`}
          download
          className="st-footer-link inline-flex min-h-[44px] items-center text-sm font-semibold"
        >
          {w.download}
        </a>
        {step === "idle" || step === "failed" || step === "slow" ? (
          <button ref={opener} type="button" className="btn st-btn-ghost inline-flex min-h-[44px] items-center" onClick={() => setStep("asking")}>
            {w.clearAll}
          </button>
        ) : null}
      </div>
      {step === "asking" ? (
        <div className="mt-3" role="group" aria-labelledby="lesson-notes-kept-ask">
          <p id="lesson-notes-kept-ask" className="text-sm font-semibold">{w.clearAsk}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              ref={keep}
              type="button"
              className="btn st-btn inline-flex min-h-[44px] items-center"
              onClick={() => {
                back.current = true;
                setStep("idle");
              }}
            >
              {w.clearNo}
            </button>
            <button type="button" className="btn st-btn-ghost inline-flex min-h-[44px] items-center" onClick={clear}>
              {w.clearYes}
            </button>
          </div>
        </div>
      ) : null}
      <p ref={said} tabIndex={-1} role="status" className="mt-2 text-sm">{status}</p>
    </section>
  );
}
