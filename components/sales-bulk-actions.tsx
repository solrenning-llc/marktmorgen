"use client";

import { useEffect, useId, useRef, useState } from "react";
import { type BulkChange, applySummary, cleanLabel, count, opposite, undoSummary } from "@/lib/bulk-label-rules";
import { formatMoney } from "@/lib/money";
import {
  BULK_SALES_REFUSALS,
  type BulkSaleRow,
  type CouldNot,
  MAX_BULK_SALES,
  NO_UNDO,
  type ResendTally,
  type Taken,
  canResend,
  exportConfirmWords,
  labelConfirmWords,
  readLabelOutcome,
  readLabelReview,
  resendConfirmWords,
  resendResultWords,
  selectedSalesCsv,
} from "@/lib/sales-bulk-rules";

type Action = "resend" | "label-add" | "label-remove" | "export";
type Confirm = { action: Action; words: string; ready: boolean; references: string[]; emails: string[]; noEmail: number; label: string };
type Done = { words: string; undo: { label: string; change: BulkChange; changed: string[]; taken: Taken[] } | null; noUndo: string };
type Focus = "confirm" | "done" | "title";

const COULD_NOT: ReadonlySet<string> = new Set<CouldNot>(["unknown", "call", "refunded", "failed", "limited"]);
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A bulk resend's answer, read exactly (rule 24): null when it is not in its shape, never "0 sent". */
function readTally(answer: Record<string, unknown>): ResendTally | null {
  const { sent, couldNot, skipped, asked } = answer;
  if (!whole(skipped) || !whole(asked) || !Array.isArray(sent) || !sent.every((s) => typeof s === "string") || !Array.isArray(couldNot)) return null;
  const rows: ResendTally["couldNot"] = [];
  for (const entry of couldNot) {
    const e = (entry ?? {}) as Record<string, unknown>;
    if (typeof e.reference !== "string" || typeof e.why !== "string" || !COULD_NOT.has(e.why)) return null;
    rows.push({ reference: e.reference, why: e.why as CouldNot });
  }
  return { asked, sent: sent as string[], couldNot: rows, skipped };
}

const distinct = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase()))];

/**
 * Bulk actions on the studio's sales list (767 [STN14], unit 4; lib/sales-bulk-rules.ts): choose orders in the
 * table, choose what to do, read exactly what will happen and to how many people, then confirm. Only actions that
 * exist one at a time: the purchase email again, a label on or off the buyers' contacts (with an undo), and a file
 * of the rows chosen. Nothing moves money.
 *
 * Accessibility (AX274): a real table with a caption and headers; every box is a native checkbox with its own
 * label and a 44 × 44 px target, so choosing works by keyboard, touch, voice and screen reader; the count of
 * chosen orders is a polite live status; nothing is done before the confirmation (3.3.6), which gets focus; the
 * result gets focus and stays on the screen; a button in use is aria-disabled, never disabled, so focus stays on
 * it. No time limit and no motion.
 *
 * The list above already shows each order once: this table is a second copy, so it is drawn only while the box is
 * open, and a closed box holds only its summary (the sales list keeps one row per order, tests/e2e/
 * shipment-acknowledgment.mjs, and the page carries no hidden copy). What was chosen, asked or done is kept while it
 * is closed. `defaultOpen` is for a render that starts open.
 */
export function SalesBulkActions({ sales, canLabel, canExport, defaultOpen = false }: { sales: BulkSaleRow[]; canLabel: boolean; canExport: boolean; defaultOpen?: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const box = useRef<HTMLDetailsElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<Action>("resend");
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [live, setLive] = useState("");
  const allBox = useRef<HTMLInputElement>(null);
  const confirmTitle = useRef<HTMLHeadingElement>(null);
  const doneLine = useRef<HTMLParagraphElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<Focus | null>(null);

  const chosen = sales.filter((sale) => selected.includes(sale.reference));
  const all = sales.length > 0 && selected.length === sales.length;
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = selected.length > 0 && !all;
  });
  // Opened before the page was ready: the toggle came before this listened, so it is read once here.
  useEffect(() => {
    if (box.current?.open) setOpen(true);
  }, []);
  useEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    focusNext.current = null;
    ({ confirm: confirmTitle, done: doneLine, title })[next].current?.focus();
  });

  // Any change to what is chosen or asked makes a confirmation stale: it is asked again.
  const stale = () => {
    setConfirm(null);
    setError("");
  };
  const toggle = (reference: string) => {
    stale();
    setSelected((now) => (now.includes(reference) ? now.filter((r) => r !== reference) : [...now, reference]));
  };
  const toggleAll = () => {
    stale();
    setSelected(all ? [] : sales.map((sale) => sale.reference));
  };

  async function post(url: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (answer.ok === true) return answer;
      setError(typeof answer.message === "string" ? answer.message : "That did not work. Nothing was changed. Try again in a moment.");
    } catch {
      setError("That did not work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return null;
  }

  async function review(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setDone(null);
    setLive("");
    setError("");
    if (!chosen.length) return setError(BULK_SALES_REFUSALS.none);
    if (chosen.length > MAX_BULK_SALES) return setError(BULK_SALES_REFUSALS.many);
    const emails = distinct(chosen.map((sale) => sale.email));
    const noEmail = chosen.filter((sale) => !sale.email).length;
    let next: Confirm;
    if (action === "resend") {
      const can = chosen.filter(canResend);
      if (!can.length) return setError("None of the orders you chose has a purchase email to send again. Calls, support and orders without an address have none.");
      const left = chosen.length - can.length;
      const words = `${resendConfirmWords(can.length, distinct(can.map((sale) => sale.email)).length)}${left ? ` ${count(left, "order", "orders")} you chose ${left === 1 ? "has" : "have"} no purchase email to send again, so ${left === 1 ? "it is" : "they are"} left out.` : ""}`;
      next = { action, words, ready: true, references: can.map((sale) => sale.reference), emails, noEmail, label: "" };
    } else if (action === "export") {
      next = { action, words: exportConfirmWords(chosen.length, emails.length), ready: true, references: chosen.map((sale) => sale.reference), emails, noEmail, label: "" };
    } else {
      const change: BulkChange = action === "label-add" ? "add" : "remove";
      if (!emails.length) return setError("None of the orders you chose has an email address, so there is no contact to label.");
      const answer = await post("/api/store/contact-labels", { action: "review", label, change, text: emails.join("\n") });
      if (!answer) return;
      const read = readLabelReview(answer.review);
      if (!read) return setError("The check of what would change could not be read. Nothing was changed. Try again in a moment.");
      // As the route keeps it (cleanLabel), so the words name the label that will be written.
      const kept = cleanLabel(label);
      next = { action, words: labelConfirmWords(kept, change, read, noEmail), ready: read.changes > 0, references: [], emails, noEmail, label: kept };
    }
    setConfirm(next);
    setLive("Check what will happen, then confirm. Nothing is done yet.");
    focusNext.current = "confirm";
  }

  function finish(next: Done, short: string) {
    setDone(next);
    setConfirm(null);
    setLive(short);
    focusNext.current = "done";
  }

  async function apply() {
    if (busy || !confirm || !confirm.ready) return;
    if (confirm.action === "export") {
      const rows = sales.filter((sale) => confirm.references.includes(sale.reference));
      const url = URL.createObjectURL(new Blob([selectedSalesCsv(rows)], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "selected-orders.csv";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const words = `Your file of ${count(rows.length, "order", "orders")} is downloading as selected-orders.csv.`;
      return finish({ words, undo: null, noUndo: NO_UNDO.export }, words);
    }
    if (confirm.action === "resend") {
      const answer = await post("/api/store/sales-bulk", { action: "resend", references: confirm.references });
      if (!answer) return;
      const tally = readTally(answer);
      if (!tally) {
        const words = "We could not confirm which emails were sent. Some may have gone. Ask your buyers before you send again.";
        return finish({ words, undo: null, noUndo: NO_UNDO.resend }, words);
      }
      const summary = resendResultWords(tally);
      return finish({ words: summary.words.replace(` ${NO_UNDO.resend}`, ""), undo: null, noUndo: NO_UNDO.resend }, summary.short);
    }
    const change: BulkChange = confirm.action === "label-add" ? "add" : "remove";
    const answer = await post("/api/store/contact-labels", { action: "apply", label: confirm.label, change, text: confirm.emails.join("\n") });
    if (!answer) return;
    const outcome = readLabelOutcome(answer, change);
    const written = typeof answer.label === "string" && answer.label ? answer.label : confirm.label;
    if (!outcome) {
      const words = "We could not confirm which contacts changed. Open your contacts to see their labels.";
      return finish({ words, undo: null, noUndo: "Without knowing what changed, there is nothing safe to undo here." }, words);
    }
    const summary = applySummary(confirm.emails.length, { ...outcome, changed: outcome.changed.length, replaced: change === "add" ? outcome.taken.length : 0 }, change, written);
    const noEmailWords = confirm.noEmail ? ` ${count(confirm.noEmail, "order has", "orders have")} no email address, so no contact was labeled for ${confirm.noEmail === 1 ? "it" : "them"}.` : "";
    finish({ words: `${summary.words}${noEmailWords}`, undo: outcome.changed.length ? { label: written, change, changed: outcome.changed, taken: outcome.taken } : null, noUndo: outcome.changed.length ? "" : "Nothing changed, so there is nothing to undo." }, summary.short);
  }

  async function undo() {
    if (busy || !done?.undo) return;
    const { label: undoLabel, change, changed, taken } = done.undo;
    const undoing = opposite(change);
    // Each contact sent once: with the form it had when there is one, otherwise by its address alone (components/bulk-labels.tsx).
    const withForm = new Set(taken.map((entry) => entry.email));
    const answer = await post("/api/store/contact-labels", { action: "apply", label: undoLabel, change: undoing, emails: changed.filter((email) => !withForm.has(email)), restore: taken });
    if (!answer) return;
    const outcome = readLabelOutcome(answer, undoing);
    const words = outcome
      ? undoSummary(changed.length, { changed: outcome.changed.length, already: outcome.already, full: outcome.full, notOnList: outcome.notOnList, noRoom: outcome.noRoom, failed: outcome.failed }, undoing).words
      : "We could not confirm what the undo changed. Open your contacts to see their labels.";
    setDone({ words, undo: null, noUndo: "" });
    setLive(words);
    focusNext.current = "title";
  }

  const actions: { value: Action; words: string }[] = [
    { value: "resend", words: "Send their purchase email again" },
    ...(canLabel ? ([{ value: "label-add", words: "Add a label to their contacts" }, { value: "label-remove", words: "Take a label off their contacts" }] as const) : []),
    ...(canExport ? ([{ value: "export", words: "Download these orders as a file" }] as const) : []),
  ];
  const needsLabel = action === "label-add" || action === "label-remove";

  return (
    <details ref={box} open={defaultOpen || undefined} onToggle={(event) => setOpen(event.currentTarget.open)} className="mt-6 rounded-[var(--r-md)] bg-white p-5">
      <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-ink">Act on several orders at once</summary>
      {open ? (
        <>
          <h3 ref={title} tabIndex={-1} className="mt-3 text-base font-semibold text-ink">
            Choose orders, then what to do
          </h3>
          <p className="mt-1 text-sm text-ink-soft">{`Up to ${MAX_BULK_SALES} orders at a time. Nothing happens until you confirm. Refunds and charges are never done here: make them one at a time in Stripe.`}</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Orders you can choose</caption>
              <thead>
                <tr>
                  <th scope="col" className="w-12 p-0">
                    <label className="flex min-h-11 min-w-11 items-center justify-center">
                      <input ref={allBox} type="checkbox" className="h-5 w-5" checked={all} onChange={toggleAll} />
                      <span className="sr-only">{all ? "Choose no orders" : `Choose all ${sales.length} orders`}</span>
                    </label>
                  </th>
                  <th scope="col" className="px-2 py-2 font-semibold text-ink">Product</th>
                  <th scope="col" className="px-2 py-2 font-semibold text-ink">Buyer</th>
                  <th scope="col" className="px-2 py-2 font-semibold text-ink">Paid on</th>
                  <th scope="col" className="px-2 py-2 font-semibold text-ink">Amount</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((sale) => {
                  const day = new Date(sale.paidAt * 1000).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
                  return (
                    <tr key={sale.reference} className="border-t border-line">
                      <td className="p-0">
                        <label className="flex min-h-11 min-w-11 items-center justify-center">
                          <input type="checkbox" className="h-5 w-5" checked={selected.includes(sale.reference)} onChange={() => toggle(sale.reference)} />
                          <span className="sr-only">{`Choose ${sale.title}, ${sale.email ?? "no email address"}, ${day}`}</span>
                        </label>
                      </td>
                      <th scope="row" className="px-2 py-2 font-normal text-ink [overflow-wrap:anywhere]">{sale.title}</th>
                      <td className="px-2 py-2 text-ink [overflow-wrap:anywhere]">{sale.email ?? "No email address"}</td>
                      <td className="px-2 py-2 text-ink">{day}</td>
                      <td className="px-2 py-2 text-ink">{Number.isSafeInteger(sale.amount) && sale.amount >= 0 ? formatMoney(sale.amount, sale.currency) : "Not known"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p role="status" className="mt-2 text-sm font-semibold text-ink">{`${selected.length} of ${count(sales.length, "order", "orders")} chosen`}</p>
          <form onSubmit={review} aria-busy={busy} className="mt-3" noValidate>
            <fieldset>
              <legend className="field-label">What to do with them</legend>
              <div className="mt-1 flex flex-wrap gap-x-6">
                {actions.map(({ value, words }) => (
                  <label key={value} className="flex min-h-11 items-center gap-2 text-sm text-ink">
                    <input type="radio" name={`${id}-action`} className="h-5 w-5" checked={action === value} onChange={() => {
                        stale();
                        setAction(value);
                      }} />
                    {words}
                  </label>
                ))}
              </div>
            </fieldset>
            {needsLabel ? (
              <div className="mt-3 text-sm">
                <label htmlFor={`${id}-label`} className="field-label block">
                  Label
                </label>
                <input id={`${id}-label`} className="field mt-1" value={label} onChange={(event) => {
                    stale();
                    setLabel(event.target.value);
                  }} aria-describedby={`${id}-label-hint`} />
                <span id={`${id}-label-hint`} className="mt-1 block text-xs text-ink-soft">
                  Only buyers on your list have a contact to label. A label here sends no email and starts no automation.
                </span>
              </div>
            ) : null}
            <button type="submit" className="btn btn-secondary mt-4" aria-disabled={busy || undefined}>
              Check what will happen
            </button>
            {error && !confirm && !done ? (
              <p className="mt-2 text-sm text-danger-text" role="alert">
                {error}
              </p>
            ) : null}
          </form>
          {confirm ? (
            <section aria-labelledby={`${id}-confirm`} className="mt-4 rounded-[var(--r-md)] bg-sand p-4">
              <h4 id={`${id}-confirm`} ref={confirmTitle} tabIndex={-1} className="font-semibold text-ink">
                Check before you confirm
              </h4>
              <p className="mt-1 text-sm text-ink">{confirm.words}</p>
              <div className="mt-3 flex flex-wrap gap-3">
                {confirm.ready ? (
                  <button type="button" className="btn btn-primary" aria-disabled={busy || undefined} onClick={() => void apply()}>
                    Confirm
                  </button>
                ) : null}
                <button type="button" className="btn btn-secondary" onClick={() => {
                    stale();
                    focusNext.current = "title";
                  }}>
                  Go back
                </button>
              </div>
              {error ? (
                <p className="mt-2 text-sm text-danger-text" role="alert">
                  {error}
                </p>
              ) : null}
            </section>
          ) : null}
          {done ? (
            <div className="mt-4">
              <p ref={doneLine} tabIndex={-1} className="text-sm text-ink">
                {done.words}
              </p>
              {done.undo ? (
                <button type="button" className="btn btn-secondary btn-sm mt-2" aria-disabled={busy || undefined} onClick={() => void undo()}>
                  Undo
                </button>
              ) : done.noUndo ? (
                <p className="mt-1 text-sm text-ink-soft">{done.noUndo}</p>
              ) : null}
              {error ? (
                <p className="mt-2 text-sm text-danger-text" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      <p role="status" className="sr-only">
        {live}
      </p>
    </details>
  );
}
