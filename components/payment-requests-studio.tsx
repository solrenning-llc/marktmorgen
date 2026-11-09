"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { REFUND_CHECK_UNREAD, type RefundCheckReply, paymentRequestReply, refundCheckReply, type RequestAction } from "@/lib/payment-request-reply";
import { toast } from "@/components/toast";
import { StudioEmptyState } from "@/components/empty-state";
import { Icon } from "@/components/icons";
import { type Currency, fieldPrefix, formatMoney, readMoney } from "@/lib/money";
import {
  MAX_AUTO_REMINDERS,
  MAX_LINES,
  MAX_LINE_TEXT,
  MAX_NAME,
  MAX_NOTE,
  MAX_QUANTITY,
  MAX_SENDS,
  OPEN_DAYS,
  REMIND_EVERY_DAYS,
  DRAFT_PROBLEMS,
  STATUS_WORDS,
  MAX_OUTSIDE_NOTE,
  OUTSIDE_WORDS,
  type DraftProblem,
  type CheckedRequest,
  type RequestDraft,
  type RequestStatus,
  canSendAgain,
  nextReminderAt,
  requestBounds,
  readDraft,
  statusOf,
} from "@/lib/payment-request-rules";

type LineDraft = { text: string; quantity: string; amount: string };
export type RequestRow = CheckedRequest & { link: string };
export type Prefill = { email: string; name: string; text: string; amount: string };

const TONES: Record<RequestStatus, string> = {
  open: "bg-sky-50 text-sky-900 ring-sky-200",
  paid: "bg-emerald-50 text-emerald-900 ring-emerald-200",
  refunded: "bg-amber-50 text-amber-900 ring-amber-200",
  canceled: "bg-paper text-ink-soft ring-line",
  expired: "bg-paper text-ink-soft ring-line",
};

const day = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const dueDay = (d: string) => day(Date.parse(`${d}T12:00:00Z`));

/**
 * The studio's payment requests (lib/payment-request-rules.ts): a form for a
 * new one, for one person, with its lines, an optional due date and the
 * reminders that may go by themselves; and every request kept, with where
 * it stands, its link, and what can still be done with it.
 */
export function PaymentRequestsStudio({
  rows: given,
  now,
  currency,
  canSend,
  open,
  closedWhy,
  limits,
  openNow,
  emails,
  shareWords,
  taxOn,
  prefill,
  dueFirst,
  dueLast,
}: {
  rows: RequestRow[];
  now: number;
  currency: Currency;
  canSend: boolean;
  open: boolean;
  closedWhy: string;
  limits: { open: number; kept: number };
  openNow: number;
  emails: { used: number; limit: number };
  shareWords: string;
  taxOn: boolean;
  prefill: Prefill;
  dueFirst: string;
  dueLast: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(prefill.email);
  const [name, setName] = useState(prefill.name);
  const [lines, setLines] = useState<LineDraft[]>([{ text: prefill.text, quantity: "1", amount: prefill.amount }]);
  const [note, setNote] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [reminders, setReminders] = useState(1);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // The form as it was when its review opened (487 [IT4], pattern 8): the review holds only while nothing has changed since.
  const [reviewOf, setReviewOf] = useState<string | null>(null);
  // What the server's own reading (readDraft) makes of the form: the review shows this, so it shows what is billed.
  // The form a send error was about: once it is edited, that error no longer applies and is not said again.
  const [errorFor, setErrorFor] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<RequestDraft | null>(null);
  const snapshot = JSON.stringify({ email, name, lines, note, dueDate, reminders, consent });
  const reviewing = reviewOf !== null && reviewOf === snapshot && reviewed !== null;
  function changeAnswer(id: string) {
    setReviewOf(null);
    setError("");
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }
  const money = (cents: number) => formatMoney(cents, currency);
  const { min, max } = requestBounds(currency);

  const total = lines.reduce((sum, line) => {
    const cents = readMoney(line.amount.trim().replace(/^(\d+),(\d{1,2})$/, "$1.$2"), currency);
    const quantity = Number(line.quantity);
    return cents !== null && Number.isSafeInteger(quantity) && quantity > 0 ? sum + cents * quantity : sum;
  }, 0);

  async function call(body: Record<string, unknown> & { action: RequestAction }): Promise<{ ok: boolean; message?: string; sent?: boolean }> {
    try {
      const response = await fetch("/api/store/payment-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data: unknown = await response.json().catch(() => null);
      return paymentRequestReply(response.ok, data, body.action);
    } catch {
      return { ok: false };
    }
  }

  // The first press opens the review; only its own button sends.
  // Where each problem the reading can find is fixed.
  const PROBLEM_FIELD: Record<DraftProblem, string> = { email: "pr-email", name: "pr-name", lines: "pr-line-0", line: "pr-line-0", amount: "pr-line-0", total: "pr-line-0", note: "pr-note", due: "pr-due", reminders: "pr-reminders", consent: "pr-consent" };

  function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    // Held to the server's own rules before the review opens, so nothing is reviewed that would be refused.
    const read = readDraft({ email, name, lines, note, dueDate, autoReminders: reminders, consent }, currency);
    if (!read.ok) {
      setReviewOf(null);
      setError(DRAFT_PROBLEMS[read.problem]);
      const field = (read.problem === "line" || read.problem === "amount") && read.line !== undefined ? `pr-line-${read.line}` : PROBLEM_FIELD[read.problem];
      requestAnimationFrame(() => document.getElementById(field)?.focus());
      return;
    }
    setReviewed(read.draft);
    setReviewOf(snapshot);
    requestAnimationFrame(() => document.getElementById("pr-review-title")?.focus());
  }

  async function send() {
    if (busy || !reviewing) return;
    setBusy("create");
    setError("");
    const answer = await call({ action: "create", email, name, lines, note, dueDate, autoReminders: reminders, consent });
    setBusy("");
    if (!answer.ok) {
      setError(answer.message ?? "The result could not be confirmed. Reload to check the request before trying again.");
      // Said beside the button that was pressed, and read at once.
      setErrorFor(snapshot);
      requestAnimationFrame(() => document.getElementById("pr-send-error")?.focus());
      return;
    }
    setReviewOf(null);
    setReviewed(null);
    setErrorFor(null);
    requestAnimationFrame(() => document.getElementById("pr-email")?.focus());
    toast(answer.sent ? "Request sent." : "Request saved, but its email did not go. Send it again from the list.");
    setEmail("");
    setName("");
    setLines([{ text: "", quantity: "1", amount: "" }]);
    setNote("");
    setDueDate("");
    setConsent(false);
    router.refresh();
  }

  async function act(action: "remind" | "cancel" | "delete", id: string, done: string) {
    if (busy) return;
    setBusy(`${action}:${id}`);
    const answer = await call({ action, id });
    setBusy("");
    if (!answer.ok) {
      toast(answer.message ?? "The result could not be confirmed. Reload to check the request before trying again.");
      return;
    }
    toast(action === "remind" && answer.sent === false ? "The reminder did not go. Your store's emails for this month may be used." : done);
    router.refresh();
  }

  // One request's refunds read on their own, where the list was cut at its pages (lib/payment-requests.ts,
  // checkRequestRefunds): what each check said, kept on this page; the list itself never reads a payment on its own.
  const [refundChecks, setRefundChecks] = useState<Record<string, RefundCheckReply>>({});
  async function checkRefunds(id: string) {
    if (busy) return;
    setBusy(`refunds:${id}`);
    let answer: RefundCheckReply;
    try {
      const response = await fetch("/api/store/payment-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "refunds", id }) });
      answer = refundCheckReply(response.ok, await response.json().catch(() => null));
    } catch {
      answer = { checked: false, message: REFUND_CHECK_UNREAD };
    }
    setBusy("");
    setRefundChecks((all) => ({ ...all, [id]: answer }));
    // Said at once as every action's result is (the toast's live region), and kept beside the request in words.
    toast(answer.checked ? "Refunds checked on Stripe." : answer.message);
  }
  // A check kept on this page stands only over the row it was made for: router.refresh() keeps this state but
  // brings newer rows, and a server row that is no longer paid and unchecked (refunded in full, or checked on its
  // own since) or whose floor is above what the check said knows more, so the server's row is shown instead.
  const checkHolds = (r: RequestRow): boolean => {
    const seen = refundChecks[r.id];
    return !!seen?.checked && r.state === "paid" && !r.refundsChecked && seen.refunded >= r.refunded;
  };
  // A request as last checked on its own: what Stripe said, once it said it whole.
  const asChecked = (r: RequestRow): RequestRow => {
    const seen = refundChecks[r.id];
    return seen?.checked && checkHolds(r) ? { ...r, state: seen.state, refunded: seen.refunded, refundsChecked: true, refundsRetry: false, refundsOnDemand: false } : r;
  };
  const checkShown = new Set(given.filter(checkHolds).map((r) => r.id));
  const rows = given.map(asChecked);

  // Paid outside Stripe (639 [GL7](30)): which request's form is open, and what it says.
  const [outsideFor, setOutsideFor] = useState("");
  const [outsideMethod, setOutsideMethod] = useState<"cash" | "transfer" | "other">("transfer");
  const [outsideDate, setOutsideDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [outsideNote, setOutsideNote] = useState("");

  async function markOutside(id: string) {
    if (busy) return;
    setBusy(`outside:${id}`);
    const answer = await call({ action: "outside", id, method: outsideMethod, date: outsideDate, note: outsideNote });
    setBusy("");
    if (!answer.ok) {
      toast(answer.message ?? "The result could not be confirmed. Reload to check the request before trying again.");
      router.refresh();
      return;
    }
    setOutsideFor("");
    setOutsideNote("");
    toast("Marked as paid. Its page now shows it as paid, as the buyer's receipt.");
    router.refresh();
  }

  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((all) => all.map((line, j) => (j === i ? { ...line, ...patch } : line)));

  return (
    <div className="mt-8 space-y-8">
      {canSend ? (
        <form onSubmit={create} className="card p-6 sm:p-8" noValidate>
          {/* Nothing in it can change while it is being sent. */}
          <fieldset disabled={busy !== ""} className="m-0 min-w-0 border-0 p-0">
          <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">New payment request</h2>
          <p className="mt-2 max-w-2xl text-ink-soft">
            For one person who agreed to pay you: a client, a brand, a student. They get one email from your store&apos;s name with a link to a page
            that shows what it is for and the total, and pay on Stripe&apos;s page, to your own Stripe account. Nothing is added to what they pay
            {taxOn ? ", except sales tax where your Stripe Tax collects it" : ""}. {shareWords}
          </p>
          {!open ? <p className="notice notice-error mt-4" role="alert">{closedWhy}</p> : null}
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-semibold text-ink">Their email</span>
              <input id="pr-email" className="field mt-1" type="email" autoComplete="off" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-sm font-semibold text-ink">Their name (optional)</span>
              <input id="pr-name" className="field mt-1" maxLength={MAX_NAME} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
          <fieldset className="mt-6">
            <legend className="text-sm font-semibold text-ink">What it is for</legend>
            <div className="mt-2 space-y-3">
              {lines.map((line, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_9rem_auto] sm:items-end">
                  <label className="block min-w-0">
                    <span className="sr-only">{`Line ${i + 1}: what it is for`}</span>
                    <input id={`pr-line-${i}`} className="field" placeholder="Coaching, October (4 sessions)" maxLength={MAX_LINE_TEXT} value={line.text} onChange={(e) => setLine(i, { text: e.target.value })} />
                  </label>
                  <label className="block">
                    <span className="text-xs text-ink-soft">Quantity</span>
                    <input className="field" inputMode="numeric" value={line.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label={`Line ${i + 1}: quantity, 1 to ${MAX_QUANTITY}`} />
                  </label>
                  <label className="block">
                    <span className="text-xs text-ink-soft">{`Each, ${fieldPrefix(currency)}`}</span>
                    <input className="field" inputMode="decimal" placeholder="120" value={line.amount} onChange={(e) => setLine(i, { amount: e.target.value })} aria-label={`Line ${i + 1}: amount each`} />
                  </label>
                  {lines.length > 1 ? (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLines((all) => all.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
                      <Icon name="minus" size={16} />
                    </button>
                  ) : <span />}
                </div>
              ))}
            </div>
            {lines.length < MAX_LINES ? (
              <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => setLines((all) => [...all, { text: "", quantity: "1", amount: "" }])}>
                <Icon name="plus" size={16} /> Add a line
              </button>
            ) : null}
            <p className="mt-3 font-semibold tabular-nums text-ink">{`Total: ${money(total)}`}</p>
            <p className="text-xs text-ink-soft">{`From ${money(min)} to ${money(max)} for one request, up to ${MAX_LINES} lines.`}</p>
          </fieldset>
          <label className="mt-5 block">
            <span className="text-sm font-semibold text-ink">A note for them (optional)</span>
            <textarea id="pr-note" className="field mt-1 min-h-24" maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-semibold text-ink">Due date (optional)</span>
              <input id="pr-due" className="field mt-1" type="date" min={dueFirst} max={dueLast} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              <span className="mt-1 block text-xs text-ink-soft">{`Shown as a date, nothing more. The link takes payment for ${OPEN_DAYS} days.`}</span>
            </label>
            <label className="block">
              <span className="text-sm font-semibold text-ink">If it is not paid</span>
              <select id="pr-reminders" className="field mt-1" value={reminders} onChange={(e) => setReminders(Number(e.target.value))}>
                <option value={0}>Send no reminder</option>
                {Array.from({ length: MAX_AUTO_REMINDERS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n === 1 ? `One reminder, ${REMIND_EVERY_DAYS} days later` : `Up to ${n} reminders, ${REMIND_EVERY_DAYS} days apart`}</option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-ink-soft">None after it is paid, canceled or expired.</span>
            </label>
          </div>
          <p className="mt-5 text-sm text-ink-soft">
            {`Each email, the request and each reminder, is one of your store's emails for this month: ${emails.used.toLocaleString("en-US")} of ${emails.limit.toLocaleString("en-US")} used. Open requests: ${openNow.toLocaleString("en-US")} of ${limits.open.toLocaleString("en-US")}.`}
          </p>
          <label className="mt-4 flex items-start gap-3">
            <input id="pr-consent" type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span className="text-sm text-ink">This person agreed to pay me for what this request lists, and expects it.</span>
          </label>
          {error && !reviewing && (errorFor === null || errorFor === snapshot) ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}
          <button type="submit" className={reviewing ? "btn btn-secondary mt-5" : "btn btn-primary mt-5"} disabled={!open || busy !== ""}>
            Check before sending
          </button>
          {reviewing && reviewed ? (
            <div className="mt-5 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink">
              <h3 id="pr-review-title" tabIndex={-1} className="font-semibold">Check before it goes out</h3>
              {/* A summary list (GOV.UK "Check answers"): one email goes to this person as soon as it is sent. */}
              <dl className="mt-2 divide-y divide-line">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <dt className="basis-full font-semibold sm:basis-32 sm:shrink-0">To</dt>
                  <dd className="min-w-0 basis-full whitespace-pre-line break-words sm:basis-0 sm:flex-1">{reviewed.name ? `${reviewed.name}, ${reviewed.email}` : reviewed.email}</dd>
                  <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changeAnswer("pr-email")}>Change<span className="sr-only"> who it goes to</span></button></dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <dt className="basis-full font-semibold sm:basis-32 sm:shrink-0">Total</dt>
                  <dd className="min-w-0 basis-full whitespace-pre-line break-words sm:basis-0 sm:flex-1">{money(reviewed.total)}</dd>
                  <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changeAnswer("pr-line-0")}>Change<span className="sr-only"> the total</span></button></dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <dt className="basis-full font-semibold sm:basis-32 sm:shrink-0">What it is for</dt>
                  <dd className="min-w-0 basis-full whitespace-pre-line break-words sm:basis-0 sm:flex-1">{reviewed.lines.map((line) => `${line.text}: ${line.quantity} × ${money(line.cents)} = ${money(line.quantity * line.cents)}`).join("\n")}</dd>
                  <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changeAnswer("pr-line-0")}>Change<span className="sr-only"> what it is for</span></button></dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <dt className="basis-full font-semibold sm:basis-32 sm:shrink-0">Due date</dt>
                  <dd className="min-w-0 basis-full whitespace-pre-line break-words sm:basis-0 sm:flex-1">{reviewed.dueDate ? dueDay(reviewed.dueDate) : "None"}</dd>
                  <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changeAnswer("pr-due")}>Change<span className="sr-only"> due date</span></button></dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <dt className="basis-full font-semibold sm:basis-32 sm:shrink-0">If it is not paid</dt>
                  <dd className="min-w-0 basis-full whitespace-pre-line break-words sm:basis-0 sm:flex-1">{reviewed.autoReminders === 0 ? "No reminder" : reviewed.autoReminders === 1 ? `One reminder, ${REMIND_EVERY_DAYS} days later` : `Up to ${reviewed.autoReminders} reminders, ${REMIND_EVERY_DAYS} days apart`}</dd>
                  <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changeAnswer("pr-reminders")}>Change<span className="sr-only"> reminders</span></button></dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <dt className="basis-full font-semibold sm:basis-32 sm:shrink-0">Note</dt>
                  <dd className="min-w-0 basis-full whitespace-pre-line break-words sm:basis-0 sm:flex-1">{reviewed.note || "No note"}</dd>
                  <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changeAnswer("pr-note")}>Change<span className="sr-only"> note</span></button></dd>
                </div>
              </dl>
              {error ? <p id="pr-send-error" tabIndex={-1} className="notice notice-error mt-3" role="alert">{error}</p> : null}
              <button type="button" className="btn btn-primary mt-3" disabled={!open || busy !== ""} aria-busy={busy === "create"} onClick={() => void send()}>
                {busy === "create" ? "Sending..." : "Yes, send the request"}
              </button>
            </div>
          ) : null}

          </fieldset>
        </form>
      ) : (
        <p className="notice">Only the owner and admins can send payment requests. You can see them here.</p>
      )}

      <section aria-labelledby="requests-heading">
        <h2 id="requests-heading" className="text-lg font-semibold tracking-[-0.02em] text-ink">{`Requests (${rows.length.toLocaleString("en-US")} of ${limits.kept.toLocaleString("en-US")} kept)`}</h2>
        {rows.length === 0 ? <StudioEmptyState title="No payment requests yet" body="A request you send shows here, with whether it was paid." action={canSend && open ? { href: "#pr-email", label: "Write your first payment request" } : undefined} className="mt-3" /> : null}
        {rows.some((r) => !r.refundsChecked) ? (
          // A reload is promised only where reading again may change the answer (lib/payment-requests.ts, refundsRetry).
          rows.some((r) => !r.refundsChecked && r.refundsRetry) ? (
            <p role="status" className="notice mt-3">
              Refunds on Stripe could not all be checked just now, so a request marked &quot;Paid, refunds not checked&quot; may have been refunded, in part or in full. Reload this page to check again, or look the payment up in your Stripe dashboard.
            </p>
          ) : (
            <p role="status" className="notice mt-3">
              Refunds on Stripe could not all be checked here, so a request marked &quot;Paid, refunds not checked&quot; may have been refunded, in part or in full.
              {rows.some((r) => !r.refundsChecked && r.refundsOnDemand)
                ? " Your Stripe account has more refunds than this list reads at once: use \"Check refunds for this payment\" on a request to read its own, or look the payment up in your Stripe dashboard."
                : " Look the payment up in your Stripe dashboard to see its refunds."}
            </p>
          )
        ) : null}
        <ul className="mt-4 space-y-3">
          {rows.map((r) => {
            const status = statusOf(r, now);
            const refundCheck = refundChecks[r.id];
            // Paid on Stripe, but its refunds were not all read: never shown as surely not refunded.
            const unchecked = status === "paid" && !r.refundsChecked;
            const next = nextReminderAt(r, now);
            const again = canSendAgain(r, now);
            // Each request in the currency it was made in: the store may have changed its own since (22 [E5], unit 2c).
            const its = (cents: number) => formatMoney(cents, r.currency);
            return (
              <li key={r.id} className="card p-4 sm:p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-semibold text-ink [overflow-wrap:anywhere]">{r.name ? `${r.name} · ${r.email}` : r.email}</p>
                  <p className="flex items-center gap-2">
                    <span className="font-semibold tabular-nums text-ink">{its(r.total)}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${unchecked ? TONES.expired : TONES[status]}`}>{unchecked ? "Paid, refunds not checked" : STATUS_WORDS[status]}</span>
                  </p>
                </div>
                <p className="mt-1 text-sm text-ink-soft [overflow-wrap:anywhere]">{r.lines.map((l) => (l.quantity > 1 ? `${l.text} × ${l.quantity}` : l.text)).join(" · ")}</p>
                <p className="mt-1 text-xs text-ink-soft">
                  {[
                    `Made ${day(r.createdAt)}`,
                    r.dueDate ? `due ${dueDay(r.dueDate)}` : "",
                    status === "open" ? `link works until ${day(r.expiresAt)}` : "",
                    r.sent.length ? `emailed ${r.sent.length} of ${MAX_SENDS} times, last ${day(r.sent[r.sent.length - 1])}` : "not emailed yet",
                    next !== null ? `next reminder ${day(next)}` : "",
                    status === "paid" || status === "refunded" ? `paid ${its(r.amountPaid || r.total)} on ${day(r.paidAt)}${r.outside ? ` outside Stripe (${OUTSIDE_WORDS[r.outside.method]}${r.outside.note ? `: ${r.outside.note}` : ""})` : ""}` : "",
                    r.refunded > 0 ? (unchecked ? `at least ${its(r.refunded)} refunded` : `${its(r.refunded)} refunded`) : "",
                  ].filter(Boolean).join(" · ")}
                </p>
                {r.failed && status === "open" ? <p className="mt-1 text-xs font-semibold text-danger">{r.failed}</p> : null}
                {unchecked && refundCheck && !refundCheck.checked ? <p className="mt-1 text-sm text-ink [overflow-wrap:anywhere]">{refundCheck.message}</p> : null}
                {refundCheck?.checked && checkShown.has(r.id) && status !== "open" ?<p className="mt-1 text-sm text-ink">{`Refunds checked on Stripe: ${refundCheck.refunded > 0 ? `${its(refundCheck.refunded)} refunded` : "none"}.`}</p> : null}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(r.link);
                        toast("Link copied.");
                      } catch {
                        toast(r.link);
                      }
                    }}
                  >
                    <Icon name="copy" size={15} /> Copy link
                  </button>
                  {unchecked && r.refundsOnDemand ? (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== ""} aria-busy={busy === `refunds:${r.id}`} aria-describedby={`refunds-why-${r.id}`} onClick={() => void checkRefunds(r.id)}>
                      Check refunds for this payment
                    </button>
                  ) : null}
                  {unchecked && r.refundsOnDemand ? <span id={`refunds-why-${r.id}`} className="sr-only">Reads this one payment&apos;s refunds on your Stripe account.</span> : null}
                  {canSend && status === "open" ? (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={!again.ok || !open || busy !== ""} title={again.ok ? "" : again.why} onClick={() => void act("remind", r.id, "Reminder sent.")}>
                      <Icon name="mail" size={15} /> Send a reminder
                    </button>
                  ) : null}
                  {canSend && status === "open" ? (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== ""} onClick={() => void act("cancel", r.id, "Request canceled. Its link no longer takes payment.")}>
                      Cancel
                    </button>
                  ) : null}
                  {canSend && r.state === "open" ? (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== ""} aria-expanded={outsideFor === r.id} aria-controls={`outside-${r.id}`} onClick={() => setOutsideFor(outsideFor === r.id ? "" : r.id)}>
                      Mark as paid outside Stripe
                    </button>
                  ) : null}
                  {canSend && status !== "open" ? (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== ""} onClick={() => void act("delete", r.id, "Request deleted. Any payment stays on your Stripe account.")} aria-label={`Delete the request to ${r.email}`}>
                      <Icon name="trash" size={15} /> Delete
                    </button>
                  ) : null}
                  {status === "open" && !again.ok && canSend ? <span className="text-xs text-ink-soft">{again.why}</span> : null}
                </div>
                {outsideFor === r.id && r.state === "open" ? (
                  <fieldset id={`outside-${r.id}`} className="mt-3 rounded-[10px] px-4 py-3 ring-1 ring-line" disabled={busy !== ""}>
                    <legend className="px-1 text-sm font-semibold text-ink">{`Paid outside Stripe: ${its(r.total)}`}</legend>
                    <p className="text-xs text-ink-soft">
                      For money you received yourself. Nothing is charged; its payment page closes, and if the buyer already paid there it is marked as paid online instead. The request&apos;s page then shows it as paid, as their receipt.
                    </p>
                    <div className="mt-2 grid gap-3 sm:grid-cols-3">
                      <label className="block" htmlFor={`outside-method-${r.id}`}>
                        <span className="field-label">How</span>
                        <select id={`outside-method-${r.id}`} className="field" value={outsideMethod} onChange={(e) => setOutsideMethod(e.target.value as "cash" | "transfer" | "other")}>
                          <option value="transfer">{OUTSIDE_WORDS.transfer}</option>
                          <option value="cash">{OUTSIDE_WORDS.cash}</option>
                          <option value="other">{OUTSIDE_WORDS.other}</option>
                        </select>
                      </label>
                      <label className="block" htmlFor={`outside-date-${r.id}`}>
                        <span className="field-label">Day paid</span>
                        <input id={`outside-date-${r.id}`} type="date" className="field" value={outsideDate} onChange={(e) => setOutsideDate(e.target.value)} />
                      </label>
                      <label className="block" htmlFor={`outside-note-${r.id}`}>
                        <span className="field-label">Note (optional)</span>
                        <input id={`outside-note-${r.id}`} className="field" maxLength={MAX_OUTSIDE_NOTE} value={outsideNote} onChange={(e) => setOutsideNote(e.target.value)} placeholder="Reference or who received it" />
                      </label>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" className="btn btn-primary btn-sm" aria-busy={busy === `outside:${r.id}`} onClick={() => void markOutside(r.id)}>
                        Mark as paid
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOutsideFor("")}>
                        Cancel
                      </button>
                    </div>
                  </fieldset>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
