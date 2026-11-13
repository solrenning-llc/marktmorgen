/**
 * The charges on our own Stripe account, read for the refund and dispute
 * reserve (306 [SY2] unit 2b). Only reads; nothing calls it yet: the daily
 * payout of what is above the reserve (unit 3) and the lock on new sales below
 * it (unit 4) are the next units.
 *
 * One list of charges (GET /v1/charges), pinned to 2024-06-20 as
 * lib/plan-refund.ts is (there a charge names its invoice and an invoice its
 * subscription), those created in the last LOOKBACK_DAYS (the longest yearly
 * period, 372 days, and the 120 days a payment can be disputed after it: no
 * older charge owes a refund or can be disputed), with each charge's invoice,
 * the invoice's subscription, the balance transaction (Stripe's fee) and the
 * refunds expanded. A disputed charge has its dispute read by charge. Each
 * charge is then what lib/refund-reserve-charge.ts counts:
 *   - a plan's subscription invoice: the plan's rule (the guarantee inside
 *     REFUND_DAYS, a yearly payment's months not started), its dispute part
 *     and its refunds still pending;
 *   - the Store assistant's invoice (metadata addon=assistant) and an AI
 *     captions invoice (metadata mark "captions:…", lib/auto-captions.ts):
 *     no refund (app/refunds/page.tsx, section 5a; captions are used), only
 *     the dispute part and the refunds still pending (an undelivered
 *     caption's refund until it succeeds);
 *   - a charge with no invoice, or an invoice of no kind above: its ceiling,
 *     the whole payment left plus its dispute part, and counted in
 *     `unclassified` so the owner's report shows that such charges exist
 *     (Claude 3, 13/11/2026). Never zero, and the reserve stays known.
 *
 * Unknown is never a partial sum. The whole reserve is unknown (no payout, no
 * sale on it) when the key is missing, the deadline passes, a page or a row is
 * not in its exact shape, an invoice or subscription is not expanded, Stripe
 * answers an error, a disputed charge does not list exactly one dispute, there
 * are more than MAX_DISPUTE_READS disputes, or the list goes past MAX_PAGES.
 *
 * Scale, for unit 3 (Claude 3, 13/11/2026): MAX_PAGES pages of PAGE_SIZE is
 * 2,000 charges in the lookback. Past that the reserve is unknown on every
 * run, which, once unit 4 locks new sales on it, would close sales by growth.
 * Before the lock is switched on, unit 3 needs an incremental reading: a
 * cursor and each charge's count kept, rereading only the charges that can
 * still change. Not built here.
 */
import { isBillingConfigured, onPlatformAt } from "@/lib/billing";
import { monthlyForYearly } from "@/lib/plan-refund";
import type { PlanRefundCharge } from "@/lib/plan-refund-rules";
import { type ReserveRead, reserveChargeOf } from "@/lib/refund-reserve-charge";
import { type Reserve, type ReserveCharge, refundReserve } from "@/lib/refund-reserve-rules";
import { hasOwnField, ownField, plainObject, readStripePage } from "@/lib/stripe-list";

/** The same pinned version as lib/plan-refund.ts and lib/plan-disputes.ts. */
export const READ_VERSION = "2024-06-20";
/** The longest yearly period (372 days) and the 120 days a payment can be disputed after it. */
export const LOOKBACK_DAYS = 492;
export const PAGE_SIZE = 100;
/** 2,000 charges in the lookback; past that the reserve is unknown (see above, for unit 3). */
export const MAX_PAGES = 20;
/** Disputes read by charge in one reading; more is unknown. */
export const MAX_DISPUTE_READS = 50;

const DAY_SECONDS = 86_400;
export const EXPAND = ["data.invoice", "data.invoice.subscription", "data.balance_transaction", "data.refunds"];
export const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]{6,64}$/;
const DISPUTE_ID = /^(dp|du)_[A-Za-z0-9]{6,64}$/;

export type ReserveReading = {
  reserve: Reserve;
  /** Why the reading did not finish; null when every charge was read (the rule may still call the reserve unknown). */
  why: null | "billing_off" | "deadline" | "too_many" | "unreadable";
  /** Charges read, pages read, disputes read, and charges counted at their ceiling for want of a known kind. */
  charges: number;
  pages: number;
  disputeReads: number;
  unclassified: number;
};

type Row = Record<string, unknown>;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const plainOrNull = (value: unknown): boolean => value === null || plainObject(value);

/** An expanded list Stripe embeds (refunds, invoice lines): its rows, and whether it was read whole; null when not one. */
function embedded(value: unknown): { rows: unknown[]; whole: boolean } | null {
  if (!plainObject(value)) return null;
  const data = ownField(value, "data");
  const more = ownField(value, "has_more");
  if (!Array.isArray(data) || typeof more !== "boolean") return null;
  return { rows: data, whole: !more };
}

/** A charge row in the shape this reading needs: the invoice and subscription expanded, never just an id. */
export function legibleCharge(row: Row): boolean {
  const invoice = ownField(row, "invoice");
  if (!plainOrNull(invoice) || !plainOrNull(ownField(row, "balance_transaction")) || !embedded(ownField(row, "refunds"))) return false;
  if (typeof ownField(row, "status") !== "string" || typeof ownField(row, "currency") !== "string" || typeof ownField(row, "disputed") !== "boolean") return false;
  if (![ownField(row, "created"), ownField(row, "amount"), ownField(row, "amount_captured"), ownField(row, "amount_refunded")].every(whole)) return false;
  if (plainObject(invoice)) {
    if (!plainOrNull(ownField(invoice, "subscription")) || !embedded(ownField(invoice, "lines")) || !whole(ownField(invoice, "total"))) return false;
    if (!hasOwnField(invoice, "metadata") || !plainOrNull(ownField(invoice, "metadata"))) return false;
  }
  return true;
}

/** The dispute on a charge, read by charge: exactly one, in its shape. */
export async function disputeOf(chargeId: string): Promise<{ status: string; amount: number } | null> {
  const page = readStripePage(
    await onPlatformAt(READ_VERSION, "GET", `/disputes?${new URLSearchParams({ charge: chargeId, limit: "10" })}`),
    (row) => ownField(row, "charge") === chargeId && typeof ownField(row, "status") === "string" && whole(ownField(row, "amount")),
    DISPUTE_ID,
  );
  if (page.unreadable > 0 || page.hasMore || page.rows.length !== 1) return null;
  return { status: text(ownField(page.rows[0], "status")), amount: ownField(page.rows[0], "amount") as number };
}

/** What one read charge is for the rule, and whether it had no known kind. */
export function readOf(row: Row, dispute: { status: string; amount: number } | null): { read: ReserveRead; unclassified: boolean } {
  const invoice = ownField(row, "invoice");
  const status = text(ownField(row, "status"));
  const created = ownField(row, "created") as number;
  const fee = ownField(row, "balance_transaction");
  const refundList = embedded(ownField(row, "refunds"))!;
  const refunds = refundList.whole
    ? refundList.rows.map((refund) => (plainObject(refund) ? { status: text(ownField(refund, "status")), amount: ownField(refund, "amount") as number } : { status: "", amount: Number.NaN }))
    : null;
  const paidAt = plainObject(invoice) && plainObject(ownField(invoice, "status_transitions")) ? ownField(ownField(invoice, "status_transitions") as Row, "paid_at") : undefined;
  const tax = plainObject(invoice) ? ownField(invoice, "tax") : null;
  const charge: PlanRefundCharge = {
    currency: text(ownField(row, "currency")),
    succeeded: status === "succeeded" && ownField(row, "paid") === true,
    amountCents: ownField(row, "amount_captured") as number,
    invoiceTotalCents: plainObject(invoice) ? (ownField(invoice, "total") as number) : (ownField(row, "amount") as number),
    billingReason: plainObject(invoice) ? text(ownField(invoice, "billing_reason")) : "",
    refundedCents: ownField(row, "amount_refunded") as number,
    taxCents: tax === null || tax === undefined ? 0 : whole(tax) ? tax : Number.NaN,
    feeCents: plainObject(fee) && whole(ownField(fee, "fee")) ? (ownField(fee, "fee") as number) : null,
    feeCurrency: plainObject(fee) && typeof ownField(fee, "currency") === "string" ? text(ownField(fee, "currency")) : null,
    paidAtSeconds: whole(paidAt) ? paidAt : created,
    disputeStatus: dispute?.status ?? null,
    disputedCents: dispute?.amount ?? null,
  };
  const at = { periodStartSeconds: charge.paidAtSeconds, periodEndSeconds: charge.paidAtSeconds };
  const subscription = plainObject(invoice) ? ownField(invoice, "subscription") : null;
  if (plainObject(invoice) && plainObject(subscription)) {
    const lines = embedded(ownField(invoice, "lines"))!.rows.filter(plainObject);
    const line = lines.find((l) => ownField(l, "type") === "subscription");
    const period = line ? ownField(line, "period") : undefined;
    const price = line ? ownField(line, "price") : undefined;
    const recurring = plainObject(price) ? ownField(price, "recurring") : undefined;
    const interval = plainObject(recurring) ? ownField(recurring, "interval") : undefined;
    const cycle = interval === "month" || interval === "year" ? interval : null;
    const unit = plainObject(price) ? ownField(price, "unit_amount") : undefined;
    const meta = ownField(subscription, "metadata");
    const addOn = plainObject(meta) && ownField(meta, "addon") === "assistant";
    return {
      unclassified: false,
      read: {
        kind: addOn ? "not-refunded" : "plan",
        status,
        cycle,
        monthlyCents: !addOn && cycle === "year" && whole(unit) ? monthlyForYearly(unit) : null,
        ...(plainObject(price) && typeof ownField(price, "currency") === "string" ? { monthlyCurrency: text(ownField(price, "currency")) } : {}),
        // An invoice line with no period of its shape leaves the period unreadable: the charge is then unknown.
        periodStartSeconds: plainObject(period) && whole(ownField(period, "start")) ? (ownField(period, "start") as number) : Number.NaN,
        periodEndSeconds: plainObject(period) && whole(ownField(period, "end")) ? (ownField(period, "end") as number) : Number.NaN,
        refunds,
        charge,
      },
    };
  }
  const meta = plainObject(invoice) ? ownField(invoice, "metadata") : null;
  const captions = plainObject(meta) && text(ownField(meta, "mark")).startsWith("captions:");
  return { unclassified: !captions, read: { kind: "not-refunded", status, cycle: null, monthlyCents: null, ...at, refunds, charge } };
}

/** The ceiling of a charge of no known kind: the whole payment left. */
export function atCeiling(counted: ReserveCharge, charge: PlanRefundCharge): ReserveCharge {
  if (counted.refund.kind === "unknown") return counted;
  const left = charge.amountCents - charge.refundedCents;
  if (!whole(left)) return { ...counted, refund: { kind: "unknown", reason: "unreadable" } };
  return { ...counted, refund: left > 0 ? { kind: "guarantee", cents: left } : { kind: "none", reason: "already_refunded" } };
}

/** The reserve the platform's balance must keep now, read from Stripe; unknown whenever any of it cannot be read. */
export async function readRefundReserve(nowSeconds: number, deadlineMs: number): Promise<ReserveReading> {
  const counts = { charges: 0, pages: 0, disputeReads: 0, unclassified: 0 };
  const stop = (why: Exclude<ReserveReading["why"], null>): ReserveReading => ({ reserve: { kind: "unknown", reason: "unreadable", index: -1 }, why, ...counts });
  if (!isBillingConfigured()) return stop("billing_off");
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= LOOKBACK_DAYS * DAY_SECONDS || !Number.isFinite(deadlineMs)) return stop("unreadable");
  const charges: ReserveCharge[] = [];
  let after: string | null = null;
  try {
    for (;;) {
      if (counts.pages >= MAX_PAGES) return stop("too_many");
      if (Date.now() >= deadlineMs) return stop("deadline");
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), "created[gte]": String(nowSeconds - LOOKBACK_DAYS * DAY_SECONDS) });
      for (const field of EXPAND) query.append("expand[]", field);
      if (after) query.set("starting_after", after);
      const page = readStripePage(await onPlatformAt(READ_VERSION, "GET", `/charges?${query}`), legibleCharge, CHARGE_ID);
      counts.pages += 1;
      if (page.unreadable > 0) return stop("unreadable");
      for (const row of page.rows) {
        counts.charges += 1;
        let dispute: { status: string; amount: number } | null = null;
        if (ownField(row, "disputed") === true) {
          if (counts.disputeReads >= MAX_DISPUTE_READS) return stop("too_many");
          if (Date.now() >= deadlineMs) return stop("deadline");
          counts.disputeReads += 1;
          dispute = await disputeOf(row.id);
          if (!dispute) return stop("unreadable");
        }
        const { read, unclassified } = readOf(row, dispute);
        const counted = reserveChargeOf(read, nowSeconds);
        if (!counted) continue;
        if (unclassified) counts.unclassified += 1;
        charges.push(unclassified ? atCeiling(counted, read.charge) : counted);
      }
      if (!page.hasMore) break;
      if (!page.lastId) return stop("unreadable");
      after = page.lastId;
    }
  } catch (error) {
    console.error("reading the charges for the refund reserve failed", error);
    return stop("unreadable");
  }
  return { reserve: refundReserve(charges, nowSeconds), why: null, ...counts };
}
