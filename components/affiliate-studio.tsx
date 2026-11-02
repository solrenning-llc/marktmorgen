"use client";

import Link from "next/link";
import { AffiliateCommissionHistory } from "@/components/affiliate-commission-history";
import type { AffiliateCommissionLine as LineView } from "@/lib/affiliate-commission-view";

import { useState } from "react";
import { EmailInput } from "@/components/email-input";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { StoreCurrency, useStoreCurrency } from "@/components/store-currency";
import { type Currency, fieldPrefix, formatMoney, moneyField, readMoney } from "@/lib/money";
import {
  type AffiliateSetting,
  type AttributionRule,
  MAX_COMMISSION,
  MAX_COOKIE_DAYS,
  MAX_HOLD_DAYS,
  MAX_PAYDAY,
  MIN_COMMISSION,
  MIN_COOKIE_DAYS,
  MAX_BONUSES,
  MAX_BONUS_SALES,
  RECURRING_ALWAYS,
  RECURRING_OPTIONS,
  SECOND_TIER_OPTIONS,
  commissionRate,
  ordinal,
} from "@/lib/affiliate-setting";
import {
  MAX_COMMITTED_SHARE,
  MAX_PARTNER_SHARE,
  MIN_PARTNER_SHARE,
  SHARE_PROBLEMS,
  creatorKeeps,
} from "@/lib/partner-share";
import type { Affiliate, AffiliateStatus, HoldFlag, Payout } from "@/lib/affiliates";
import { StoreField } from "@/components/studio-store-pin";
import { LeadReview, type LeadRow, LeadTerms, type LeadTermsState } from "@/components/affiliate-leads-studio";
import { MAX_LEAD_BUDGET_CENTS, MAX_LEAD_CAP, MAX_LEAD_CENTS, MAX_LEAD_HOLD_DAYS, MIN_LEAD_BUDGET_CENTS, MIN_LEAD_CENTS, MIN_LEAD_HOLD_DAYS } from "@/lib/affiliate-lead-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { NewTab } from "@/components/new-tab";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  percent: `Type a whole share from ${MIN_COMMISSION} to ${MAX_COMMISSION} percent.`,
  days: `Type a whole number of days from ${MIN_COOKIE_DAYS} to ${MAX_COOKIE_DAYS}.`,
  rate: `A product's own share is a whole number from 0 to ${MAX_COMMISSION}; 0 leaves it out.`,
  rule: "Pick whether the first or the last link a buyer followed earns the sale.",
  share_percent: SHARE_PROBLEMS.percent,
  share_products: SHARE_PROBLEMS.products,
  share_crowded: SHARE_PROBLEMS.crowded,
  share_committed: SHARE_PROBLEMS.committed,
  invite_email: "Type the email address to send the invitation to.",
  gone: "That offer is no longer there. The store may have withdrawn it.",
  owner: "That is your own address. A partner is somebody else.",
  full: "This program is full. Remove somebody before inviting another partner.",
  promo: "That discount code is no longer on your Stripe account. Reload the page.",
  payday: `Pick a day from the 1st to the ${MAX_PAYDAY}th, or no fixed day.`,
  hold: `Type a whole number of days from 0 to ${MAX_HOLD_DAYS}.`,
  recurring: "Pick how long a membership earns.",
  tier: "Pick a second tier from the list.",
  bonus: `A bonus needs a number of sales from 1 to ${MAX_BONUS_SALES} and an amount from 1 to 10,000, each number of sales once.`,
  amount: "Type the amount you paid, like 25 or 25.50.",
  date: "Pick the day you paid it.",
  nothing: "Nobody is owed anything right now, so there was nothing to write down.",
  refunds:
    "Stripe could not be asked about refunds just now, so what is owed is not settled. Try again in a moment rather than record a payout against a guess.",
  unknown: "That affiliate or payout is no longer on record. Reload the page.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  store_full: "Your store is full. Remove something before adding more.",
  server_error: "Something went wrong on our side. Try again in a moment.",
  lead_kind: "Pick what counts as a lead, or no pay per lead.",
  lead_amount: `Type an amount per lead from ${MIN_LEAD_CENTS / 100} to ${MAX_LEAD_CENTS / 100}.`,
  lead_hold: `Type a whole number of days in hold from ${MIN_LEAD_HOLD_DAYS} to ${MAX_LEAD_HOLD_DAYS}.`,
  lead_daily: `Type how many leads earn per affiliate a day, from 1 to ${MAX_LEAD_CAP}.`,
  lead_budget: `Type a monthly budget from ${MIN_LEAD_BUDGET_CENTS / 100} to ${(MAX_LEAD_BUDGET_CENTS / 100).toLocaleString("en-US")}, and at least one lead's amount.`,
};

/** One of the creator's live discount codes, as this screen needs it. */
export type StoreCode = {
  /** Stripe's promotion code id, which is what a code is given away by. */
  id: string;
  /** The word a buyer types. */
  code: string;
  /** What it takes off, in words: "20% off", "$10 off". */
  label: string;
};

type Row = {
  affiliate: Affiliate;
  clicks: number;
  sales: number;
  earned: number;
  paid: number;
  owed: number;
  /** Of what is owed, the part still inside the creator's wait. */
  waiting: number;
  /** What a batch can pay today: owed, less what is still waiting. */
  payable: number;
  /** Held for the creator to look at, and why (lib/affiliates.ts holdFlags). */
  held: number;
  flags: HoldFlag[];
  paidClicks: number;
  link: string;
};

/** An amount in the currency it was paid in (lib/money.ts). */
const money = (cents: number, currency: string) => `${cents < 0 ? "-" : ""}${formatMoney(Math.abs(cents), currency)}`;
const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const dayMs = (ms: number) => day(Math.floor(ms / 1000));

const STATUS_TAG: Record<AffiliateStatus, { label: string; tone: string }> = {
  approved: { label: "Approved", tone: "tag-live" },
  pending: { label: "Waiting for you", tone: "tag-next" },
  declined: { label: "Declined", tone: "" },
  removed: { label: "Removed", tone: "" },
};

async function post(payload: Record<string, unknown>): Promise<string | null> {
  try {
    const response = await fetch("/api/store/affiliates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (data.ok) return null;
    return MESSAGES[data.error ?? ""] ?? MESSAGES.server_error;
  } catch {
    return MESSAGES.server_error;
  }
}

/**
 * Writing down a whole batch the creator has just paid in their own provider.
 * Separate from `post` because it answers with how many payouts it wrote, and
 * because it is the one call that touches several affiliates at once.
 */
async function postBatch(payload: Record<string, unknown>): Promise<{ written: number } | { error: string }> {
  try {
    const response = await fetch("/api/store/affiliates/payout-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; written?: number };
    if (data.ok) return { written: Number(data.written) || 0 };
    return { error: MESSAGES[data.error ?? ""] ?? MESSAGES.server_error };
  } catch {
    return { error: MESSAGES.server_error };
  }
}

/** The studio's affiliate programme: terms, applications, the book and payouts. */
export function AffiliateStudio({
  handle,
  setting,
  products,
  rows,
  lines,
  linesTotal,
  payouts,
  refundsChecked,
  invoicesChecked = true,
  today,
  currency = "usd",
  elsewhere = 0,
  away = [],
  pendingPayoutsChecked = true,
  codes = [],
  codeOwners = {},
  payPanel = null,
  leads = [],
  leadsTotal = 0,
}: {
  handle: string;
  setting: AffiliateSetting;
  products: { id: string; title: string; credited: boolean; recurring?: boolean }[];
  rows: Row[];
  lines: LineView[];
  linesTotal?: number | null;
  payouts: Payout[];
  refundsChecked: boolean;
  /** False when the invoices of memberships and plans could not all be read. */
  invoicesChecked?: boolean;
  today: string;
  /** The store's currency: what the totals and new payouts are in. */
  currency?: Currency;
  /** Sales and payouts in another currency, left out of the totals. */
  elsewhere?: number;
  /** Affiliates with a PayPal payment on its way (lib/paypal-payouts.ts): not in any new batch. */
  away?: string[];
  /** False when pending provider payments could not be confirmed. */
  pendingPayoutsChecked?: boolean;
  /** The creator's own live discount codes, any of which can be given to an affiliate. */
  codes?: StoreCode[];
  /** Which affiliate holds each of those codes, by Stripe's promotion code id. */
  codeOwners?: Record<string, string>;
  /** Paying from the creator's own PayPal (components/paypal-payouts.tsx), shown above the files. */
  payPanel?: React.ReactNode;
  /** Confirmed leads, newest first (lib/affiliate-leads.ts), and how many there are in all. */
  leads?: LeadRow[];
  leadsTotal?: number;
}) {
  const router = useRouter();
  const pending = rows.filter((r) => r.affiliate.status === "pending");
  const members = rows.filter((r) => r.affiliate.status !== "pending");
  const who = new Map(rows.map((r) => [r.affiliate.id, r.affiliate]));
  const owedTotal = rows.reduce((sum, r) => sum + Math.max(0, r.owed), 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ where: string; text: string } | null>(null);
  // Everyone who can be paid today: what one batch file holds. A sale still
  // inside the wait is owed but not payable, so the two totals differ while
  // anything is clearing.
  const owedNow = pendingPayoutsChecked ? rows.filter((r) => r.payable > 0 && r.affiliate.status === "approved" && !away.includes(r.affiliate.id)) : [];
  const batchTotal = owedNow.reduce((sum, r) => sum + r.payable, 0);
  const waitingTotal = rows.reduce((sum, r) => sum + r.waiting, 0);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchDate, setBatchDate] = useState(today);
  const [batchReference, setBatchReference] = useState("");

  async function act(where: string, payload: Record<string, unknown>, confirmation: string): Promise<boolean> {
    setBusy(where);
    setError(null);
    const problem = await post(payload);
    setBusy(null);
    if (problem) {
      setError({ where, text: problem });
      return false;
    }
    toast(confirmation);
    router.refresh();
    return true;
  }

  const errorAt = (where: string) =>
    error?.where === where ? (
      <p className="notice notice-error mt-3" role="alert">
        {error.text}
      </p>
    ) : null;

  return (
    <StoreCurrency value={currency}>
    <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
      <div className="min-w-0 space-y-6">
        <Terms
          handle={handle}
          setting={setting}
          products={products}
          busy={busy === "terms"}
          onSave={(payload, confirmation) => act("terms", payload, confirmation)}
          error={errorAt("terms")}
        />
        <section aria-labelledby="money-title" className="card p-6 sm:p-8">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-mint-soft text-mint-deep">
              <Icon name="bank" size={20} />
            </span>
            <h2 id="money-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
              You pay your affiliates yourself
            </h2>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-ink-soft">
            Marktmorgen never holds, moves or pays out this money. Every sale is paid in full to your own Stripe account, as
            always; this page keeps the record of who is owed what. Pay them however you agree — PayPal, a bank transfer,
            Wise — then write it down here with Mark as paid, and it shows on their page too.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <form action="/api/store/affiliates/export" method="get">
              <StoreField />
              <button type="submit" className="btn btn-secondary btn-sm">
                <Icon name="download" size={16} />
                Download everything (CSV)
              </button>
            </form>
            <span className="text-sm text-ink-soft">{`Owed now, in all: ${money(owedTotal, currency)}`}</span>
          </div>
          {pendingPayoutsChecked ? payPanel : <p className="notice notice-warn mt-5" role="alert">Pending payments could not be checked. New payment batches and batch files are unavailable until you reload and this check succeeds. Your saved records and full export remain available.</p>}
          {owedNow.length ? (
            <div className="mt-5 rounded-2xl border border-line bg-paper p-4">
              <h3 className="font-semibold text-ink">Pay everyone at once</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                {`${owedNow.length} ${owedNow.length === 1 ? "affiliate" : "affiliates"} can be paid ${money(batchTotal, currency)} today. Download the batch, upload it to your own PayPal or Wise, and the money goes straight from your account to theirs. It never passes through Marktmorgen, so there is no payout to wait for.`}
              </p>
              {waitingTotal > 0 ? (
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                  {leadsTotal > 0
                    ? `${money(waitingTotal, currency)} more is still inside your ${setting.hold}-day wait, or is leads in hold or waiting for your approval, and is not in this file. It joins the next one once that time has passed and you have approved the leads.`
                    : `${money(waitingTotal, currency)} more is still inside your ${setting.hold}-day wait and is not in this file. It joins the next one once that time has passed.`}
                </p>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-3">
                <form action="/api/store/affiliates/payout-batch" method="get">
                  <StoreField />
                  <input type="hidden" name="provider" value="paypal" />
                  <button type="submit" className="btn btn-secondary btn-sm">
                    <Icon name="download" size={16} />
                    PayPal Payouts file
                  </button>
                </form>
                <form action="/api/store/affiliates/payout-batch" method="get">
                  <StoreField />
                  <input type="hidden" name="provider" value="worksheet" />
                  <button type="submit" className="btn btn-secondary btn-sm">
                    <Icon name="download" size={16} />
                    Worksheet for Wise or a bank
                  </button>
                </form>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-soft">
                The PayPal file uploads as it is. Wise only reads a file built from the template it gives you, so paste the
                worksheet into that template — and fill in the name column yourself: Wise wants the name on your affiliate&rsquo;s
                bank account, and we never asked them for it.
              </p>
              {batchOpen ? (
                <form
                  className="mt-4 rounded-xl border-2 border-violet-brand/30 bg-white p-3"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy("batch");
                    setError(null);
                    const done = await postBatch({ date: batchDate, reference: batchReference });
                    setBusy(null);
                    if ("error" in done) {
                      setError({ where: "batch", text: done.error });
                      return;
                    }
                    setBatchOpen(false);
                    setBatchReference("");
                    toast(`${done.written} ${done.written === 1 ? "payout" : "payouts"} written down.`);
                    router.refresh();
                  }}
                >
                  <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                    <label className="block" htmlFor="batch-d">
                      <span className="field-label">Paid on</span>
                      <input
                        id="batch-d"
                        type="date"
                        value={batchDate}
                        max={today}
                        onChange={(e) => setBatchDate(e.target.value)}
                        className="field"
                        required
                      />
                    </label>
                    <label className="block" htmlFor="batch-r">
                      <span className="field-label">Reference (optional)</span>
                      <input
                        id="batch-r"
                        type="text"
                        maxLength={80}
                        value={batchReference}
                        placeholder="PayPal batch 5TY0..."
                        onChange={(e) => setBatchReference(e.target.value)}
                        className="field"
                      />
                    </label>
                  </div>
                  <p className="mt-2 text-xs text-ink-soft">
                    This writes one payout for each of the {owedNow.length} owed right now, against what the book says at this
                    moment. It records a payment you already made; no money moves from here.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="submit" className="btn btn-primary btn-sm" disabled={busy !== null} aria-busy={busy === "batch"}>
                      Write the batch down
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBatchOpen(false)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className="mt-3 inline-flex min-h-11 items-center text-sm font-bold text-violet-deep underline underline-offset-4"
                  onClick={() => {
                    setBatchDate(today);
                    setBatchReference("");
                    setBatchOpen(true);
                  }}
                >
                  I have paid this batch
                </button>
              )}
              {errorAt("batch")}
            </div>
          ) : null}
          {elsewhere > 0 ? (
            <p className="mt-3 text-xs text-ink-soft">
              {`${elsewhere} ${elsewhere === 1 ? "sale or payout is" : "sales and payouts are"} in another currency, from before your store charged in ${currency.toUpperCase()}. ${elsewhere === 1 ? "It is" : "They are"} listed with ${elsewhere === 1 ? "its" : "their"} own currency and left out of these totals, because amounts in two currencies do not add up.`}
            </p>
          ) : null}
        </section>
      </div>

      <div className="min-w-0 space-y-6">
        {pending.length ? (
          <section aria-labelledby="apps-title" className="card p-6 sm:p-8">
            <h2 id="apps-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
              {`Applications (${pending.length})`}
            </h2>
            <ul className="mt-4 space-y-3">
              {pending.map((row) => (
                <li key={row.affiliate.id} className="rounded-2xl border border-line bg-paper p-4">
                  <p className="font-semibold text-ink [overflow-wrap:anywhere]">{row.affiliate.email}</p>
                  <p className="mt-0.5 text-xs text-ink-soft">
                    {`Applied ${dayMs(row.affiliate.appliedAt)}`}
                    {row.affiliate.by
                      ? ` · invited by ${rows.find((r) => r.affiliate.id === row.affiliate.by?.id)?.affiliate.email ?? "an affiliate no longer here"}, who would earn ${row.affiliate.by.percent}% of their sales on top`
                      : ""}
                  </p>
                  {row.affiliate.note ? <p className="mt-2 text-sm text-ink-soft">{`“${row.affiliate.note}”`}</p> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy !== null}
                      aria-busy={busy === `a-${row.affiliate.id}`}
                      onClick={() => act(`a-${row.affiliate.id}`, { action: "approve", id: row.affiliate.id }, "Affiliate approved.")}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy !== null}
                      onClick={() => act(`a-${row.affiliate.id}`, { action: "decline", id: row.affiliate.id }, "Application declined.")}
                    >
                      Decline
                    </button>
                  </div>
                  {errorAt(`a-${row.affiliate.id}`)}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-soft">Approving emails them their link. Declining sends nothing.</p>
          </section>
        ) : null}

        {/*
          Inviting a partner, which is not the same act as taking on an
          affiliate. An affiliate applies to you; a partner is somebody you
          went and asked — the person who built the course with you, or whose
          newsletter carried the launch. So the creator sends this, and the
          person needs no account here at all: an address that can receive
          PayPal is the whole requirement (lib/affiliates.ts invitePartner).
        */}
        {setting.enabled && products.length ? (
          <PartnerInvite products={products} setting={setting} busy={busy} act={act} error={errorAt("invite")} />
        ) : null}

        <section aria-labelledby="people-title" className="card p-6 sm:p-8">
          <h2 id="people-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Your affiliates</h2>
          {members.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">
              {setting.enabled
                ? "Nobody yet. Share your affiliate page with the people who already recommend you."
                : "Switch the program on and share your affiliate page; applications appear here."}
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {members.map((row) => (
                <Member
                  key={row.affiliate.id}
                  row={row}
                  today={today}
                  busy={busy}
                  act={act}
                  error={errorAt(`m-${row.affiliate.id}`)}
                  codes={codes}
                  codeOf={codeOwners}
                  products={products}
                  setting={setting}
                />
              ))}
            </ul>
          )}
        </section>

        {leadsTotal > 0 ? <LeadReview leads={leads} total={leadsTotal} who={Object.fromEntries(rows.map((r) => [r.affiliate.id, r.affiliate.email]))} /> : null}

        <AffiliateCommissionHistory lines={lines} total={linesTotal} who={who} refundsChecked={refundsChecked} invoicesChecked={invoicesChecked} />

        {payouts.length ? (
          <section aria-labelledby="payouts-title" className="card p-6 sm:p-8">
            <h2 id="payouts-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Payouts you recorded</h2>
            <ul className="mt-4 divide-y divide-line">
              {payouts.map((payout) => (
                <li key={payout.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
                  <span className="min-w-0 text-sm">
                    <span className="block font-semibold text-ink [overflow-wrap:anywhere]">{who.get(payout.aff)?.email ?? "A removed affiliate"}</span>
                    <span className="block text-xs text-ink-soft">{`${payout.date}${payout.reference ? ` · ${payout.reference}` : ""}`}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-semibold tabular-nums text-ink">{money(payout.cents, payout.currency)}</span>
                    <button
                      type="button"
                      className="inline-flex min-h-11 items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"
                      disabled={busy !== null}
                      onClick={() => act(`p-${payout.id}`, { action: "unpay", payout: payout.id }, "Payout taken off the record.")}
                    >
                      Undo
                    </button>
                  </span>
                  {errorAt(`p-${payout.id}`)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
    </StoreCurrency>
  );
}

function Terms({
  handle,
  setting,
  products,
  busy,
  onSave,
  error,
}: {
  handle: string;
  setting: AffiliateSetting;
  products: { id: string; title: string; credited: boolean; recurring?: boolean }[];
  busy: boolean;
  onSave: (payload: Record<string, unknown>, confirmation: string) => Promise<boolean>;
  error: React.ReactNode;
}) {
  const [enabled, setEnabled] = useState(setting.enabled);
  const [percent, setPercent] = useState(String(setting.percent));
  const [days, setDays] = useState(String(setting.days));
  const [rule, setRule] = useState<AttributionRule>(setting.rule);
  const [payday, setPayday] = useState(String(setting.payday));
  const [hold, setHold] = useState(String(setting.hold));
  const [buyers, setBuyers] = useState(setting.buyers);
  const [directory, setDirectory] = useState(setting.directory);
  const [numbers, setNumbers] = useState(setting.numbers);
  const [kit, setKit] = useState(setting.kit);
  const [lifetime, setLifetime] = useState(setting.lifetime);
  const [recurringMonths, setRecurringMonths] = useState(String(setting.recurring));
  const [paidSearch, setPaidSearch] = useState(setting.paidSearch);
  const [secondTier, setSecondTier] = useState(String(setting.secondTier));
  const storeCurrency = useStoreCurrency();
  const [bonuses, setBonuses] = useState<{ sales: string; amount: string }[]>(
    setting.bonuses.map((b) => ({ sales: String(b.sales), amount: moneyField(b.cents, storeCurrency) })),
  );
  const [rates, setRates] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(setting.rates).map(([id, n]) => [id, String(n)])),
  );
  const [showRates, setShowRates] = useState(Object.keys(setting.rates).length > 0);
  const [lead, setLead] = useState<LeadTermsState>({
    kind: setting.lead.kind,
    amount: moneyField(setting.lead.cents, storeCurrency),
    hold: String(setting.lead.hold),
    daily: String(setting.lead.daily),
    budget: moneyField(setting.lead.budget, storeCurrency),
  });
  const credited = products.filter((p) => p.credited);
  // Memberships and payment plans, whatever is chosen for them now.
  const left = products.filter((p) => p.recurring || !p.credited);

  return (
    <section aria-labelledby="terms-title" className="card p-6 sm:p-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const chosen = Object.fromEntries(
            Object.entries(rates)
              .filter(([, v]) => v.trim() !== "")
              .map(([id, v]) => [id, Number(v.trim())]),
          );
          onSave(
            {
              action: "settings",
              enabled,
              percent: Number(percent.trim()),
              days: Number(days.trim()),
              rule,
              payday: Number(payday.trim()),
              hold: Number(hold.trim()),
              buyers,
              lifetime,
              recurring: Number(recurringMonths),
              paidSearch,
              secondTier: Number(secondTier),
              // An unreadable amount goes as 0, which the server refuses with the reason.
              bonuses: bonuses
                .filter((b) => b.sales.trim() || b.amount.trim())
                .map((b) => ({ sales: Number(b.sales.trim()), cents: readMoney(b.amount.trim(), storeCurrency) ?? 0 })),
              directory,
              numbers: directory && numbers,
              kit,
              rates: chosen,
              // An unreadable amount goes as 0, which the server refuses with the reason.
              lead: {
                kind: lead.kind,
                cents: readMoney(lead.amount.trim(), storeCurrency) ?? 0,
                hold: Number(lead.hold.trim()),
                daily: Number(lead.daily.trim()),
                budget: readMoney(lead.budget.trim(), storeCurrency) ?? 0,
              },
            },
            enabled ? "Affiliate program saved." : "Affiliate program switched off.",
          );
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="terms-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Your program</h2>
          <span className={`tag ${setting.enabled ? "tag-live" : ""}`}>{setting.enabled ? "On" : "Off"}</span>
        </div>

        <label className="mt-5 flex min-h-[44px] cursor-pointer items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--violet)]"
          />
          <span className="text-sm">
            <span className="block font-semibold text-ink">Take affiliates</span>
            <span className="block text-ink-soft">Your affiliate page opens, and links start earning.</span>
          </span>
        </label>

        <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3">
          <input
            type="checkbox"
            checked={buyers}
            onChange={(e) => setBuyers(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--violet)]"
          />
          <span className="text-sm">
            <span className="block font-semibold text-ink">Buyers join without applying</span>
            <span className="block text-ink-soft">
              The thanks page and the purchase email offer everyone who buys their own link, approved at once. Anyone you
              declined or removed stays out, and everyone else still applies.
            </span>
          </span>
        </label>

        <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3">
          <input
            type="checkbox"
            checked={kit}
            onChange={(e) => setKit(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--violet)]"
          />
          <span className="text-sm">
            <span className="block font-semibold text-ink">Draft posts for my affiliates</span>
            <span className="block text-ink-soft">
              On their own page, approved affiliates pick one of your products and get three posts written from its page, in
              your store&apos;s language, each ending with their link and a line saying they earn from it. Up to 3 a day each;
              every draft is one of your writing jobs for the month, and your affiliates together never use more than a quarter.
            </span>
          </span>
        </label>

        {/*
          Consent to be listed in the affiliate directory
          (app/affiliate-programs, lib/affiliate-directory.ts). It says what the
          row shows, so nothing on it is a surprise.
        */}
        <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3">
          <input
            type="checkbox"
            checked={directory}
            onChange={(e) => setDirectory(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--violet)]"
          />
          <span className="text-sm">
            <span className="block font-semibold text-ink">List my program in the affiliate directory</span>
            <span className="block text-ink-soft">
              People looking for something to promote find it at{" "}
              <Link href="/affiliate-programs" className="font-semibold text-violet-deep underline underline-offset-2">
                marktmorgen.com/affiliate-programs
              </Link>
              : your store&apos;s name and address, your share, your window, your payment day and up to four products that earn,
              each with what one sale earns, and a link to apply. It shows while your store can take payments. Uncheck this and save,
              and it leaves the page at once.
            </span>
          </span>
        </label>
        {directory ? (
          <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3 sm:ml-8">
            <input
              type="checkbox"
              checked={numbers}
              onChange={(e) => setNumbers(e.target.checked)}
              className="h-5 w-5 shrink-0 accent-[var(--violet)]"
            />
            <span className="text-sm">
              <span className="block font-semibold text-ink">Show my program&apos;s numbers there too</span>
              <span className="block text-ink-soft">
                How many affiliates you have and since when, the clicks they brought, the sales those clicks made, what they
                earned before refunds and what you have recorded as paid to them. Rates per click show once there are 100
                clicks. Affiliates choose programs by these; no figure about a buyer is ever shown.
              </span>
            </span>
          </label>
        ) : null}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="block" htmlFor="aff-percent">
            <span className="field-label">Share of each sale</span>
            <span className="relative block">
              <input
                id="aff-percent"
                type="number"
                inputMode="numeric"
                min={MIN_COMMISSION}
                max={MAX_COMMISSION}
                step={1}
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                className="field pr-9"
                required
              />
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-ink-soft">%</span>
            </span>
          </label>
          <label className="block" htmlFor="aff-days">
            <span className="field-label">A click counts for</span>
            <span className="relative block">
              <input
                id="aff-days"
                type="number"
                inputMode="numeric"
                min={MIN_COOKIE_DAYS}
                max={MAX_COOKIE_DAYS}
                step={1}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="field pr-14"
                required
              />
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-ink-soft">days</span>
            </span>
          </label>
        </div>
        <p className="mt-2 text-xs text-ink-soft">
          {`From ${MIN_COMMISSION} to ${MAX_COMMISSION}%, of what the buyer paid before tax, and a window of ${MIN_COOKIE_DAYS} to ${MAX_COOKIE_DAYS} days. A change applies to sales from then on; a sale keeps the share it was made at. Visitors from the European Economic Area, the UK, Switzerland and Brazil are asked first, because the rules there require it, and their click is remembered once they allow it.`}
        </p>
        <p className="mt-1 text-xs text-ink-soft">
          A click is remembered in the buyer&rsquo;s own browser, so the window runs for as long as that browser keeps it.
          Browsers set their own limit and shorten a long one without telling the site, and a buyer who clears their
          browser, changes phone or opens a private window arrives as somebody new. For credit that nothing can shorten,
          switch on the setting below.
        </p>

        <fieldset className="mt-5">
          <legend className="field-label">When a buyer follows two affiliates&rsquo; links</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {([
              ["last", "The last link wins", "An affiliate can win a buyer by offering something better, and the buyer picks whose link to use. What every platform does by default."],
              ["first", "The first link wins", "The affiliate who found the buyer keeps the sale, however many links they follow afterward. Rewards the one who made the introduction."],
            ] as const).map(([value, title, why]) => (
              <label
                key={value}
                className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 ${
                  rule === value ? "border-[var(--violet)] bg-paper" : "border-line bg-paper"
                }`}
              >
                <input
                  type="radio"
                  name="aff-rule"
                  value={value}
                  checked={rule === value}
                  onChange={() => setRule(value)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--violet)]"
                />
                <span className="text-sm">
                  <span className="block font-semibold text-ink">{title}</span>
                  <span className="block text-ink-soft">{why}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-soft">
            {`One sale earns one affiliate either way: a commission is never split between two people who both sent the same buyer, because the one who did the work to convert them ends up paying for the one who did not. Your affiliate page tells applicants which of the two you chose, before they apply. The window of ${days.trim() || setting.days} days is counted from ${rule === "first" ? "that first click" : "their most recent click"}.`}
          </p>
        </fieldset>

        {/*
          The bond that outlives the window (lib/affiliate-bond.ts). Off until
          the creator says so: it changes who gets paid for a sale no link
          brought in, and that is their decision, not a default.
        */}
        <label className="mt-5 flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3">
          <input
            type="checkbox"
            checked={lifetime}
            onChange={(e) => setLifetime(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--violet)]"
          />
          <span className="text-sm">
            <span className="block font-semibold text-ink">A buyer stays with the affiliate who brought them</span>
            <span className="block text-ink-soft">
              Once a sale is credited to an affiliate, everything that person buys afterward earns the same affiliate — no
              time limit, no second click, and whatever device they come back on. This is the one kind of credit no browser
              can shorten or throw away, because it is not kept in one. The window above is a cookie and lasts as long as
              the buyer&rsquo;s browser decides to keep it; this does not expire at all. Buyers are remembered as a one-way
              hash of their email address, never a readable list, and your affiliates see only their own totals.
            </span>
          </span>
        </label>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <label className="block" htmlFor="aff-payday">
            <span className="field-label">You pay on the</span>
            <select
              id="aff-payday"
              value={payday}
              onChange={(e) => setPayday(e.target.value)}
              className="field"
            >
              <option value="0">No fixed day</option>
              {Array.from({ length: MAX_PAYDAY }, (_, i) => i + 1).map((d) => (
                <option key={d} value={String(d)}>{`${ordinal(d)} of each month`}</option>
              ))}
            </select>
          </label>
          <label className="block" htmlFor="aff-hold">
            <span className="field-label">A sale waits</span>
            <span className="relative block">
              <input
                id="aff-hold"
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_HOLD_DAYS}
                step={1}
                value={hold}
                onChange={(e) => setHold(e.target.value)}
                className="field pr-14"
                required
              />
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-ink-soft">days</span>
            </span>
          </label>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-soft">
          <strong className="font-semibold text-ink">
            {Number(payday.trim()) >= 1
              ? `Your affiliates will read: paid on the ${ordinal(Number(payday.trim()))} of each month${
                  Number(hold.trim()) > 0
                    ? `, on sales at least ${hold.trim()} ${Number(hold.trim()) === 1 ? "day" : "days"} old.`
                    : "."
                }`
              : "Your affiliates will read: no payment day set, paid when you choose."}
          </strong>{" "}
          Make the wait match your refund policy. Money already paid to an affiliate on a sale that is refunded later has
          to be asked back by hand, and the wait is what stops that happening. On the day itself we email you the batch,
          so paying is not something you have to remember.
        </p>

        {credited.length ? (
          <div className="mt-4">
            <button
              type="button"
              className="flex min-h-11 items-center gap-1 text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep"
              aria-expanded={showRates}
              onClick={() => setShowRates((v) => !v)}
            >
              <Icon name="chevron-right" size={16} className={`transition-transform ${showRates ? "rotate-90" : ""}`} />
              A different share for some products
            </button>
            {showRates ? (
              <ul className="mt-2 space-y-2">
                {credited.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3">
                    <label htmlFor={`rate-${p.id}`} className="min-w-0 truncate text-sm text-ink">
                      {p.title}
                    </label>
                    <span className="relative w-28 shrink-0">
                      <input
                        id={`rate-${p.id}`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={MAX_COMMISSION}
                        step={1}
                        value={rates[p.id] ?? ""}
                        placeholder={percent || "20"}
                        onChange={(e) => setRates((all) => ({ ...all, [p.id]: e.target.value }))}
                        className="field pr-9"
                      />
                      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-ink-soft">%</span>
                    </span>
                  </li>
                ))}
                <li className="text-xs text-ink-soft">Empty uses the share above; 0 leaves the product out.</li>
              </ul>
            ) : null}
          </div>
        ) : null}
        {/*
          Memberships and payment plans (lib/affiliate-setting.ts recurring):
          each paid invoice is read from Stripe when the book opens, so nothing
          more is kept, and a membership keeps the months it was sold with.
        */}
        <label className="mt-5 block" htmlFor="aff-recurring">
          <span className="field-label">Memberships and payment plans</span>
          <select id="aff-recurring" value={recurringMonths} onChange={(e) => setRecurringMonths(e.target.value)} className="field">
            {RECURRING_OPTIONS.map((months) => (
              <option key={months} value={String(months)}>
                {months === 0
                  ? "Not credited to affiliates"
                  : months === 1
                    ? "Earn on the first payment"
                    : months === RECURRING_ALWAYS
                      ? "Earn on every payment, for as long as the member pays"
                      : `Earn on every payment in the first ${months} months`}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-ink-soft">
            {recurringMonths === "0"
              ? left.length
                ? `Not credited now: ${left.map((p) => p.title).join(", ")}.`
                : "Nothing you sell is a membership or a payment plan yet."
              : "A membership sold through an affiliate's link earns their share of each payment within that time, read from your Stripe account as it is paid, and a payment plan earns on each of its payments. A refunded payment earns nothing. A membership keeps the terms it was sold with if you change this later."}
          </span>
        </label>

        {/* The second tier (lib/affiliates.ts tierLines): fixed for each recruit when they join. */}
        <label className="mt-5 block" htmlFor="aff-tier">
          <span className="field-label">Second tier</span>
          <select id="aff-tier" value={secondTier} onChange={(e) => setSecondTier(e.target.value)} className="field">
            {SECOND_TIER_OPTIONS.map((n) => (
              <option key={n} value={String(n)}>
                {n === 0 ? "None" : `${n}% of each sale by somebody an affiliate brought`}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-ink-soft">
            {secondTier === "0"
              ? "Affiliates earn only on the sales they bring."
              : "Each approved affiliate gets an invitation link. Somebody who applies through it and whom you approve is theirs: on each sale that person brings, the affiliate who invited them earns this share too, paid by you on top of the first share, never out of it. One level only, never past 90% of a sale with every other share on it, and nothing while the person they brought is held. Changing it later keeps the share each person joined with."}
          </span>
        </label>

        {/* A bonus for each goal reached in a calendar month (lib/affiliates.ts bonusLines). */}
        <fieldset className="mt-5">
          <legend className="field-label">Monthly bonuses (optional)</legend>
          <ul className="space-y-2">
            {bonuses.map((b, i) => (
              <li key={i} className="flex flex-wrap items-end gap-2">
                <label className="block" htmlFor={`bonus-sales-${i}`}>
                  <span className="text-xs text-ink-soft">Sales in a month</span>
                  <input
                    id={`bonus-sales-${i}`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_BONUS_SALES}
                    step={1}
                    value={b.sales}
                    onChange={(e) => setBonuses((all) => all.map((x, j) => (j === i ? { ...x, sales: e.target.value } : x)))}
                    className="field w-28"
                    placeholder="10"
                  />
                </label>
                <label className="block" htmlFor={`bonus-amount-${i}`}>
                  <span className="text-xs text-ink-soft">{`Bonus (${fieldPrefix(storeCurrency) || storeCurrency.toUpperCase()})`}</span>
                  <input
                    id={`bonus-amount-${i}`}
                    inputMode="decimal"
                    value={b.amount}
                    onChange={(e) => setBonuses((all) => all.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                    className="field w-32"
                    placeholder="50"
                  />
                </label>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBonuses((all) => all.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {bonuses.length < MAX_BONUSES ? (
            <button type="button" className="btn btn-secondary btn-sm mt-2" onClick={() => setBonuses((all) => [...all, { sales: "", amount: "" }])}>
              Add a bonus
            </button>
          ) : null}
          <p className="mt-1 text-xs text-ink-soft">
            An affiliate whose link brings that many sales that earn in one calendar month gets the bonus once for that month, on
            top of their share. Each goal you add is paid once it is reached. A refund that takes the month back under the goal
            takes the bonus back too.
          </p>
        </fieldset>

        {/* Pay per lead (components/affiliate-leads-studio.tsx, lib/affiliate-leads.ts). */}
        <LeadTerms value={lead} onChange={setLead} currency={storeCurrency} />

        <label className="mt-5 flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3">
          <input
            type="checkbox"
            checked={paidSearch}
            onChange={(e) => setPaidSearch(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--violet)]"
          />
          <span className="text-sm">
            <span className="block font-semibold text-ink">Affiliates may run paid search ads on your name</span>
            <span className="block text-ink-soft">
              Off: when an affiliate&rsquo;s link is reached from a paid search ad (Google or Microsoft), what they are owed is
              held out of every payment until you look and release it, so nobody is paid for buyers who were already searching
              for you. Your affiliate page says so before anyone applies.
            </span>
          </span>
        </label>

        {error}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" aria-busy={busy} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <a href={`/@${handle}/affiliates`} className="inline-flex min-h-11 items-center gap-1 text-sm font-bold text-violet-deep underline-offset-4 hover:underline">
            Your affiliate page
            <Icon name="arrow-up-right" size={15} />
          </a>
        </div>
      </form>
    </section>
  );
}

function Member({
  row,
  today,
  busy,
  act,
  error,
  codes,
  codeOf,
  products,
  setting,
}: {
  row: Row;
  today: string;
  busy: string | null;
  act: (where: string, payload: Record<string, unknown>, confirmation: string) => Promise<boolean>;
  error: React.ReactNode;
  codes: StoreCode[];
  /** Which of those codes this affiliate has, by Stripe's promotion code id. */
  codeOf: Record<string, string>;
  /** The store's paid products, for choosing what a partner shares in. */
  products: { id: string; title: string; credited: boolean; recurring?: boolean }[];
  /** The programme's own terms, so the screen can say what the creator keeps. */
  setting: AffiliateSetting;
}) {
  const { affiliate } = row;
  const currency = useStoreCurrency();
  const where = `m-${affiliate.id}`;
  const theirs = codes.filter((c) => codeOf[c.id] === affiliate.id);
  const free = codes.filter((c) => !codeOf[c.id]);
  const [sharing, setSharing] = useState(false);
  const [percent, setPercent] = useState(affiliate.share ? String(affiliate.share.percent) : "");
  const [shared, setShared] = useState<string[]>(affiliate.share?.products ?? []);
  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState(row.owed > 0 ? moneyField(row.owed, currency) : "");
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState("");
  const [rating, setRating] = useState(false);
  const [rate, setRate] = useState(affiliate.rate === null ? "" : String(affiliate.rate));
  const tag = STATUS_TAG[affiliate.status];

  return (
    <li className="rounded-2xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink [overflow-wrap:anywhere]">{affiliate.email}</p>
          <p className="mt-0.5 font-mono text-xs text-ink-soft">{`?via=${affiliate.code}`}</p>
        </div>
        <span className={`tag ${tag.tone}`}>{tag.label}</span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-5">
        {[
          { label: "Clicks", value: row.clicks.toLocaleString("en-US") },
          { label: "Sales", value: row.sales.toLocaleString("en-US") },
          { label: "Earned", value: money(row.earned, currency) },
          { label: "Paid", value: money(row.paid, currency) },
          { label: row.owed < 0 ? "Paid ahead" : "Owed", value: money(Math.abs(row.owed), currency), strong: row.owed > 0 },
        ].map((tile) => (
          <div key={tile.label} className={`rounded-xl px-2 py-2 ${tile.strong ? "bg-lilac" : "bg-paper"}`}>
            <dt className="text-[0.6875rem] font-bold uppercase tracking-[0.06em] text-ink-mute">{tile.label}</dt>
            <dd className={`mt-0.5 font-semibold tabular-nums ${tile.strong ? "text-violet-ink" : "text-ink"}`}>{tile.value}</dd>
          </div>
        ))}
      </dl>

      {/*
        Held for the creator to look at (lib/affiliates.ts holdFlags): left out
        of every payment, the batch file and PayPal, until released here.
      */}
      {row.flags.length ? (
        <div className="notice notice-warn mt-3 text-sm" role="status" data-held="">
          <p className="font-semibold text-ink">{`${money(row.held, currency)} held for you to look at`}</p>
          <ul className="mt-1 list-disc pl-5 text-ink-soft">
            {row.flags.includes("paid-search") ? (
              <li>{`${row.paidClicks.toLocaleString("en-US")} ${row.paidClicks === 1 ? "click" : "clicks"} on their link came from a paid search ad, which your program does not allow.`}</li>
            ) : null}
            {row.flags.includes("same-address") ? <li>Another affiliate in your program has the same inbox or payout address, written the same or another way.</li> : null}
          </ul>
          <button
            type="button"
            className="btn btn-secondary btn-sm mt-2"
            disabled={busy !== null}
            onClick={() => act(where, { action: "release", id: affiliate.id }, "Released. What they are owed is payable again.")}
          >
            Release what is held
          </button>
        </div>
      ) : null}

      {/* A share for this affiliate alone (lib/affiliate-setting.ts commissionRate). */}
      <div className="mt-3 text-sm text-ink-soft">
        {rating ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const done = await act(where, { action: "rate", id: affiliate.id, rate: rate.trim() === "" ? null : Number(rate) }, "Share saved. It applies to sales from now on.");
              if (done) setRating(false);
            }}
          >
            <label className="block" htmlFor={`${where}-rate`}>
              <span className="field-label">Their share, %</span>
              <input id={`${where}-rate`} type="number" min={1} max={90} step={1} value={rate} onChange={(e) => setRate(e.target.value)} className="field w-28" placeholder="Program's" />
            </label>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy !== null}>
              Save
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRating(false)}>
              Cancel
            </button>
            <p className="basis-full text-xs">1% to 90% on every product, except products you set to 0%. Leave it empty for the program&rsquo;s own shares. Sales already made keep what they earned.</p>
          </form>
        ) : (
          <p>
            {affiliate.rate === null ? "Earns your program's shares. " : `Earns ${affiliate.rate}% on every product, except those set to 0%. `}
            <button type="button" className="font-bold text-violet-deep underline underline-offset-4" onClick={() => setRating(true)}>
              {affiliate.rate === null ? "Set a share for them" : "Change"}
            </button>
          </p>
        )}
        {affiliate.paypal ? <p className="mt-1 [overflow-wrap:anywhere]">{`Paid through PayPal at ${affiliate.paypal}, the address they chose.`}</p> : null}
      </div>

      {/*
        A discount code of the creator's own, given to this affiliate
        (lib/affiliate-codes.ts). Any sale that used it earns them their share
        with no click and no cookie, which is the only way a sale made on a
        podcast, from a stage or in a caption without links is credited at all.
      */}
      {/*
        A standing share of a product, whoever brought the buyer: what Hotmart
        calls co-production (lib/partner-share.ts). Different from the share
        above it, which is per sale they referred. The cap and what the creator
        keeps are both shown while they choose, not after.
      */}
      {affiliate.status === "approved" && products.length ? (
        <div className="mt-3 border-t border-line pt-3 text-sm text-ink-soft">
          <p className="field-label">A share of the product itself</p>
          {sharing ? (
            <form
              className="mt-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const done = await act(
                  where,
                  { action: "share", id: affiliate.id, percent: Number(percent.trim()), products: shared },
                  "Partner share saved. It applies to sales from now on.",
                );
                if (done) setSharing(false);
              }}
            >
              <label className="block" htmlFor={`${where}-share`}>
                <span className="field-label">Their share of every sale, %</span>
                <input
                  id={`${where}-share`}
                  type="number"
                  min={MIN_PARTNER_SHARE}
                  max={MAX_PARTNER_SHARE}
                  step={1}
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  className="field w-28"
                  required
                />
              </label>
              <fieldset className="mt-3">
                <legend className="field-label">Of which products</legend>
                <ul className="mt-1.5 space-y-1">
                  {products.map((product) => {
                    const on = shared.includes(product.id);
                    const affiliateShare = commissionRate(setting, product.id);
                    const keeps = creatorKeeps({
                      partners: on && Number(percent.trim()) > 0 ? [Number(percent.trim())] : [],
                      affiliatePercent: affiliateShare,
                    });
                    return (
                      <li key={product.id}>
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 hover:bg-paper">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) =>
                              setShared((prev) => (e.target.checked ? [...prev, product.id] : prev.filter((x) => x !== product.id)))
                            }
                            className="h-5 w-5 shrink-0 accent-[var(--violet)]"
                          />
                          <span className="min-w-0 flex-1 truncate text-ink">{product.title}</span>
                          <span className={`shrink-0 text-xs ${keeps < 25 ? "font-bold text-danger" : ""}`}>
                            {`you keep ${keeps}%`}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
              <p className="mt-2 text-xs">
                {`${MIN_PARTNER_SHARE}% to ${MAX_PARTNER_SHARE}% of what a buyer pays before tax, on every sale of the products you select — whoever brought the buyer. Partners and the affiliate commission together cannot pass ${MAX_COMMITTED_SHARE}% of a sale. "You keep" already counts the affiliate commission on that product, and Stripe's fee comes out of your part. They are paid by you, in the same batch as your affiliates, on the same day.`}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy !== null}>
                  Save
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSharing(false)}>
                  Cancel
                </button>
                {affiliate.share ? (
                  <button
                    type="button"
                    className="inline-flex min-h-11 items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"
                    disabled={busy !== null}
                    onClick={async () => {
                      const done = await act(
                        where,
                        { action: "share", id: affiliate.id, percent: null },
                        "Partner share ended. What they already earned stays owed to them.",
                      );
                      if (done) {
                        setSharing(false);
                        setPercent("");
                        setShared([]);
                      }
                    }}
                  >
                    End the partnership
                  </button>
                ) : null}
              </div>
            </form>
          ) : (
            <p className="mt-1">
              {affiliate.share
                ? `Takes ${affiliate.share.percent}% of every sale of ${affiliate.share.products.length} ${affiliate.share.products.length === 1 ? "product" : "products"}, whoever brought the buyer. `
                : "No share. A partner earns on every sale of a product, not only the ones they send you — for helping make it, or for lending their audience to it. "}
              <button
                type="button"
                className="inline-flex min-h-11 items-center font-bold text-violet-deep underline underline-offset-4"
                onClick={() => setSharing(true)}
              >
                {affiliate.share ? "Change it" : "Make them a partner"}
              </button>
            </p>
          )}
        </div>
      ) : null}

      {affiliate.status === "approved" && codes.length ? (
        <div className="mt-3 border-t border-line pt-3 text-sm text-ink-soft">
          <p className="field-label">Their discount code</p>
          {theirs.length ? (
            <ul className="mt-1.5 flex flex-wrap gap-2">
              {theirs.map((code) => (
                <li key={code.id} className="flex min-h-11 items-center gap-2 rounded-xl bg-lilac px-3 py-1.5">
                  <span className="font-mono text-sm font-bold text-violet-ink">{code.code}</span>
                  <span className="text-xs text-ink-soft">{code.label}</span>
                  <button
                    type="button"
                    /* Inside a 44px pill, but the press is on these two words,
                       so the words carry the 44px themselves. */
                    className="-my-1.5 inline-flex min-h-11 items-center px-1 text-xs font-bold text-violet-deep underline underline-offset-4"
                    disabled={busy !== null}
                    onClick={() =>
                      act(
                        where,
                        { action: "code", promo: code.id, id: "" },
                        `${code.code} is nobody's now. Sales already credited through it keep their commission.`,
                      )
                    }
                  >
                    Take back
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1">They have no code. A code earns them a sale even when no link was clicked.</p>
          )}
          {free.length ? (
            <label className="mt-2 block" htmlFor={`${where}-code`}>
              <span className="sr-only">Give them one of your codes</span>
              <select
                id={`${where}-code`}
                className="field"
                defaultValue=""
                disabled={busy !== null}
                onChange={(e) => {
                  const promo = e.target.value;
                  if (!promo) return;
                  const chosen = free.find((c) => c.id === promo);
                  e.target.value = "";
                  if (chosen) {
                    void act(
                      where,
                      { action: "code", promo, id: affiliate.id },
                      `${chosen.code} is theirs. Any sale that uses it earns them their share.`,
                    );
                  }
                }}
              >
                <option value="">Give them one of your codes…</option>
                {free.map((code) => (
                  <option key={code.id} value={code.id}>{`${code.code} — ${code.label}`}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

      {paying ? (
        <form
          className="mt-3 rounded-xl border-2 border-violet-brand/30 bg-white p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const done = await act(where, { action: "payout", id: affiliate.id, amount: amount.trim(), date, reference }, "Payout recorded.");
            if (done) setPaying(false);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[8rem_10rem_minmax(0,1fr)]">
            <label className="block" htmlFor={`${where}-a`}>
              <span className="field-label">{`Amount, ${currency === "usd" ? "$" : fieldPrefix(currency)}`}</span>
              <input id={`${where}-a`} type="text" inputMode={currency === "jpy" ? "numeric" : "decimal"} value={amount} onChange={(e) => setAmount(e.target.value)} className="field" required />
            </label>
            <label className="block" htmlFor={`${where}-d`}>
              <span className="field-label">Paid on</span>
              <input id={`${where}-d`} type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className="field" required />
            </label>
            <label className="block" htmlFor={`${where}-r`}>
              <span className="field-label">Reference (optional)</span>
              <input
                id={`${where}-r`}
                type="text"
                maxLength={80}
                value={reference}
                placeholder="PayPal 5TY0..."
                onChange={(e) => setReference(e.target.value)}
                className="field"
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-ink-soft">This only writes down a payment you made yourself. No money moves from here.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy !== null} aria-busy={busy === where}>
              Record the payout
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPaying(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <button type="button" className="inline-flex min-h-11 items-center text-sm font-bold text-violet-deep underline underline-offset-4" onClick={() => {
              // The form opens on what is owed now, not on what was owed
              // when this row first appeared.
              setAmount(row.owed > 0 ? moneyField(row.owed, currency) : "");
              setDate(today);
              setReference("");
              setPaying(true);
            }}>
            Mark as paid
          </button>
          {affiliate.status === "approved" ? (
            <button
              type="button"
              className="inline-flex min-h-11 items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"
              disabled={busy !== null}
              onClick={() => act(where, { action: "remove", id: affiliate.id }, "Affiliate removed. Their link no longer earns.")}
            >
              Remove
            </button>
          ) : (
            <button
              type="button"
              className="inline-flex min-h-11 items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep"
              disabled={busy !== null}
              onClick={() => act(where, { action: "restore", id: affiliate.id }, "Affiliate approved.")}
            >
              Approve
            </button>
          )}
          <a href={row.link} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm text-ink-soft underline-offset-4 hover:underline [overflow-wrap:anywhere]">
            {row.link.replace(/^https:\/\//, "")}
          <NewTab /></a>
        </div>
      )}
      {error}
    </li>
  );
}

/**
 * Inviting a partner from outside the programme.
 *
 * Kept apart from the affiliate list because it is a different act: an
 * affiliate applies to the creator, a partner is somebody the creator asked.
 * The email carries the terms, and opening it is the acceptance — so what is
 * typed here is what that person is agreeing to, and the screen says what the
 * creator will be left with before it is sent rather than after.
 */
function PartnerInvite({
  products,
  setting,
  busy,
  act,
  error,
}: {
  products: { id: string; title: string; credited: boolean; recurring?: boolean }[];
  setting: AffiliateSetting;
  busy: string | null;
  act: (where: string, payload: Record<string, unknown>, confirmation: string) => Promise<boolean>;
  error: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [percent, setPercent] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const share = Number(percent.trim());

  if (!open) {
    return (
      <section className="card p-6 sm:p-8">
        <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Partners</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Somebody who helped make a product, or lent their audience to it, can take a share of every sale of it —
          not only the sales they send you. They need no account here: an email address that can receive PayPal is all,
          and you pay them in the same batch as your affiliates, on the same day.
        </p>
        <button type="button" className="btn btn-secondary mt-4" onClick={() => setOpen(true)}>
          Invite a partner
        </button>
      </section>
    );
  }

  return (
    <section className="card p-6 sm:p-8">
      <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Invite a partner</h2>
      <form
        className="mt-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const done = await act(
            "invite",
            { action: "invite", email: email.trim(), percent: share, products: chosen },
            "Invitation sent. They become a partner when they open it.",
          );
          if (done) {
            setOpen(false);
            setEmail("");
            setPercent("");
            setChosen([]);
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <div className="min-w-0">
            <label className="block" htmlFor="partner-email">
              <span className="field-label">Their email</span>
            </label>
            <EmailInput id="partner-email" required autoComplete="off" placeholder="partner@example.com" value={email} onChange={setEmail} className="field" />
          </div>
          <label className="block" htmlFor="partner-percent">
            <span className="field-label">Their share, %</span>
            <input
              id="partner-percent"
              type="number"
              inputMode="numeric"
              min={MIN_PARTNER_SHARE}
              max={MAX_PARTNER_SHARE}
              step={1}
              required
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              className="field"
            />
          </label>
        </div>

        <fieldset className="mt-4">
          <legend className="field-label">Of which products</legend>
          <ul className="mt-1.5 space-y-1">
            {products.map((product) => {
              const on = chosen.includes(product.id);
              const affiliateShare = commissionRate(setting, product.id);
              const keeps = creatorKeeps({
                partners: on && share > 0 ? [share] : [],
                affiliatePercent: affiliateShare,
              });
              return (
                <li key={product.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 hover:bg-paper">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        setChosen((prev) => (e.target.checked ? [...prev, product.id] : prev.filter((x) => x !== product.id)))
                      }
                      className="h-5 w-5 shrink-0 accent-[var(--violet)]"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{product.title}</span>
                    <span className={`shrink-0 text-xs ${keeps < 25 ? "font-bold text-danger" : "text-ink-soft"}`}>
                      {`you keep ${keeps}%`}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>

        <p className="mt-3 text-xs text-ink-soft">
          {`The email states the share and the products, and opening it is how they accept — so what you type here is what they are agreeing to. Partners and the affiliate commission together cannot pass ${MAX_COMMITTED_SHARE}% of a sale. "You keep" already counts the affiliate commission on that product, and Stripe's fee comes out of your part. A refunded sale earns them nothing.`}
        </p>
        {error}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary" disabled={busy !== null || !chosen.length}>
            {busy === "invite" ? "Sending…" : "Send the invitation"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * A partnership somebody else is offering you, waiting in your own studio.
 *
 * Here rather than in an emailed link because this creator already has a
 * place they open on purpose, and an inbox is a place things get lost. The
 * terms are on the card: the share, the products, and what it means that it
 * applies to every sale. Pressing accept is the agreement — which is why the
 * number and the names have to be on the screen and not in a message
 * somewhere else.
 */
export function PartnerOffers({ offers }: { offers: { id: string; words: string; storeName: string; percent: number }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [gone, setGone] = useState<string[]>([]);
  const left = offers.filter((o) => !gone.includes(o.id));
  if (!left.length) return null;

  const answer = async (id: string, accept: boolean, name: string) => {
    setBusy(id);
    try {
      const response = await fetch("/api/store/affiliates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "answer", invite: id, accept }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) {
        toast(MESSAGES[data.error ?? ""] ?? "That offer is no longer there. Reload the page.");
        setGone((prev) => [...prev, id]);
        return;
      }
      toast(accept ? `You are now a partner of ${name}. Your share starts on their next sale.` : "Offer declined.");
      setGone((prev) => [...prev, id]);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="offers-title" className="card p-6 sm:p-8">
      <h2 id="offers-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        {left.length === 1 ? "A partnership offered to you" : "Partnerships offered to you"}
      </h2>
      <ul className="mt-4 space-y-3">
        {left.map((offer) => (
          <li key={offer.id} className="rounded-2xl border-2 border-violet-brand/30 bg-paper p-4">
            <p className="text-sm text-ink">{offer.words}</p>
            <p className="mt-2 text-xs text-ink-soft">
              You keep earning it for as long as the partnership runs, and a refunded sale earns nothing. They pay you
              directly from their own account — Marktmorgen never holds it. You can be paid at any PayPal address.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy !== null}
                onClick={() => answer(offer.id, true, offer.storeName)}
              >
                {busy === offer.id ? "Saving…" : `Accept ${offer.percent}%`}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy !== null}
                onClick={() => answer(offer.id, false, offer.storeName)}
              >
                Decline
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
