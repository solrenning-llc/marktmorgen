"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_BULK_ADDRESSES, type BulkChange, type BulkReview, type Removed, count, opposite, undoSummary } from "@/lib/bulk-label-rules";
import { MAX_CONTACT_TAGS } from "@/lib/contact-rules";

type Done = { label: string; change: BulkChange; changed: string[]; removed: (Removed & { email: string })[] };
/** The field a refusal is about, read from the route's error code (BULK_REFUSALS). */
type Field = "text" | "label" | "change";
/** Where focus goes once the screen has changed, so it is never left on something that went away. */
type Focus = "review" | "undo" | "done" | "title";
const counted = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const FIELD_OF: Record<string, Field> = { label: "label", none: "text", many: "text", change: "change" };
const DATA_FULL = "Your store has no room left for more records. Delete some you no longer need first.";

/**
 * A label on or off many contacts at once (639 [GL7](3), unit 1): the
 * addresses and the label, a review of what it will do before anything is
 * written, then the change, and an undo that takes back exactly what it
 * changed, each contact's own label put back as it was written there, and
 * says how many did not go back and why. It starts no automation, and says
 * so before confirming.
 *
 * Accessibility (AAA audit, 4 Nov 2026): a button in use is aria-disabled,
 * never disabled, so focus stays on it; when what had focus goes away,
 * focus moves to what came in its place; a refusal is shown and read next
 * to the field it is about; only one short sentence is live, never the
 * whole review; nothing is said twice (no toast beside it).
 */
export function BulkLabels() {
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [change, setChange] = useState<BulkChange>("add");
  const [review, setReview] = useState<BulkReview | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  // What an undo said, kept on the screen (a toast would go away).
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<Field | null>(null);
  // The one short sentence a screen reader is told after each step.
  const [live, setLive] = useState("");

  const formTitle = useRef<HTMLHeadingElement>(null);
  const reviewTitle = useRef<HTMLHeadingElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const doneLine = useRef<HTMLParagraphElement>(null);
  const focusNext = useRef<Focus | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    focusNext.current = null;
    ({ review: reviewTitle, undo: undoButton, done: doneLine, title: formTitle })[next].current?.focus();
  });

  async function send(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError("");
    setErrorField(null);
    try {
      const response = await fetch("/api/store/contact-labels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (answer.ok) return answer;
      setErrorField(typeof answer.error === "string" ? (FIELD_OF[answer.error] ?? null) : null);
      setError(typeof answer.message === "string" ? answer.message : answer.error === "data_full" ? DATA_FULL : "That did not work. Nothing was changed. Try again in a moment.");
    } catch {
      setError("That did not work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return null;
  }

  // Anything typed after a review makes it stale: it is asked again before applying.
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setReview(null);
  };

  async function askReview(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setDone(null);
    setNote("");
    setLive("");
    const answer = await send({ action: "review", label, change, text });
    if (!answer) return;
    const asked = answer.review as BulkReview;
    setReview(asked);
    setLive(`Review ready: ${count(asked.changes, "contact", "contacts")} would change. Nothing is changed yet.`);
    focusNext.current = "review";
  }

  async function apply() {
    if (busy || !review || review.changes === 0) return;
    const answer = await send({ action: "apply", label, change, text });
    if (!answer) return;
    const changed = (answer.changed as string[]) ?? [];
    setDone({ label: String(answer.label), change, changed, removed: Array.isArray(answer.removed) ? (answer.removed as Done["removed"]) : [] });
    setNote("");
    setReview(null);
    setLive(`${change === "add" ? "Label added to" : "Label taken off"} ${count(changed.length, "contact", "contacts")}.`);
    focusNext.current = changed.length ? "undo" : "done";
  }

  async function undo() {
    if (busy || !done) return;
    const undoing = opposite(done.change);
    const answer = await send({ action: "apply", label: done.label, change: undoing, emails: done.changed, ...(done.change === "remove" ? { restore: done.removed } : {}) });
    if (!answer) return;
    const changed = Array.isArray(answer.changed) ? answer.changed.length : 0;
    const summary = undoSummary(done.changed.length, { changed, already: counted(answer.already), full: counted(answer.full), notOnList: counted(answer.notOnList) }, undoing);
    // Kept on the screen either way; said once, in the live line.
    setNote(summary.words);
    setLive(summary.words);
    setDone(null);
    focusNext.current = "title";
  }

  // A refusal about one field is shown and read with that field; any other one at the end of the form.
  const fieldError = (field: Field) => (errorField === field ? error : "");
  const describedBy = (hint: string | null, field: Field) => [hint, errorField === field ? `bulk-${field}-error` : null].filter(Boolean).join(" ") || undefined;

  return (
    <div>
      <form onSubmit={askReview} aria-busy={busy} className="card p-6 sm:p-8" noValidate>
        <h2 id="bulk-title" ref={formTitle} tabIndex={-1} className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Label several contacts at once
        </h2>
        <div className="mt-4 text-sm">
          <label htmlFor="bulk-text" className="field-label block">
            Their email addresses
          </label>
          <textarea id="bulk-text" className="field mt-1 min-h-32" value={text} onChange={(event) => edit(setText)(event.target.value)} aria-describedby={describedBy("bulk-text-hint", "text")} aria-invalid={errorField === "text" || undefined} rows={6} />
          <span id="bulk-text-hint" className="mt-1 block text-xs text-ink-soft">
            {`One per line, or separated by commas. Up to ${MAX_BULK_ADDRESSES.toLocaleString("en-US")} at a time. Example: ana@example.com`}
          </span>
          <span id="bulk-text-error" className="field-error mt-1 block" role="alert">
            {fieldError("text")}
          </span>
        </div>
        <div className="mt-4 text-sm">
          <label htmlFor="bulk-label" className="field-label block">
            Label
          </label>
          <input id="bulk-label" className="field mt-1" value={label} maxLength={40} onChange={(event) => edit(setLabel)(event.target.value)} aria-describedby={describedBy("bulk-label-hint", "label")} aria-invalid={errorField === "label" || undefined} />
          <span id="bulk-label-hint" className="mt-1 block text-xs text-ink-soft">
            Up to 40 characters. Example: Workshop May
          </span>
          <span id="bulk-label-error" className="field-error mt-1 block" role="alert">
            {fieldError("label")}
          </span>
        </div>
        <fieldset className="mt-4" aria-describedby={describedBy(null, "change")}>
          <legend className="field-label">What to do</legend>
          <div className="mt-1 flex flex-wrap gap-x-6">
            {(["add", "remove"] as const).map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name="bulk-change" className="h-5 w-5" checked={change === value} onChange={() => edit(setChange)(value)} aria-invalid={errorField === "change" || undefined} />
                {value === "add" ? "Add the label" : "Take the label off"}
              </label>
            ))}
          </div>
          <span id="bulk-change-error" className="field-error mt-1 block" role="alert">
            {fieldError("change")}
          </span>
        </fieldset>
        <p className="mt-4 text-sm text-ink">Adding a label here doesn&apos;t start its automations. It only adds the label.</p>
        <button type="submit" className="btn btn-secondary mt-4" aria-disabled={busy || undefined}>
          Review the change
        </button>
        <p className="mt-2 text-sm text-danger-text" role="alert">
          {errorField ? "" : error}
        </p>
      </form>
      <p role="status" className="sr-only">
        {live}
      </p>
      <div className="mt-4">
        {review ? (
          <section aria-labelledby="bulk-review-title" className="card p-6 sm:p-8">
            <h2 id="bulk-review-title" ref={reviewTitle} tabIndex={-1} className="text-lg font-semibold tracking-[-0.02em] text-ink">
              Before you confirm
            </h2>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink">
              <li>{`${count(review.changes, "contact", "contacts")} will ${change === "add" ? "get" : "lose"} the label “${label.trim()}”.`}</li>
              {review.already ? <li>{`${count(review.already, "contact", "contacts")} ${change === "add" ? "already have it" : "don't have it"}: left as they are.`}</li> : null}
              {review.full ? <li>{`${count(review.full, "contact has", "contacts have")} ${MAX_CONTACT_TAGS} labels already, the most a contact can have: left as they are.`}</li> : null}
              {review.notOnList ? <li>{`${count(review.notOnList, "address is", "addresses are")} not on your list: nothing is added for them.`}</li> : null}
              {review.skipped ? <li>{`${count(review.skipped, "piece", "pieces")} of what you pasted ${review.skipped === 1 ? "is" : "are"} not an email address.`}</li> : null}
              <li>No automation starts and no email is sent. You can undo this right after.</li>
            </ul>
            <button type="button" className="btn btn-primary mt-4" aria-disabled={busy || review.changes === 0 || undefined} onClick={() => void apply()}>
              {review.changes === 0 ? "Nothing to change" : `${change === "add" ? "Add it to" : "Take it off"} ${count(review.changes, "contact", "contacts")}`}
            </button>
          </section>
        ) : done ? (
          <p ref={doneLine} tabIndex={-1} className="flex flex-wrap items-center gap-3 text-sm text-ink">
            <span id="bulk-done-line">{`Done: ${count(done.changed.length, "contact", "contacts")} changed.`}</span>
            {done.changed.length ? (
              <button type="button" ref={undoButton} className="btn btn-secondary btn-sm" aria-disabled={busy || undefined} aria-describedby="bulk-done-line" onClick={() => void undo()}>
                Undo
              </button>
            ) : null}
          </p>
        ) : note ? (
          <p className="text-sm text-ink">{note}</p>
        ) : null}
      </div>
    </div>
  );
}
