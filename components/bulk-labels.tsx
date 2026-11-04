"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { MAX_BULK_ADDRESSES, type BulkChange, type BulkReview, opposite } from "@/lib/bulk-label-rules";
import { MAX_CONTACT_TAGS } from "@/lib/contact-rules";

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * A label on or off many contacts at once (639 [GL7](3), unit 1): the
 * addresses and the label, a review of what it will do before anything is
 * written, then the change, and an undo that takes back exactly what it
 * changed. It starts no automation, and says so before confirming.
 */
export function BulkLabels() {
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [change, setChange] = useState<BulkChange>("add");
  const [review, setReview] = useState<BulkReview | null>(null);
  const [done, setDone] = useState<{ label: string; change: BulkChange; changed: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/store/contact-labels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (answer.ok) return answer;
      setError(typeof answer.message === "string" ? answer.message : answer.error === "data_full" ? "Your store's data room is full. Delete something you no longer need first." : "That did not work. Nothing was changed. Try again in a moment.");
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
    setDone(null);
    const answer = await send({ action: "review", label, change, text });
    if (answer) setReview(answer.review as BulkReview);
  }

  async function apply() {
    const answer = await send({ action: "apply", label, change, text });
    if (!answer) return;
    const changed = (answer.changed as string[]) ?? [];
    setDone({ label: String(answer.label), change, changed });
    setReview(null);
    toast(`${change === "add" ? "Label added to" : "Label taken off"} ${count(changed.length, "contact", "contacts")}.`);
  }

  async function undo() {
    if (!done) return;
    const answer = await send({ action: "apply", label: done.label, change: opposite(done.change), emails: done.changed });
    if (!answer) return;
    toast("Undone. Every contact is as it was.");
    setDone(null);
  }

  return (
    <div>
      <form onSubmit={askReview} aria-busy={busy} className="card p-6 sm:p-8" noValidate>
        <h2 id="bulk-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Label several contacts at once
        </h2>
        <label className="mt-4 block text-sm">
          <span className="field-label">Their email addresses</span>
          <textarea className="field mt-1 min-h-32" value={text} onChange={(event) => edit(setText)(event.target.value)} aria-describedby="bulk-text-hint" rows={6} />
          <span id="bulk-text-hint" className="mt-1 block text-xs text-ink-soft">
            {`One per line, or separated by commas. Up to ${MAX_BULK_ADDRESSES.toLocaleString("en-US")} at a time. Example: ana@example.com`}
          </span>
        </label>
        <label className="mt-4 block text-sm">
          <span className="field-label">Label</span>
          <input className="field mt-1" value={label} maxLength={40} onChange={(event) => edit(setLabel)(event.target.value)} aria-describedby="bulk-label-hint" />
          <span id="bulk-label-hint" className="mt-1 block text-xs text-ink-soft">
            Up to 40 characters. Example: Workshop May
          </span>
        </label>
        <fieldset className="mt-4">
          <legend className="field-label">What to do</legend>
          <div className="mt-1 flex flex-wrap gap-x-6">
            {(["add", "remove"] as const).map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name="bulk-change" className="h-5 w-5" checked={change === value} onChange={() => edit(setChange)(value)} />
                {value === "add" ? "Add the label" : "Take the label off"}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-4 text-sm text-ink">Adding a label here doesn&apos;t start its automations. It only adds the label.</p>
        <button type="submit" className="btn btn-secondary mt-4" disabled={busy}>
          Review the change
        </button>
        <p className="mt-2 text-sm text-danger-text" role="alert">
          {error}
        </p>
      </form>
      <div role="status" className="mt-4">
        {review ? (
          <section aria-labelledby="bulk-review-title" className="card p-6 sm:p-8">
            <h2 id="bulk-review-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
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
            <button type="button" className="btn btn-primary mt-4" disabled={busy || review.changes === 0} onClick={() => void apply()}>
              {review.changes === 0 ? "Nothing to change" : `${change === "add" ? "Add it to" : "Take it off"} ${count(review.changes, "contact", "contacts")}`}
            </button>
          </section>
        ) : done ? (
          <p className="flex flex-wrap items-center gap-3 text-sm text-ink">
            {`Done: ${count(done.changed.length, "contact", "contacts")} changed.`}
            {done.changed.length ? (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void undo()}>
                Undo
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
