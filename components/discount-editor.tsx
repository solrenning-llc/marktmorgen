"use client";

import { useState, useSyncExternalStore } from "react";
import {
  CODE_PROBLEMS,
  type CodeProblem,
  type DiscountCode,
  amountProblem,
  codeRules,
  minimumProblem,
  offLabel,
} from "@/lib/discount";
import { type Currency, fieldPrefix } from "@/lib/money";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { readDiscountConfirmation } from "@/lib/discount-confirmation";
import {
  SCHEDULE_PROBLEMS,
  STATE_LABELS,
  type ScheduleEntry,
  type ScheduleProblem,
  type ScheduleState,
  readScheduleConfirmation,
  scheduleState,
} from "@/lib/discount-schedule-rules";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  none: "This account has no store yet.",
  not_selling:
    "Codes come off a charge, so they need your Stripe account connected and your subscription running.",
  taken: "You already have a live code with that word. Pick another.",
  stripe: "Stripe did not answer just now. Try again in a moment.",
  live: "Stripe made this code live right away, and we could not switch it off. Reload this page, then switch it off in your list of live codes.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

/** What a cancel did, as the route says it: "done" (it never started) or "stopped" (it may have started; it is off now). */
type Canceled = "done" | "stopped";

type Answer = { codes?: DiscountCode[]; schedules?: ScheduleEntry[]; at?: number; canceled?: Canceled; problem?: string };

/** The cancel's own answer, read exactly; anything else is no answer. */
const canceledOf = (data: unknown): Canceled | undefined => {
  if (!data || typeof data !== "object" || !Object.hasOwn(data, "canceled")) return undefined;
  const value = (data as { canceled?: unknown }).canceled;
  return value === "done" || value === "stopped" ? value : undefined;
};

/** The message after a cancel, from what the route says it did: never "It stays off" of a code that may have started. */
const canceledMessage = (code: string, canceled: Canceled | undefined) =>
  canceled === "done"
    ? `${code} canceled. It stays off.`
    : canceled === "stopped"
      ? `${code} may have started before you canceled. It is off now.`
      : `${code} is off now.`;

const UNCONFIRMED = "We could not confirm the discount codes. Reload to check their status before trying again.";

async function send(payload: Record<string, unknown>, currency: Currency): Promise<Answer> {
  try {
    const response = await fetch("/api/store/discount", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data: unknown = await response.json().catch(() => null);
    const codes = readDiscountConfirmation(data, response.ok);
    if (codes !== null) {
      // The codes waiting for their start (511 [CK3]): read exactly, or the list is not confirmed.
      const schedules = readScheduleConfirmation(data);
      // The moment it was read, for the states it shows.
      return schedules === null ? { problem: UNCONFIRMED } : { codes, schedules, at: Math.floor(Date.now() / 1000), canceled: canceledOf(data) };
    }
    if (data && typeof data === "object" && Object.hasOwn(data,"ok") && (data as {ok?: unknown}).ok === false && Object.hasOwn(data,"error")) {
      const refusal = data as {error?: unknown;reason?: unknown};
      if (refusal.error === "code" && Object.hasOwn(data,"reason")) {
        const reason = refusal.reason;
        return {problem: reason === "amount" ? amountProblem(currency) : reason === "minimum" ? minimumProblem(currency) : typeof reason === "string" && Object.hasOwn(CODE_PROBLEMS,reason) ? CODE_PROBLEMS[reason as CodeProblem] : CODE_PROBLEMS.shape};
      }
      if (refusal.error === "schedule" && Object.hasOwn(data,"reason") && typeof refusal.reason === "string" && Object.hasOwn(SCHEDULE_PROBLEMS,refusal.reason)) return {problem:SCHEDULE_PROBLEMS[refusal.reason as ScheduleProblem]};
      const told = (data as {message?: unknown}).message;
      if (refusal.error === "studio_used" && typeof told === "string" && told) return {problem:told};
      if (typeof refusal.error === "string" && Object.hasOwn(MESSAGES,refusal.error)) return {problem:MESSAGES[refusal.error]};
    }
    return {problem:UNCONFIRMED};
  } catch {
    return {problem:UNCONFIRMED};
  }
}

const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/** A moment in the creator's own time zone, named: "Nov 27, 2026, 9:00 AM EST". */
const momentLabel = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

/** A local date and time from the form, as whole seconds in the creator's own time zone, or "" when it is not one. */
const secondsOf = (local: string) => {
  const ms = new Date(local).getTime();
  return Number.isFinite(ms) && local ? String(Math.floor(ms / 1000)) : "";
};

/** The creator's time zone, as the browser has it. */
const zoneName = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "your time zone";
  } catch {
    return "your time zone";
  }
};

const STATE_TONE: Record<ScheduleState, string> = {
  scheduled: "border-violet-brand/40 text-violet-deep",
  starting: "border-violet-brand/40 text-violet-deep",
  failed: "border-danger text-ink",
  live: "border-ink text-ink",
  ended: "border-line text-ink-soft",
  off: "border-line text-ink-soft",
};

/** The state in words, in a bordered tag: never by colour alone. */
function StateTag({ state }: { state: ScheduleState }) {
  return (
    <span className={`inline-block rounded-full border-2 px-2.5 py-0.5 text-sm font-bold ${STATE_TONE[state]}`}>
      {STATE_LABELS[state]}
    </span>
  );
}


/**
 * The discount codes on the creator's own Stripe account.
 *
 * The list is fetched rather than passed in, because it is Stripe's list and
 * not ours: asking on the server would make the whole studio wait on a call to
 * Stripe just to draw a page that is mostly about something else.
 */
export function DiscountEditor({ selling, currency = "usd", address = "" }: { selling: boolean; currency?: Currency; address?: string }) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);

  const [codes, setCodes] = useState<DiscountCode[] | null>(null);
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  // The moment the list was read, for its states: read when Stripe answers, not while drawing.
  const [now, setNow] = useState(0);
  const [later, setLater] = useState(false);
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"percent" | "amount">("percent");
  const [percent, setPercent] = useState("20");
  const [amount, setAmount] = useState("10");
  const [uses, setUses] = useState("");
  const [minimum, setMinimum] = useState("");

  const loading = busy && codes === null && error === null;

  // Listing also reconciles the checkout's discount-box flag. Only ask after
  // the creator chooses to load it, never just because settings were opened.
  async function loadCodes() {
    setBusy(true);
    setError(null);
    const answer = await send({ action: "list" }, currency);
    setBusy(false);
    if (answer.codes) {
      setCodes(answer.codes);
      setSchedules(answer.schedules ?? []);
      setNow(answer.at ?? 0);
    } else setError(answer.problem ?? MESSAGES.server_error);
  }

  async function run(payload: Record<string, unknown>, done: () => void, confirmation: string | ((answer: Answer) => string)) {
    setBusy(true);
    setError(null);
    const answer = await send(payload, currency);
    setBusy(false);
    if (!answer.codes) {
      setError(answer.problem ?? MESSAGES.server_error);
      return;
    }
    setCodes(answer.codes);
    setSchedules(answer.schedules ?? []);
    setNow(answer.at ?? 0);
    done();
    toast(typeof confirmation === "string" ? confirmation : confirmation(answer));
  }

  const scheduleOf = new Map(schedules.map((entry) => [entry.id, entry]));
  const live = (codes ?? []).filter((entry) => entry.active);
  const waiting = (codes ?? []).filter((entry) => !entry.active && scheduleOf.has(entry.id));
  const past = (codes ?? []).filter((entry) => !entry.active && !scheduleOf.has(entry.id));

  return (
    <div className="card mt-8 p-6 sm:p-8">
      <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Discount codes</p>

      {!selling ? (
        <p className="mt-2 text-ink-soft">
          A code comes off a charge, so this opens once your Stripe account is
          connected and your subscription is running. The trial counts.
        </p>
      ) : (
        <>
          <p className="mt-2 text-ink-soft">
            A word a buyer types at checkout for money off. The codes live on
            your own Stripe account, so the count of how many times each one has
            been used is Stripe&apos;s count, not ours — and if you ever leave,
            they leave with you.
          </p>

          <button type="button" className="btn btn-secondary btn-sm mt-4" aria-busy={busy} disabled={!ready || busy} onClick={loadCodes}>
            {busy ? "Loading…" : codes === null ? "Load discount codes" : "Refresh discount codes"}
          </button>

          {loading ? (
            <p className="mt-5 text-sm text-ink-soft">Asking Stripe…</p>
          ) : null}

          {live.length > 0 ? (
            <ul className="mt-5 space-y-3">
              {live.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-2xl border border-line bg-paper p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-mono text-lg font-semibold text-ink">
                      {entry.code}
                    </p>
                    <StateTag state={scheduleState(entry, null, now)} />
                    <p className="font-bold text-violet-deep">
                      {entry.off ? offLabel(entry.off) : "Made in Stripe"}
                    </p>
                  </div>
                  {entry.off?.kind === "amount" && entry.off.currency !== currency ? (
                    <p className="mt-2 rounded-xl bg-amber-brand/10 px-3 py-2 text-sm text-ink">
                      {`This code takes off ${entry.off.currency.toUpperCase()}, and your store now charges in ${currency.toUpperCase()}. Stripe only takes it off a checkout in ${entry.off.currency.toUpperCase()}, so buyers cannot use it now. Switch it off and make a new one.`}
                    </p>
                  ) : null}
                  {entry.minimum && entry.minimum.currency !== currency ? (
                    <p className="mt-2 rounded-xl bg-amber-brand/10 px-3 py-2 text-sm text-ink">
                      {`This code's minimum is in ${entry.minimum.currency.toUpperCase()}, and your store now charges in ${currency.toUpperCase()}. Buyers may not be able to use it now. Switch it off and make a new one.`}
                    </p>
                  ) : null}
                  {codeRules(entry).map((rule) => (
                    <p key={rule} className="mt-1 text-sm text-ink">{rule}</p>
                  ))}
                  <p className="mt-1 text-sm text-ink-soft">
                    {`Used ${entry.timesRedeemed} ${
                      entry.timesRedeemed === 1 ? "time" : "times"
                    }`}
                    {entry.maxRedemptions !== null
                      ? ` of ${entry.maxRedemptions}`
                      : ""}
                    {entry.expiresAt !== null
                      ? `. Ends ${momentLabel(entry.expiresAt)}`
                      : ""}
                    .
                  </p>
                  {address ? (
                    /*
                      The code as a link (lib/code-link.ts): whoever opens it
                      has the code applied at checkout without typing it, on
                      the store and on any product's page, for a week.
                    */
                    <p className="mt-2 text-sm text-ink-soft">
                      Share it as a link and it applies itself at checkout:{" "}
                      <span className="break-all font-mono text-ink">{`${address}?code=${entry.code}`}</span>
                      {". Add "}
                      <span className="font-mono text-ink">{`?code=${entry.code}`}</span>
                      {" to any of your product links, too."}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    aria-busy={busy} disabled={busy}
                    onClick={() => run({ action: "stop", id: entry.id }, () => {}, `${entry.code} switched off.`)}
                    className="mt-2 text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-danger disabled:no-underline disabled:opacity-40"
                  >
                    Switch it off
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {waiting.length > 0 ? (
            <>
              <h3 className="mt-6 text-base font-semibold text-ink">Waiting for their start</h3>
              <ul className="mt-3 space-y-3">
                {waiting.map((entry) => {
                  const plan = scheduleOf.get(entry.id)!;
                  const state = scheduleState(entry, plan, now);
                  return (
                    <li key={entry.id} className="rounded-2xl border border-line bg-paper p-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="font-mono text-lg font-semibold text-ink">{entry.code}</p>
                        <StateTag state={state} />
                        <p className="font-bold text-violet-deep">{entry.off ? offLabel(entry.off) : "Made in Stripe"}</p>
                      </div>
                      <p className="mt-1 text-sm text-ink">{`Starts ${momentLabel(plan.start)}. Ends ${momentLabel(plan.end)}.`}</p>
                      {state === "scheduled" ? (
                        <p className="mt-1 text-sm text-ink-soft">Buyers cannot use it yet. It switches on by itself at its start, within five minutes.</p>
                      ) : null}
                      {state === "starting" ? (
                        <p className="mt-1 text-sm text-ink-soft">Its start has come. It switches on within a few minutes; refresh to check.</p>
                      ) : null}
                      {state === "failed" ? (
                        <p role="alert" className="mt-2 rounded-xl bg-danger-soft px-3 py-2 text-sm font-semibold text-ink">
                          We could not switch this code on at its start. It is still off, so buyers cannot use it. Cancel it and make it again, or switch it on in your Stripe dashboard.
                        </p>
                      ) : null}
                      <button
                        type="button"
                        aria-busy={busy} disabled={busy}
                        onClick={() => run({ action: "unschedule", id: entry.id }, () => {}, (answer) => canceledMessage(entry.code, answer.canceled))}
                        className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-danger disabled:no-underline disabled:opacity-40"
                      >
                        {`Cancel ${entry.code}`}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}

          {codes !== null && live.length === 0 && !adding ? (
            <p className="mt-5 text-sm text-ink-soft">
              No live code right now. A buyer sees no box to type one into,
              which is how it should be until there is something to type.
            </p>
          ) : null}

          {past.length > 0 ? (
            <>
              <p className="mt-4 text-sm text-ink-soft">
                {`${past.length} ${past.length === 1 ? "code is" : "codes are"} switched off, used up or past their date. They stay in your Stripe account, on the receipts they were used on.`}
              </p>
              <ul className="mt-2 space-y-1">
                {past.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                    <span className="font-mono text-ink">{entry.code}</span>
                    <StateTag state={scheduleState(entry, null, now)} />
                    {entry.expiresAt !== null && entry.expiresAt <= now ? <span>{`Ended ${momentLabel(entry.expiresAt)}`}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {adding ? (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (busy) return;
                run(
                  {
                    action: later ? "schedule" : "add",
                    code,
                    kind,
                    percent,
                    amount,
                    uses,
                    minimum,
                    ...(later ? { start: secondsOf(startAt), end: secondsOf(endAt) } : {}),
                  },
                  () => {
                    setAdding(false);
                    setCode("");
                    setUses("");
                    setMinimum("");
                    setLater(false);
                    setStartAt("");
                    setEndAt("");
                  },
                  later ? `${code} is scheduled. It stays off until its start.` : `${code} is live.`,
                );
              }}
              className="mt-5 space-y-4 rounded-2xl border-2 border-violet-brand/30 bg-white p-4"
            >
              <div>
                <label
                  htmlFor="discount-code"
                  className="field-label"
                >
                  The code
                </label>
                <input
                  id="discount-code"
                  type="text"
                  required
                  maxLength={24}
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.toUpperCase())
                  }
                  placeholder="LAUNCH20"
                  className="field mt-1"
                />
                <p className="mt-1 text-sm text-ink-soft">
                  Letters, numbers and dashes. A buyer can type it in any case.
                </p>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label
                    htmlFor="discount-kind"
                    className="field-label"
                  >
                    What it takes off
                  </label>
                  <select
                    id="discount-kind"
                    value={kind}
                    onChange={(event) =>
                      setKind(event.target.value === "amount" ? "amount" : "percent")
                    }
                    className="field mt-1"
                  >
                    <option value="percent">A percentage</option>
                    <option value="amount">An amount</option>
                  </select>
                </div>
                <div className={kind === "amount" && currency !== "usd" ? "w-36" : "w-28"}>
                  <label
                    htmlFor="discount-value"
                    className="field-label"
                  >
                    {kind === "percent" ? "Percent" : currency === "usd" ? "Dollars" : `Amount, ${fieldPrefix(currency)}`}
                  </label>
                  <input
                    id="discount-value"
                    type="text"
                    inputMode={kind === "amount" && currency === "jpy" ? "numeric" : "decimal"}
                    required
                    value={kind === "percent" ? percent : amount}
                    onChange={(event) =>
                      kind === "percent"
                        ? setPercent(event.target.value)
                        : setAmount(event.target.value)
                    }
                    className="field mt-1"
                  />
                </div>
                <div className="w-36">
                  <label
                    htmlFor="discount-uses"
                    className="field-label"
                  >
                    Uses, at most
                  </label>
                  <input
                    id="discount-uses"
                    type="text"
                    inputMode="numeric"
                    value={uses}
                    onChange={(event) => setUses(event.target.value)}
                    placeholder="No limit"
                    className="field mt-1"
                  />
                </div>
                <div className="w-44">
                  <label
                    htmlFor="discount-minimum"
                    className="field-label"
                  >
                    {currency === "usd" ? "Minimum order, dollars" : `Minimum order, ${fieldPrefix(currency)}`}
                  </label>
                  <input
                    id="discount-minimum"
                    type="text"
                    inputMode={currency === "jpy" ? "numeric" : "decimal"}
                    value={minimum}
                    onChange={(event) => setMinimum(event.target.value)}
                    placeholder="No minimum"
                    aria-describedby="discount-minimum-help"
                    className="field mt-1"
                  />
                </div>
              </div>
              <p id="discount-minimum-help" className="text-sm text-ink-soft">
                Optional. With a minimum, Stripe takes the code only when the first payment comes to that much or more. On a membership with a free trial the first payment is zero, so the code does not come off; on a payment plan it is the first installment.
              </p>

              <fieldset className="space-y-3">
                <legend className="field-label">When it works</legend>
                <label className="flex min-h-11 items-center gap-3 text-ink">
                  <input
                    type="checkbox"
                    checked={later}
                    onChange={(event) => setLater(event.target.checked)}
                    aria-describedby="discount-when-help"
                    className="h-6 w-6"
                  />
                  Start and end it at set times
                </label>
                <p id="discount-when-help" className="text-sm text-ink-soft">
                  {later
                    ? `It is made now, switched off, and switches on by itself at the start, within five minutes. Stripe stops it at the end. Times are in your time zone, ${zoneName()}.`
                    : "Without set times, it works as soon as you make it, until you switch it off."}
                </p>
                {later ? (
                  <div className="flex flex-wrap gap-3">
                    <div>
                      <label htmlFor="discount-start" className="field-label">Starts</label>
                      <input
                        id="discount-start"
                        type="datetime-local"
                        required
                        value={startAt}
                        onChange={(event) => setStartAt(event.target.value)}
                        className="field mt-1"
                      />
                    </div>
                    <div>
                      <label htmlFor="discount-end" className="field-label">Ends</label>
                      <input
                        id="discount-end"
                        type="datetime-local"
                        required
                        value={endAt}
                        onChange={(event) => setEndAt(event.target.value)}
                        className="field mt-1"
                      />
                    </div>
                  </div>
                ) : null}
              </fieldset>

              <p className="text-sm text-ink-soft">
                It comes off the payment it is typed into. On a membership that
                is the first charge, not every renewal. A code made here works on
                every product: your products are not saved as products in Stripe,
                so Stripe cannot limit a code to some of them.
              </p>

              {error ? (
                <p
                  role="alert"
                  className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-ink"
                >
                  {error}
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  aria-busy={busy} disabled={busy}
                  className="btn btn-primary"
                >
                  {busy ? "Making it…" : later ? "Schedule the code" : "Make the code"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setError(null);
                  }}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setAdding(true);
                  setError(null);
                }}
                className="btn btn-primary mt-5"
              >
                Make a code
              </button>
              {error ? (
                <p
                  role="alert"
                  className="mt-3 rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-ink"
                >
                  {error}
                </p>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
