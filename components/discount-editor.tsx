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

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  none: "This account has no store yet.",
  not_selling:
    "Codes come off a charge, so they need your Stripe account connected and your subscription running.",
  taken: "You already have a live code with that word. Pick another.",
  stripe: "Stripe did not answer just now. Try again in a moment.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Answer = { codes?: DiscountCode[]; problem?: string };

async function send(payload: Record<string, unknown>, currency: Currency): Promise<Answer> {
  try {
    const response = await fetch("/api/store/discount", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data: unknown = await response.json().catch(() => null);
    const codes = readDiscountConfirmation(data, response.ok);
    if (codes !== null) return { codes };
    if (data && typeof data === "object" && Object.hasOwn(data,"ok") && (data as {ok?: unknown}).ok === false && Object.hasOwn(data,"error")) {
      const refusal = data as {error?: unknown;reason?: unknown};
      if (refusal.error === "code" && Object.hasOwn(data,"reason")) {
        const reason = refusal.reason;
        return {problem: reason === "amount" ? amountProblem(currency) : reason === "minimum" ? minimumProblem(currency) : typeof reason === "string" && Object.hasOwn(CODE_PROBLEMS,reason) ? CODE_PROBLEMS[reason as CodeProblem] : CODE_PROBLEMS.shape};
      }
      if (typeof refusal.error === "string" && Object.hasOwn(MESSAGES,refusal.error)) return {problem:MESSAGES[refusal.error]};
    }
    return {problem:"We could not confirm the discount codes. Reload to check their status before trying again."};
  } catch {
    return {problem:"We could not confirm the discount codes. Reload to check their status before trying again."};
  }
}

const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

const whenLabel = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

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
    if (answer.codes) setCodes(answer.codes);
    else setError(answer.problem ?? MESSAGES.server_error);
  }

  async function run(payload: Record<string, unknown>, done: () => void, confirmation: string) {
    setBusy(true);
    setError(null);
    const answer = await send(payload, currency);
    setBusy(false);
    if (!answer.codes) {
      setError(answer.problem ?? MESSAGES.server_error);
      return;
    }
    setCodes(answer.codes);
    done();
    toast(confirmation);
  }

  const live = (codes ?? []).filter((entry) => entry.active);
  const past = (codes ?? []).filter((entry) => !entry.active);

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
                      ? `. Stops on ${whenLabel(entry.expiresAt)}`
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

          {codes !== null && live.length === 0 && !adding ? (
            <p className="mt-5 text-sm text-ink-soft">
              No live code right now. A buyer sees no box to type one into,
              which is how it should be until there is something to type.
            </p>
          ) : null}

          {past.length > 0 ? (
            <p className="mt-4 text-sm text-ink-soft">
              {`${past.length} ${past.length === 1 ? "code is" : "codes are"} switched off, used up or past their date. They stay in your Stripe account, on the receipts they were used on.`}
            </p>
          ) : null}

          {adding ? (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (busy) return;
                run(
                  {
                    action: "add",
                    code,
                    kind,
                    percent,
                    amount,
                    uses,
                    minimum,
                  },
                  () => {
                    setAdding(false);
                    setCode("");
                    setUses("");
                    setMinimum("");
                  },
                  `${code} is live.`,
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
                  {busy ? "Making it…" : "Make the code"}
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
