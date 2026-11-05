/**
 * The daily job that keeps every share taken to what is owed
 * (lib/platform-share.ts says what is owed, and why).
 *
 * Three steps, each bounded by the run's deadline and each safe to repeat,
 * because it reads what Stripe holds now and acts only on the difference:
 *
 *   1. Fees taken in the last few days. A fee set on a checkout is the share
 *      of the least the buyer could pay; this gives back the part above the
 *      share of what they did pay, once the discount and the tax are known.
 *   2. Payments refunded or lost to a dispute since the last run, on the
 *      accounts of stores that pay a share: the share of what was given back
 *      is given back too. A creator who refunds a buyer from their own Stripe
 *      dashboard does not get the fee back from Stripe by itself.
 *   3. The percentage written on each membership a store sold, kept to the
 *      store's plan: when a creator moves to a plan with a smaller share, or
 *      none, or their plan ends, the memberships they sold stop paying the
 *      old one; when they move to one with a larger share, they pay it from
 *      their next payment.
 *
 * It only ever gives back. A fee is never raised after a payment, so a
 * mistake here can only cost us, never a creator.
 */
import { BillingError, onPlatform } from "@/lib/billing";
import { COMMISSION_LIVE } from "@/lib/plan";
import { onAccount } from "@/lib/stripe-account";
import { redisPipeline } from "@/lib/redis";
import { storeForEmail, storeForHandle, type Store } from "@/lib/store";
import { SHARING_INDEX, owedOn, percentOf, planShareBps, shareBps, toGiveBack } from "@/lib/platform-share";

/**
 * Pinned for the reads below, where a charge still names its invoice and an
 * invoice its subscription's metadata. The version a request runs at decides
 * the shape it answers in, and left unset it is whatever the account defaults to.
 */
const READ_VERSION = "2024-06-20";

/** Fees older than this are settled only through a refund or a dispute (step 2). */
export const RECENT_DAYS = 3;
/** The rate last written on each store's memberships, by store key (step 3). */
const APPLIED = "nl:share:applied";
/** When step 2 last read each account's refunds, by store key. */
const READ_UNTIL = "nl:share:read-until";

export type SettleCounts = { fees: number; gaveBack: number; cents: number; stores: number; memberships: number; failed: number; complete: boolean; unknownDisputes: number; unknownDisputeFees: string[]; unknownAmounts: number; unknownAmountFees: string[] };

/** A separate diagnostic, never permission to refund from unknown evidence. */
class UnknownDisputeStatus extends Error {
  constructor(readonly feeId: string) {
    super("Dispute status is unknown");
  }
}

class UnknownAmount extends Error {
  constructor(readonly feeId: string, detail = "Settlement amount is unknown") {
    super(detail);
  }
}

function countSettlementFailure(counts: SettleCounts, error: unknown): void {
  counts.failed += 1;
  if (error instanceof UnknownDisputeStatus) {
    counts.unknownDisputes += 1;
    if (!counts.unknownDisputeFees.includes(error.feeId)) counts.unknownDisputeFees.push(error.feeId);
  }
  if (error instanceof UnknownAmount) {
    counts.unknownAmounts += 1;
    if (!counts.unknownAmountFees.includes(error.feeId)) counts.unknownAmountFees.push(error.feeId);
  }
}

type Fee = { id: string; account: string; charge: string; amount: number | null; refunded: number | null; currency?: string };

const str = (value: unknown) => (typeof value === "string" && value ? value : "");
const num = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** Stripe metadata stores integer amounts and basis points as decimal strings. */
const metadataInteger = (value: unknown): number | null => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const currency = (value: unknown): string | null => typeof value === "string" && /^[a-z]{3}$/.test(value) ? value : null;

function readFee(raw: Record<string, unknown>): Fee | null {
  const id = str(raw.id);
  const account = typeof raw.account === "string" ? raw.account : str((raw.account as { id?: unknown } | null)?.id);
  const charge = typeof raw.charge === "string" ? raw.charge : str((raw.charge as { id?: unknown } | null)?.id);
  if (!/^fee_[A-Za-z0-9]+$/.test(id) || !/^acct_[A-Za-z0-9]+$/.test(account) || !/^(ch|py)_[A-Za-z0-9]+$/.test(charge)) return null;
  return { id, account, charge, amount: num(raw.amount), refunded: num(raw.amount_refunded), currency: str(raw.currency).toLowerCase() || undefined };
}

/** What was paid for the goods on a payment made through a checkout: after discounts, without tax or shipping. */
function goodsOfSession(session: Record<string, unknown>): number | null {
  const total = num(session.amount_total);
  const details = (session.total_details ?? {}) as { amount_tax?: unknown; amount_shipping?: unknown };
  const tax = num(details.amount_tax), shipping = num(details.amount_shipping);
  if (total === null || tax === null || shipping === null || tax > total || shipping > total - tax) return null;
  return total - tax - shipping;
}

/**
 * What is owed on one fee, read from the payment it was taken on. Null when
 * Stripe could not say, in which case nothing is done with it this run.
 */
export async function owedOnFee(fee: Fee, nowSeconds: number, live = COMMISSION_LIVE): Promise<number | null> {
  const charge = await onAccount(
    "GET",
    fee.account,
    `/charges/${encodeURIComponent(fee.charge)}?expand[]=invoice&expand[]=payment_intent`,
    undefined,
    READ_VERSION,
  );
  // Everything below is worked out in the charge's own currency. A fee Stripe
  // reports in another one cannot be compared with it here, so it is left
  // as it is rather than given back by a sum in two currencies.
  if (currency(fee.currency) === null || currency(charge.currency) === null || fee.currency !== charge.currency) throw new UnknownAmount(fee.id, "Settlement currency is unknown");
  const amount = num(charge.amount);
  const refunded = num(charge.amount_refunded);
  if (amount === null || refunded === null || refunded > amount) throw new UnknownAmount(fee.id);
  let lostDispute = false;
  if (charge.disputed === true) {
    // Charge.dispute is absent at READ_VERSION. Ask the same connected
    // account for a complete, bounded list tied to this exact charge.
    const listed = await onAccount("GET", fee.account,
      `/disputes?${new URLSearchParams({ charge: fee.charge, limit: "100" })}`, undefined, READ_VERSION);
    const statuses = new Set(["lost", "won", "needs_response", "under_review", "warning_needs_response", "warning_under_review", "warning_closed"]);
    const rows = listed?.data;
    if (listed?.object !== "list" || listed.has_more !== false || !Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
      throw new Error("Dispute evidence is incomplete");
    }
    const seen = new Set<string>();
    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Dispute evidence is malformed");
      const row = raw as Record<string, unknown>;
      const disputedCharge = typeof row.charge === "string" ? row.charge : str((row.charge as { id?: unknown } | null)?.id);
      const id = str(row.id), status = str(row.status);
      if (row.object !== "dispute" || !/^du_[A-Za-z0-9]+$/.test(id) || seen.has(id)
        || disputedCharge !== fee.charge
        || str(row.currency).toLowerCase() !== str(charge.currency).toLowerCase()) {
        throw new Error("Dispute evidence does not match the charge");
      }
      if (!statuses.has(status)) throw new UnknownDisputeStatus(fee.id);
      seen.add(id);
      if (status === "lost") lostDispute = true;
    }
  }

  const invoice = charge.invoice as Record<string, unknown> | string | null;
  if (invoice && typeof invoice === "object") {
    // A membership's payment: the rate written on the membership, held to
    // what the store owes on the day the invoice was made, which is none
    // inside the trial or once its plan has ended.
    const meta = ((invoice.subscription_details as { metadata?: unknown } | null)?.metadata ?? {}) as Record<string, string>;
    const store = meta.store ? await storeForHandle(meta.store) : null;
    const written = metadataInteger(meta.share_bps), created = num(invoice.created);
    const goods = num(invoice.total_excluding_tax === undefined || invoice.total_excluding_tax === null ? invoice.subtotal : invoice.total_excluding_tax);
    if (!store || written === null || written > 10_000 || created === null || goods === null) throw new UnknownAmount(fee.id);
    const owedRate = shareBps(store, created, live);
    if (num(owedRate) === null || owedRate > 10_000) throw new UnknownAmount(fee.id);
    const bps = Math.min(written, owedRate);
    return owedOn({ bps, base: goods, amount, refunded, lostDispute });
  }

  const intent = charge.payment_intent as Record<string, unknown> | string | null;
  const meta = (intent && typeof intent === "object" ? intent.metadata : charge.metadata) as Record<string, string> | null;
  // The rate the sale was made at, written on it when the checkout opened.
  const bps = metadataInteger(meta?.share_bps);
  if (bps === null || bps > 10_000) throw new UnknownAmount(fee.id);
  let goods = metadataInteger(meta?.share_base);
  if (goods === null) {
    // A legacy checkout may omit this metadata. A supplied invalid amount
    // never falls back or becomes zero; missing data needs the actual session.
    if (meta?.share_base !== undefined) throw new UnknownAmount(fee.id);
    const intentId = intent && typeof intent === "object" ? str(intent.id) : str(intent);
    if (!intentId) throw new UnknownAmount(fee.id);
    const sessions = await onAccount("GET", fee.account, `/checkout/sessions?payment_intent=${encodeURIComponent(intentId)}&limit=1`, undefined, READ_VERSION);
    const session = Array.isArray(sessions.data) ? (sessions.data[0] as Record<string, unknown> | undefined) : undefined;
    const read = session ? goodsOfSession(session) : null;
    if (read === null) throw new UnknownAmount(fee.id);
    goods = read;
  }
  return owedOn({ bps, base: goods, amount, refunded, lostDispute });
}

/** Gives back what was taken above what is owed on one fee. Returns the cents given back. */
export async function settleFee(fee: Fee, nowSeconds: number, live = COMMISSION_LIVE): Promise<number> {
  const amount = num(fee.amount), refunded = num(fee.refunded);
  if (currency(fee.currency) === null) throw new UnknownAmount(fee.id, "Application fee refund currency is unknown");
  if (amount === null || refunded === null || refunded > amount) throw new UnknownAmount(fee.id, "Application fee refund amount is not a safe integer");
  if (amount - refunded <= 0) return 0;
  const owed = num(await owedOnFee(fee, nowSeconds, live));
  if (owed === null) throw new UnknownAmount(fee.id);
  const back = toGiveBack({ amount, refunded }, owed);
  if (back <= 0) return 0;
  if (!Number.isSafeInteger(back)) throw new Error("Application fee refund amount is not a safe integer");
  const receipt = await onPlatform("POST", `/application_fees/${encodeURIComponent(fee.id)}/refunds`, new URLSearchParams({ amount: String(back) }), {
    // The same difference is never given back twice, however often this runs.
    idempotencyKey: `share-back:${fee.id}:${fee.refunded}:${back}`,
  });
  const refundedFee = receipt && typeof receipt === "object" && !Array.isArray(receipt)
    ? (typeof receipt.fee === "string" ? receipt.fee : (receipt.fee as { id?: unknown } | null | undefined)?.id)
    : undefined;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.object !== "fee_refund"
    || typeof receipt.id !== "string" || !/^fr_[A-Za-z0-9]{8,64}$/.test(receipt.id)
    || refundedFee !== fee.id || receipt.amount !== back || receipt.currency !== fee.currency) {
    // The caller's existing failure count must reflect an unconfirmed result.
    // Keep the original idempotency key; do not create another refund here.
    throw new Error("Application fee refund receipt was not confirmed");
  }
  return back;
}

/** Step 1: every fee taken in the last RECENT_DAYS days. */
async function settleRecent(nowSeconds: number, deadline: number, counts: SettleCounts, live: boolean): Promise<boolean> {
  let after = "";
  for (let page = 0; page < 50; page += 1) {
    if (Date.now() > deadline) return false;
    const list = await onPlatform(
      "GET",
      `/application_fees?limit=100&created[gte]=${Math.floor(nowSeconds - RECENT_DAYS * 86_400)}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    );
    const rows = Array.isArray(list.data) ? (list.data as Record<string, unknown>[]) : [];
    for (const raw of rows) {
      if (Date.now() > deadline) return false;
      const fee = readFee(raw);
      if (!fee) continue;
      counts.fees += 1;
      try {
        const back = await settleFee(fee, nowSeconds, live);
        if (back > 0) {
          counts.gaveBack += 1;
          counts.cents += back;
        }
      } catch (error) {
        countSettlementFailure(counts, error);
        console.error(`settling the share ${fee.id} failed`, error);
      }
    }
    const last = rows.length ? str(rows[rows.length - 1].id) : "";
    if (list.has_more !== true || !last) return true;
    after = last;
  }
  return false;
}

/** Step 2, for one store: the payments refunded, or whose dispute closed, since this was last read. */
async function settleGivenBack(store: Store, ref: string, nowSeconds: number, deadline: number, counts: SettleCounts, live: boolean): Promise<boolean> {
  const account = store.stripeAccountId;
  if (!account) return true;
  const [saved] = await redisPipeline([["HGET", READ_UNTIL, ref]]);
  // A day's overlap: what was settled already settles to nothing.
  const since = Math.max(Number(saved) || 0, nowSeconds - 120 * 86_400) - 86_400;
  let after = "";
  for (let page = 0; page < 20; page += 1) {
    if (Date.now() > deadline) return false;
    const list = await onAccount(
      "GET",
      account,
      `/events?limit=100&types[0]=charge.refunded&types[1]=charge.dispute.closed&created[gte]=${Math.floor(since)}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    );
    const rows = Array.isArray(list.data) ? (list.data as { id?: unknown; data?: { object?: Record<string, unknown> } }[]) : [];
    for (const event of rows) {
      const object = event.data?.object ?? {};
      // A refund names its charge's fee; a dispute names its charge, whose fee is read.
      let feeId = str(object.application_fee);
      if (!feeId && str(object.charge)) {
        try {
          feeId = str((await onAccount("GET", account, `/charges/${encodeURIComponent(str(object.charge))}`, undefined, READ_VERSION)).application_fee);
        } catch {
          feeId = "";
        }
      }
      if (!feeId) continue;
      try {
        const fee = readFee(await onPlatform("GET", `/application_fees/${encodeURIComponent(feeId)}`));
        if (!fee) continue;
        counts.fees += 1;
        const back = await settleFee(fee, nowSeconds, live);
        if (back > 0) {
          counts.gaveBack += 1;
          counts.cents += back;
        }
      } catch (error) {
        if (error instanceof BillingError && error.status === 404) continue;
        countSettlementFailure(counts, error);
        console.error(`settling a refunded share on ${account} failed`, error);
      }
    }
    const last = rows.length ? str(rows[rows.length - 1].id) : "";
    if (list.has_more !== true || !last) break;
    after = last;
  }
  await redisPipeline([["HSET", READ_UNTIL, ref, String(Math.floor(nowSeconds))]]);
  return true;
}

/** Step 3, for one store: its memberships' percentage, kept to its plan. */
async function keepMemberships(store: Store, ref: string, deadline: number, counts: SettleCounts, live: boolean): Promise<boolean> {
  const target = planShareBps(store, live);
  const [raw] = await redisPipeline([["HGET", APPLIED, ref]]);
  const applied = raw === null || raw === undefined ? null : Number(raw);
  if (applied === target || (applied === null && target === 0)) return true;
  const account = store.stripeAccountId;
  if (!account) return true;
  let page = "";
  for (let round = 0; round < 20; round += 1) {
    if (Date.now() > deadline) return false;
    const query = encodeURIComponent(`metadata['store']:'${store.handle}'`);
    const found = await onAccount("GET", account, `/subscriptions/search?limit=100&query=${query}${page ? `&page=${encodeURIComponent(page)}` : ""}`);
    const rows = Array.isArray(found.data) ? (found.data as Record<string, unknown>[]) : [];
    for (const subscription of rows) {
      const status = str(subscription.status);
      if (status === "canceled" || status === "incomplete_expired") continue;
      const written = subscription.application_fee_percent;
      if (typeof written !== "number" || !Number.isFinite(written) || written < 0 || written > 100) throw new Error("Membership fee percent is unknown");
      if (written === target / 100) continue;
      const body = new URLSearchParams({ application_fee_percent: percentOf(target), "metadata[share_bps]": String(target) });
      await onAccount("POST", account, `/subscriptions/${encodeURIComponent(str(subscription.id))}`, body);
      counts.memberships += 1;
    }
    page = str(found.next_page);
    if (found.has_more !== true || !page) break;
  }
  await redisPipeline([target > 0 ? ["HSET", APPLIED, ref, String(target)] : ["HDEL", APPLIED, ref]]);
  return true;
}

/**
 * The whole run. The stores looked at are those that pay a share now, and
 * those whose memberships still carry one written earlier.
 */
export async function settleShares(deadline: number, nowSeconds = Date.now() / 1000, live = COMMISSION_LIVE): Promise<SettleCounts> {
  const counts: SettleCounts = { fees: 0, gaveBack: 0, cents: 0, stores: 0, memberships: 0, failed: 0, complete: true, unknownDisputes: 0, unknownDisputeFees: [], unknownAmounts: 0, unknownAmountFees: [] };
  try {
    if (!(await settleRecent(nowSeconds, deadline, counts, live))) counts.complete = false;
  } catch (error) {
    counts.failed += 1;
    counts.complete = false;
    console.error("reading the recent shares failed", error);
  }
  const [members, applied] = await redisPipeline([["SMEMBERS", SHARING_INDEX], ["HKEYS", APPLIED]]);
  const refs = [...new Set([...(Array.isArray(members) ? members : []), ...(Array.isArray(applied) ? applied : [])].filter((r): r is string => typeof r === "string"))];
  for (const ref of refs) {
    if (Date.now() > deadline) {
      counts.complete = false;
      break;
    }
    const store = await storeForEmail(ref);
    if (!store) {
      await redisPipeline([["SREM", SHARING_INDEX, ref], ["HDEL", APPLIED, ref], ["HDEL", READ_UNTIL, ref]]);
      continue;
    }
    counts.stores += 1;
    try {
      if (!(await settleGivenBack(store, ref, nowSeconds, deadline, counts, live))) counts.complete = false;
      if (!(await keepMemberships(store, ref, deadline, counts, live))) counts.complete = false;
    } catch (error) {
      counts.failed += 1;
      console.error(`keeping the share of ${store.handle} failed`, error);
    }
  }
  counts.complete = counts.complete && counts.failed === 0;
  return counts;
}
