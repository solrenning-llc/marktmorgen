"use client";

import { useEffect, useId, useRef, useState } from "react";
import { type PreviewDraft, StorePreviewDraft } from "@/components/store-preview-draft";
import { PREVIEW_WORDS, previewRefusalWords } from "@/lib/store-preview-words";

type Answer = { ok: true; previewId: string; draft: PreviewDraft & { questions?: { q: string; options: string[] }[] } } | { ok: false; error?: string; previewId?: string };

/**
 * 488 [IT5] unit 3b: the store preview on the home page, shown only while STORE_PREVIEW_ON is true (app/page.tsx).
 * One field with a label and an example, one button; the progress is said in a live region (4.1.3) with no bar and
 * no promised time; when the draft arrives the focus moves to its heading (2.4.3). If the draft asks questions, each
 * is a group of answers to press, and one more draft is written with them; a third is never asked. There is no time
 * limit on this page (2.2.3). Nothing is kept here yet: keeping the draft and carrying it into the studio is unit 4.
 */
export function StorePreviewForm() {
  const fieldId = useId();
  const statusId = useId();
  const headingId = useId();
  const [about, setAbout] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Extract<Answer, { ok: true }>["draft"] | null>(null);
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [answered, setAnswered] = useState(false);
  const heading = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (draft) heading.current?.querySelector<HTMLElement>("h3")?.focus();
  }, [draft]);

  async function ask(answers?: { q: string; a: string }[]) {
    if (busy) return;
    setBusy(true);
    setStatus(PREVIEW_WORDS.writing);
    try {
      const response = await fetch("/api/store-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ about, selling: "", storeName: "", currency: "usd", language: "en", website, ...(answers && previewId ? { previewId, answers } : {}) }),
      });
      const answer = (await response.json().catch(() => ({ ok: false, error: "failed" }))) as Answer;
      if (answer.ok) {
        setPreviewId(answer.previewId);
        setDraft(answer.draft);
        setPicked({});
        if (answers) setAnswered(true);
        setStatus(PREVIEW_WORDS.ready);
      } else {
        setStatus(previewRefusalWords(answer.error ?? "failed"));
      }
    } catch {
      setStatus(previewRefusalWords("failed"));
    } finally {
      setBusy(false);
    }
  }

  const questions = !answered ? (draft?.questions ?? []) : [];
  return (
    <div className="pv" data-store-preview>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setAnswered(false);
          setPreviewId(null);
          void ask();
        }}
      >
        <label htmlFor={fieldId} className="pv-label">{PREVIEW_WORDS.label}</label>
        <textarea
          id={fieldId}
          className="pv-field"
          rows={4}
          maxLength={1_500}
          value={about}
          onChange={(event) => setAbout(event.target.value)}
          placeholder={PREVIEW_WORDS.example}
          aria-describedby={statusId}
          required
        />
        <input type="text" name="website" tabIndex={-1} aria-hidden="true" autoComplete="off" className="pv-trap" value={website} onChange={(event) => setWebsite(event.target.value)} />
        <button type="submit" className="hm-claim-button pv-button" aria-disabled={busy}>{PREVIEW_WORDS.button}</button>
      </form>
      <p id={statusId} className="pv-status" aria-live="polite">{status}</p>
      {draft ? (
        <div ref={heading}>
          <StorePreviewDraft draft={draft} currency="usd" headingId={headingId} />
        </div>
      ) : null}
      {questions.length ? (
        <section aria-label={PREVIEW_WORDS.answerHeading} className="pv-questions">
          <h4>{PREVIEW_WORDS.answerHeading}</h4>
          {questions.map((question, index) => (
            <fieldset key={question.q}>
              <legend>{question.q}</legend>
              {question.options.map((option) => (
                <label key={option} className="pv-option">
                  <input type="radio" name={`pv-q-${index}`} checked={picked[index] === option} onChange={() => setPicked({ ...picked, [index]: option })} />
                  {option}
                </label>
              ))}
            </fieldset>
          ))}
          <button
            type="button"
            className="hm-claim-button pv-button"
            aria-disabled={busy}
            onClick={() => void ask(questions.map((question, index) => ({ q: question.q, a: picked[index] ?? "" })).filter((x) => x.a))}
          >
            {PREVIEW_WORDS.answerButton}
          </button>
        </section>
      ) : null}
    </div>
  );
}
