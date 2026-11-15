"use client";

import { useEffect, useRef, useState } from "react";
import { type BulkChange, type BulkReview, type Removed, applySummary, cleanLabel, count, labelKey, opposite, undoSummary } from "@/lib/bulk-label-rules";
import { MAX_CONTACT_TAGS, MAX_TAG_LENGTH } from "@/lib/contact-rules";
import {
  ACCESS_REFUSALS,
  type AccessChange,
  type AccessDone,
  type AccessReview,
  MAX_STUDENT_ACTION,
  PROGRESS_WORDS,
  type StudentLine,
  accessReviewLines,
  accessSummary,
  oppositeAccess,
  progressOf,
  sentOutcome,
  studentsCsv,
} from "@/lib/student-bulk-rules";

type Action = "revoke" | "grant" | "label-add" | "label-remove";
type Taken = Removed & { email: string; forms?: number; cleaned?: true };
type Review =
  | { kind: "access"; change: AccessChange; emails: string[]; review: AccessReview; moved: boolean }
  | { kind: "label"; change: BulkChange; emails: string[]; label: string; review: BulkReview };
type Result =
  | { kind: "access"; change: AccessChange; done: AccessDone; words: string }
  | { kind: "label"; change: BulkChange; label: string; changed: string[]; taken: Taken[]; words: string };
type Place = "form" | "apply" | "undo" | "file";
type Focus = "review" | "result" | "title";

const ACTION_WORDS: Record<Action, string> = { revoke: "Remove access", grant: "Give access back", "label-add": "Add a label", "label-remove": "Take a label off" };
const ACTION_HINTS: Record<Action, string> = {
  revoke: "They can no longer open this course. Nothing is refunded.",
  grant: "Only for students whose access you removed. It does not give the course to someone who didn't get it.",
  "label-add": "Adds a label to their contact on your list. It doesn't start the label's automations.",
  "label-remove": "Takes the label off their contact on your list.",
};
const counted = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const day = (seconds: number) => (seconds > 0 ? new Date(seconds * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Never");

/**
 * The students on one page of a course's list, many selected at once (279
 * [H3-4], unit 1): their access removed or given back, a label put on or
 * taken off their contact, or the selection downloaded as a spreadsheet file.
 * Every change is reviewed first, with the exact count the confirmation acts
 * on; the answer says, person by person, what happened; and it can be undone
 * right after. Refunds are never here: they stay one at a time, from the order.
 *
 * Accessibility: every box is named by the student it selects; "Select all"
 * says how many and shows a mixed state when some are; how many are selected
 * is said in a status line; a button in use is aria-disabled, never disabled,
 * so focus stays on it; when what had focus goes away, focus moves to what
 * came in its place; a refusal is shown next to the step it answers; every
 * target is at least 44 by 44 pixels; nothing changes until a button is pressed.
 */
export function StudentsBulk({ productId, courseTitle, lessons, lines, canTag, canExport }: { productId: string; courseTitle: string; lessons: number; lines: StudentLine[]; canTag: boolean; canExport: boolean }) {
  const [rows, setRows] = useState(lines);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [action, setAction] = useState<Action>("revoke");
  const [label, setLabel] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorAt, setErrorAt] = useState<Place>("form");
  const [live, setLive] = useState("");

  const allBox = useRef<HTMLInputElement>(null);
  const formTitle = useRef<HTMLHeadingElement>(null);
  const reviewTitle = useRef<HTMLHeadingElement>(null);
  const resultLine = useRef<HTMLParagraphElement>(null);
  const focusNext = useRef<Focus | null>(null);
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = selected.size > 0 && selected.size < rows.length;
  }, [selected, rows.length]);
  useEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    focusNext.current = null;
    ({ review: reviewTitle, result: resultLine, title: formTitle })[next].current?.focus();
  });

  const actions: Action[] = canTag ? ["revoke", "grant", "label-add", "label-remove"] : ["revoke", "grant"];
  const chosen = rows.filter((row) => selected.has(row.email)).map((row) => row.email);

  // Any change of what is selected or asked makes a review stale: it is asked again before confirming.
  const stale = () => {
    setReview(null);
    setError("");
  };
  function toggle(email: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(email);
    else next.delete(email);
    setSelected(next);
    stale();
  }
  function toggleAll(on: boolean) {
    setSelected(on ? new Set(rows.map((row) => row.email)) : new Set());
    stale();
  }

  async function send(url: string, body: Record<string, unknown>, place: Place): Promise<{ status: number; answer: Record<string, unknown> } | null> {
    setBusy(true);
    setError("");
    setErrorAt(place);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const outcome = sentOutcome(response.status, answer);
      if (outcome.kind !== "refused") return { status: response.status, answer };
      setError(outcome.words);
    } catch {
      setError("That did not work, and it is not known whether anything changed. Check your connection, then review again to see.");
      setErrorAt(place);
    } finally {
      setBusy(false);
    }
    return null;
  }

  async function askReview(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setResult(null);
    setNote("");
    setLive("");
    if (!chosen.length) {
      setErrorAt("form");
      setError(ACCESS_REFUSALS.none);
      return;
    }
    if (chosen.length > MAX_STUDENT_ACTION) {
      setErrorAt("form");
      setError(ACCESS_REFUSALS.many);
      return;
    }
    if (action === "revoke" || action === "grant") {
      const sent = await send("/api/store/students", { action: "review", id: productId, change: action, emails: chosen }, "form");
      if (!sent) return;
      const asked = sent.answer.review as AccessReview;
      setReview({ kind: "access", change: action, emails: chosen, review: asked, moved: false });
      setLive(`Review ready: ${count(asked.changes, "student", "students")} would change. Nothing is changed yet.`);
    } else {
      const change: BulkChange = action === "label-add" ? "add" : "remove";
      const sent = await send("/api/store/contact-labels", { action: "review", label, change, emails: chosen }, "form");
      if (!sent) return;
      const asked = sent.answer.review as BulkReview;
      setReview({ kind: "label", change, emails: chosen, label: cleanLabel(label), review: asked });
      setLive(`Review ready: ${count(asked.changes, "contact", "contacts")} would change. Nothing is changed yet.`);
    }
    focusNext.current = "review";
  }

  // A change of access, confirmed at the count shown; when the count moved, the new review is shown to confirm again.
  async function changeAccess(change: AccessChange, emails: string[], expect: number, place: Place, undoing: boolean) {
    const sent = await send("/api/store/students", { action: "apply", id: productId, change, emails, expect }, place);
    if (!sent) return;
    if (sent.status === 409) {
      const now = sent.answer.review as AccessReview;
      setResult(null);
      setReview({ kind: "access", change, emails, review: now, moved: true });
      setLive("Something changed since your review. Nothing was changed. Check the new count.");
      focusNext.current = "review";
      return;
    }
    const done: AccessDone = {
      asked: counted(sent.answer.asked),
      changed: list(sent.answer.changed),
      already: list(sent.answer.already),
      notStudent: list(sent.answer.notStudent),
      unread: list(sent.answer.unread),
      unknown: list(sent.answer.unknown),
      failed: list(sent.answer.failed),
    };
    const changed = new Set(done.changed);
    setRows((now) => now.map((row) => (changed.has(row.email) ? { ...row, removed: change === "revoke" } : row)));
    const summary = accessSummary(done, change);
    setReview(null);
    if (undoing) {
      setResult(null);
      setNote(`Undo: ${summary.words}`);
      setLive(`Undo: ${summary.short}`);
      focusNext.current = "title";
    } else {
      setResult({ kind: "access", change, done, words: summary.words });
      setNote("");
      setLive(summary.short);
      focusNext.current = "result";
    }
  }

  async function applyLabel(r: Extract<Review, { kind: "label" }>) {
    const sent = await send("/api/store/contact-labels", { action: "apply", label: r.label, change: r.change, emails: r.emails }, "apply");
    if (!sent || sent.status === 409) return;
    const a = sent.answer;
    const changed = list(a.changed);
    const raw = r.change === "remove" ? a.removed : a.replaced;
    const taken = (Array.isArray(raw) ? raw : []) as Taken[];
    const summary = applySummary(counted(a.asked), { changed: changed.length, already: counted(a.already), full: counted(a.full), notOnList: counted(a.notOnList), noRoom: counted(a.noRoom), failed: counted(a.failed), replaced: r.change === "add" ? taken.length : 0 }, r.change, String(a.label));
    relabel(changed, String(a.label), r.change);
    setResult({ kind: "label", change: r.change, label: String(a.label), changed, taken, words: summary.words });
    setReview(null);
    setNote("");
    setLive(summary.short);
    focusNext.current = "result";
  }

  // The table shows the label as the list now has it, for the contacts it changed.
  function relabel(emails: string[], name: string, change: BulkChange) {
    const changed = new Set(emails);
    const key = labelKey(name);
    setRows((now) =>
      now.map((row) => {
        if (!changed.has(row.email) || row.labels === null) return row;
        const kept = row.labels.filter((l) => labelKey(l) !== key);
        return { ...row, labels: change === "add" ? [...kept, name] : kept };
      }),
    );
  }

  async function undo() {
    if (busy || !result) return;
    if (result.kind === "access") {
      await changeAccess(oppositeAccess(result.change), result.done.changed, result.done.changed.length, "undo", true);
      return;
    }
    const undoing = opposite(result.change);
    const withForm = new Set(result.taken.map((entry) => entry.email));
    const sent = await send("/api/store/contact-labels", { action: "apply", label: result.label, change: undoing, emails: result.changed.filter((email) => !withForm.has(email)), restore: result.taken }, "undo");
    if (!sent || sent.status === 409) return;
    const back = list(sent.answer.changed);
    const summary = undoSummary(result.changed.length, { changed: back.length, already: counted(sent.answer.already), full: counted(sent.answer.full), notOnList: counted(sent.answer.notOnList), noRoom: counted(sent.answer.noRoom), failed: counted(sent.answer.failed) }, undoing);
    relabel(back, result.label, undoing);
    setNote(summary.words);
    setLive(summary.short);
    setResult(null);
    focusNext.current = "title";
  }

  function download() {
    if (!chosen.length) {
      setErrorAt("file");
      setError(ACCESS_REFUSALS.none);
      return;
    }
    setError("");
    const file = new Blob([studentsCsv(rows.filter((row) => selected.has(row.email)), courseTitle, lessons)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${courseTitle.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "course"}-students.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setLive(`Downloaded a file with ${count(chosen.length, "student", "students")}.`);
  }

  const placeError = (place: Place) => (errorAt === place ? error : "");
  const confirmWords = (r: Review) =>
    r.kind === "access"
      ? r.review.changes === 0
        ? "Nothing to change"
        : `${r.change === "revoke" ? "Remove access for" : "Give access back to"} ${count(r.review.changes, "student", "students")}`
      : r.review.changes === 0
        ? "Nothing to change"
        : `${r.change === "add" ? "Add it to" : "Take it off"} ${count(r.review.changes, "contact", "contacts")}`;
  const resultLists = result?.kind === "access"
    ? ([
        ["Changed", result.done.changed],
        ["Already so", result.done.already],
        ["Not a student of this course", result.done.notStudent],
        ["Access could not be read, not changed", result.done.unread],
        ["Changed but not confirmed", result.done.unknown],
        ["Did not change", result.done.failed],
      ] as const).filter(([, emails]) => emails.length > 0)
    : [];
  const undoable = result ? (result.kind === "access" ? result.done.changed.length > 0 : result.changed.length > 0) : false;

  return (
    <div>
      <p className="mt-2 text-sm text-ink-soft" role="status">
        {`${selected.size.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")} selected`}
      </p>
      <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Students on this page, one row each">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-ink-mute">
              <th scope="col" className="py-2 pr-3 font-semibold">
                <label className="flex min-h-11 min-w-11 items-center gap-2">
                  <input ref={allBox} type="checkbox" className="h-5 w-5" checked={rows.length > 0 && selected.size === rows.length} onChange={(event) => toggleAll(event.target.checked)} />
                  <span>{`Select all ${count(rows.length, "student", "students")} on this page`}</span>
                </label>
              </th>
              <th scope="col" className="py-2 pr-3 font-semibold">Progress</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Last here</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Access</th>
              {canTag ? <th scope="col" className="py-2 font-semibold">Labels</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.email} className="border-t border-line align-top">
                <td className="py-1 pr-3">
                  <label className="flex min-h-11 min-w-11 items-center gap-2 break-all">
                    <input type="checkbox" className="h-5 w-5 shrink-0" aria-label={`Select ${row.email}`} checked={selected.has(row.email)} onChange={(event) => toggle(row.email, event.target.checked)} />
                    <span aria-hidden="true">{row.email}</span>
                  </label>
                </td>
                <td className="py-2 pr-3">{`${PROGRESS_WORDS[progressOf(row.done, lessons)]} (${Math.min(row.done, lessons)} of ${lessons} lessons)`}</td>
                <td className="whitespace-nowrap py-2 pr-3">{day(row.lastSeen)}</td>
                <td className="whitespace-nowrap py-2 pr-3">{row.removed ? "Removed" : "Has access"}</td>
                {canTag ? <td className="py-2">{row.labels === null ? "Couldn't be read" : row.labels.length ? row.labels.join(", ") : "None"}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={askReview} aria-busy={busy} className="card mt-6 p-6 sm:p-8" noValidate>
        <h3 ref={formTitle} tabIndex={-1} className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Change the selected students
        </h3>
        <fieldset className="mt-3">
          <legend className="field-label">What to do</legend>
          <div className="mt-1 grid gap-x-6 sm:grid-cols-2">
            {actions.map((value) => (
              <label key={value} className="flex min-h-11 items-start gap-2 py-1 text-sm">
                <input
                  type="radio"
                  name="students-action"
                  className="mt-0.5 h-5 w-5 shrink-0"
                  checked={action === value}
                  aria-describedby={`students-hint-${value}`}
                  onChange={() => {
                    setAction(value);
                    stale();
                  }}
                />
                <span>
                  <span className="block text-ink">{ACTION_WORDS[value]}</span>
                  <span id={`students-hint-${value}`} className="block text-xs text-ink-soft">
                    {ACTION_HINTS[value]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {action === "label-add" || action === "label-remove" ? (
          <div className="mt-4 text-sm">
            <label htmlFor="students-label" className="field-label block">
              Label
            </label>
            <input
              id="students-label"
              className="field mt-1"
              value={label}
              aria-describedby="students-label-hint"
              onChange={(event) => {
                setLabel(event.target.value);
                stale();
              }}
            />
            <span id="students-label-hint" className="mt-1 block text-xs text-ink-soft">
              {`Up to ${MAX_TAG_LENGTH} characters. A contact holds up to ${MAX_CONTACT_TAGS} labels. Example: Spring cohort`}
            </span>
          </div>
        ) : null}
        <p className="mt-4 text-sm text-ink">Refunds stay one at a time: open the order to refund it.</p>
        <button type="submit" className="btn btn-secondary mt-4" aria-disabled={busy || undefined}>
          Review the change
        </button>
        <p className="mt-2 text-sm text-danger-text" role="alert">
          {placeError("form")}
        </p>
        {canExport ? (
          <div className="mt-4 border-t border-line pt-4">
            <button type="button" className="btn btn-secondary" aria-disabled={busy || undefined} onClick={download}>
              {`Download the selected as a spreadsheet file (${chosen.length.toLocaleString("en-US")})`}
            </button>
            <p className="mt-1 text-xs text-ink-soft">A CSV file of the students you selected: email, progress, access and labels. Made on your device, from this page.</p>
            <p className="mt-2 text-sm text-danger-text" role="alert">
              {placeError("file")}
            </p>
          </div>
        ) : null}
      </form>

      <p role="status" className="sr-only">
        {live}
      </p>

      <div className="mt-4">
        {review ? (
          <section aria-labelledby="students-review-title" className="card p-6 sm:p-8">
            <h3 id="students-review-title" ref={reviewTitle} tabIndex={-1} className="text-lg font-semibold tracking-[-0.02em] text-ink">
              Before you confirm
            </h3>
            {review.kind === "access" && review.moved ? <p className="mt-2 text-sm text-ink">Something changed since your review. Nothing was changed. This is what it would do now.</p> : null}
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink">
              {review.kind === "access"
                ? accessReviewLines(review.review, review.change).map((words) => <li key={words}>{words}</li>)
                : [
                    `${count(review.review.changes, "contact", "contacts")} will ${review.change === "add" ? "get" : "lose"} the label “${review.label}”.`,
                    review.review.already ? `${count(review.review.already, "contact", "contacts")} ${review.change === "add" ? "already have it" : "don't have it"}: left as they are.` : "",
                    review.review.full ? `${count(review.review.full, "contact has", "contacts have")} ${MAX_CONTACT_TAGS} labels already: left as they are.` : "",
                    review.review.notOnList ? `${count(review.review.notOnList, "student is", "students are")} not on your list: nothing is added for them.` : "",
                    "No automation starts and no email is sent. You can undo this right after.",
                  ]
                    .filter(Boolean)
                    .map((words) => <li key={words}>{words}</li>)}
            </ul>
            <button
              type="button"
              className="btn btn-primary mt-4"
              aria-disabled={busy || review.review.changes === 0 || undefined}
              onClick={() => {
                if (busy || review.review.changes === 0) return;
                if (review.kind === "access") void changeAccess(review.change, review.emails, review.review.changes, "apply", false);
                else void applyLabel(review);
              }}
            >
              {confirmWords(review)}
            </button>
            <p className="mt-2 text-sm text-danger-text" role="alert">
              {placeError("apply")}
            </p>
          </section>
        ) : result ? (
          <div>
            <p ref={resultLine} tabIndex={-1} className="flex flex-wrap items-center gap-3 text-sm text-ink">
              <span id="students-result-line">{result.words}</span>
              {undoable ? (
                <button type="button" className="btn btn-secondary btn-sm" aria-disabled={busy || undefined} aria-describedby="students-result-line" onClick={() => void undo()}>
                  Undo
                </button>
              ) : null}
            </p>
            {resultLists.length ? (
              <details className="mt-2 text-sm">
                <summary className="flex min-h-11 cursor-pointer items-center">Who, one by one</summary>
                <dl className="mt-2 space-y-2">
                  {resultLists.map(([title, emails]) => (
                    <div key={title}>
                      <dt className="font-semibold text-ink">{`${title} (${emails.length.toLocaleString("en-US")})`}</dt>
                      <dd className="break-all text-ink-soft">{emails.join(", ")}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
            <p className="mt-2 text-sm text-danger-text" role="alert">
              {placeError("undo")}
            </p>
          </div>
        ) : note ? (
          <p className="text-sm text-ink">{note}</p>
        ) : null}
      </div>
    </div>
  );
}
