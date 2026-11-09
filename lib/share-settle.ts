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
import { SHARE_APPLIED } from "@/lib/platform-share";
import { onAccount } from "@/lib/stripe-account";
import { redisPipeline } from "@/lib/redis";
import { saleHandles, storeForEmail, storeForHandle, type Store } from "@/lib/store";
import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";
import { SHARING_INDEX, owedOn, percentOf, planShareBps, shareBps, toGiveBack } from "@/lib/platform-share";

/**
 * Pinned for the reads below, where a charge still names its invoice and an
 * invoice its subscription's metadata. The version a request runs at decides
 * the shape it answers in, and left unset it is whatever the account defaults to.
 */
const READ_VERSION = "2024-06-20";

/** Fees older than this are settled only through a refund or a dispute (step 2). */
export const RECENT_DAYS = 3;
/** The rate last written on each store's memberships, by store key (step 3; lib/platform-share.ts). */
const APPLIED = SHARE_APPLIED;
/** When step 2 last read each account's refunds, by store key. */
const READ_UNTIL = "nl:share:read-until";
/** Searches step 3 may make for one store in a run, over every address it has had (rule 24). */
const MEMBERSHIP_SEARCHES = 20;

/**
 * The stores that sell through a connected account, as far as the job's own
 * lists know them; null when those lists could not be read.
 */
type AccountStores = (account: string) => Promise<Store[] | null>;

/**
 * The store a membership invoice on a connected account was sold by. A rename
 * does not rewrite Stripe metadata, so the invoice names the address the
 * store had at the checkout: its current one, a previous one, or one it has
 * let go of, which leads nowhere by name (storeForHandle answers null). Each
 * store has a connected account of its own (lib/stripe-connect.ts), so on
 * that account every address the store has had is the store's (saleHandles).
 * Null, never a guess, when no store, or more than one, holds the address
 * on that account.
 */
async function invoiceStore(handle: string, account: string, stores?: AccountStores): Promise<Store | null> {
  const sold = (store: Store | null | undefined): store is Store => !!store && store.stripeAccountId === account && saleHandles(store).has(handle);
  const named = await storeForHandle(handle);
  if (sold(named)) return named;
  const owners = ((await stores?.(account)) ?? []).filter(sold);
  return owners.length === 1 ? owners[0] : null;
}

export type SettleCounts = { fees: number; gaveBack: number; cents: number; stores: number; memberships: number; failed: number; complete: boolean; unknownDisputes: number; unknownDisputeFees: string[]; unknownAmounts: number; unknownAmountFees: string[]; listUnknown: number };

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

/** A settlement list, its cursor or its selecting index was not confirmed. */
class UnknownFeeList extends Error {}

function countSettlementFailure(counts: SettleCounts, error: unknown): void {
  counts.failed += 1;
  if (error instanceof UnknownFeeList) counts.listUnknown += 1;
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

/** The fee and its expanded references must identify the resources being settled. */
function readFee(value: unknown): Fee | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.object !== "application_fee") return null;
  const reference = (value: unknown, kind: string): string => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const row = value as Record<string, unknown>;
    return row.object === kind ? str(row.id) : "";
  };
  const id = str(raw.id);
  const account = reference(raw.account, "account"), charge = reference(raw.charge, "charge");
  if (!/^fee_[A-Za-z0-9]+$/.test(id) || !/^acct_[A-Za-z0-9]+$/.test(account) || !/^(ch|py)_[A-Za-z0-9]+$/.test(charge)) return null;
  return { id, account, charge, amount: num(raw.amount), refunded: num(raw.amount_refunded), currency: str(raw.currency).toLowerCase() || undefined };
}

function providerReference(value: unknown, pattern: RegExp): string {
  const id = typeof value === "string" ? value : value && typeof value === "object" && !Array.isArray(value) ? str((value as Record<string, unknown>).id) : "";
  return pattern.test(id) ? id : "";
}

/** Expanded payment data must identify its resource before it supplies money. */
function expandedPayment(value: unknown, kind: string, pattern: RegExp, feeId: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UnknownAmount(feeId, "Expanded payment evidence is unknown");
  const row = value as Record<string, unknown>;
  if (row.object !== kind || typeof row.id !== "string" || !pattern.test(row.id)) throw new UnknownAmount(feeId, "Expanded payment identity is unknown");
  return row;
}

/** An expanded reference carries the same resource kind as a string id. */
function paymentReference(value: unknown, kind: string, pattern: RegExp, feeId: string): string {
  if (typeof value === "string" && pattern.test(value)) return value;
  return str(expandedPayment(value, kind, pattern, feeId).id);
}

/** Null is a confirmed absence; missing or malformed is never no fee. */
function historicalFeeReference(value: unknown): string | null {
  if (value === null) return null;
  const id = providerReference(value, /^fee_[A-Za-z0-9]+$/);
  if (!id) throw new UnknownFeeList("Historical application fee reference was not confirmed");
  return id;
}

function membershipPercent(row: Record<string, unknown>): number | null {
  const value = row.application_fee_percent === null ? 0 : row.application_fee_percent;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/** HSET/HDEL of exactly one marker has one integer acknowledgement. */
function confirmedMarkerWrite(reply: unknown): void {
  if (!Array.isArray(reply) || reply.length !== 1) throw new UnknownFeeList("Settlement progress write was not confirmed");
  const slot = Object.getOwnPropertyDescriptor(reply, "0");
  if (!slot || !("value" in slot) || (slot.value !== 0 && slot.value !== 1)) throw new UnknownFeeList("Settlement progress write was not confirmed");
}

function historicalEvent(raw: unknown): { id: string; fee: string | null; charge: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UnknownFeeList("Historical settlement event was not confirmed");
  const row = raw as Record<string, unknown>, id = str(row.id);
  const data = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data as Record<string, unknown> : null;
  const object = data?.object;
  if (!/^evt_[A-Za-z0-9]+$/.test(id) || !object || typeof object !== "object" || Array.isArray(object)) throw new UnknownFeeList("Historical settlement event was not confirmed");
  const evidence = object as Record<string, unknown>;
  if (Object.hasOwn(evidence, "application_fee")) return { id, fee: historicalFeeReference(evidence.application_fee), charge: null };
  const charge = providerReference(evidence.charge, /^(ch|py)_[A-Za-z0-9]+$/);
  if (!charge) throw new UnknownFeeList("Historical settlement charge reference was not confirmed");
  return { id, fee: null, charge };
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
export async function owedOnFee(fee: Fee, nowSeconds: number, live = COMMISSION_LIVE, stores?: AccountStores): Promise<number | null> {
  const charge = await onAccount(
    "GET",
    fee.account,
    `/charges/${encodeURIComponent(fee.charge)}?expand[]=invoice&expand[]=payment_intent`,
    undefined,
    READ_VERSION,
  );
  if (!charge || typeof charge !== "object" || Array.isArray(charge) || charge.object !== "charge" || charge.id !== fee.charge || typeof charge.disputed !== "boolean") {
    throw new UnknownAmount(fee.id, "Charge identity or dispute evidence is unknown");
  }
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

  // The requested expansion is either confirmed absent or a confirmed resource.
  // A missing field or an unexpanded id cannot silently select another path.
  if (charge.invoice !== null) {
    const invoice = expandedPayment(charge.invoice, "invoice", /^in_[A-Za-z0-9]+$/, fee.id);
    if (paymentReference(invoice.charge, "charge", /^(ch|py)_[A-Za-z0-9]+$/, fee.id) !== fee.charge) throw new UnknownAmount(fee.id, "Invoice does not belong to this charge");
    // A membership's payment: the rate written on the membership, held to
    // what the store owes on the day the invoice was made, which is none
    // inside the trial or once its plan has ended.
    const meta = ((invoice.subscription_details as { metadata?: unknown } | null)?.metadata ?? {}) as Record<string, string>;
    const handle = str(meta.store);
    const store = handle ? await invoiceStore(handle, fee.account, stores) : null;
    const written = metadataInteger(meta.share_bps), created = num(invoice.created);
    const goods = num(invoice.total_excluding_tax === undefined || invoice.total_excluding_tax === null ? invoice.subtotal : invoice.total_excluding_tax);
    if (!store || store.stripeAccountId !== fee.account || written === null || written > 10_000 || created === null || goods === null || currency(invoice.currency) !== fee.currency) throw new UnknownAmount(fee.id);
    const owedRate = shareBps(store, created, live);
    if (num(owedRate) === null || owedRate > 10_000) throw new UnknownAmount(fee.id);
    const bps = Math.min(written, owedRate);
    return owedOn({ bps, base: goods, amount, refunded, lostDispute });
  }

  const intent = charge.payment_intent === null ? null : expandedPayment(charge.payment_intent, "payment_intent", /^pi_[A-Za-z0-9]+$/, fee.id);
  if (intent && (paymentReference(intent.latest_charge, "charge", /^(ch|py)_[A-Za-z0-9]+$/, fee.id) !== fee.charge
    || currency(intent.currency) !== fee.currency || num(intent.amount) !== amount)) throw new UnknownAmount(fee.id, "Payment intent does not match this charge");
  const meta = (intent ? intent.metadata : charge.metadata) as Record<string, string> | null;
  // The rate the sale was made at, written on it when the checkout opened.
  const bps = metadataInteger(meta?.share_bps);
  if (bps === null || bps > 10_000) throw new UnknownAmount(fee.id);
  let goods = metadataInteger(meta?.share_base);
  if (goods === null) {
    // A legacy checkout may omit this metadata. A supplied invalid amount
    // never falls back or becomes zero; missing data needs the actual session.
    if (meta?.share_base !== undefined) throw new UnknownAmount(fee.id);
    const intentId = intent ? str(intent.id) : "";
    if (!intentId) throw new UnknownAmount(fee.id);
    const sessions = await onAccount("GET", fee.account, `/checkout/sessions?payment_intent=${encodeURIComponent(intentId)}&limit=1`, undefined, READ_VERSION);
    if (sessions?.object !== "list" || sessions.has_more !== false || !Array.isArray(sessions.data) || sessions.data.length !== 1) throw new UnknownAmount(fee.id);
    const session = expandedPayment(sessions.data[0], "checkout.session", /^cs_[A-Za-z0-9_]+$/, fee.id);
    if (currency(session.currency) !== fee.currency || num(session.amount_total) !== amount
      || paymentReference(session.payment_intent, "payment_intent", /^pi_[A-Za-z0-9]+$/, fee.id) !== intentId) throw new UnknownAmount(fee.id, "Checkout session does not match this payment intent");
    const read = goodsOfSession(session);
    if (read === null) throw new UnknownAmount(fee.id);
    goods = read;
  }
  return owedOn({ bps, base: goods, amount, refunded, lostDispute });
}

/** Gives back what was taken above what is owed on one fee. Returns the cents given back. */
export async function settleFee(fee: Fee, nowSeconds: number, live = COMMISSION_LIVE, stores?: AccountStores): Promise<number> {
  const amount = num(fee.amount), refunded = num(fee.refunded);
  if (currency(fee.currency) === null) throw new UnknownAmount(fee.id, "Application fee refund currency is unknown");
  if (amount === null || refunded === null || refunded > amount) throw new UnknownAmount(fee.id, "Application fee refund amount is not a safe integer");
  if (amount - refunded <= 0) return 0;
  const owed = num(await owedOnFee(fee, nowSeconds, live, stores));
  if (owed === null) throw new UnknownAmount(fee.id);
  const back = toGiveBack({ amount, refunded }, owed);
  if (back <= 0) return 0;
  if (!Number.isSafeInteger(back)) throw new UnknownAmount(fee.id, "Application fee refund amount is not a safe integer");
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
async function settleRecent(nowSeconds: number, deadline: number, counts: SettleCounts, live: boolean, stores: AccountStores): Promise<boolean> {
  let after = "";
  const cursors = new Set<string>();
  for (let page = 0; page < 50; page += 1) {
    if (Date.now() > deadline) return false;
    const list = await onPlatform(
      "GET",
      `/application_fees?limit=100&created[gte]=${Math.floor(nowSeconds - RECENT_DAYS * 86_400)}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    );
    if (list.object !== "list" || typeof list.has_more !== "boolean" || !Array.isArray(list.data)
      || list.data.length > 100 || (list.has_more && list.data.length === 0)) {
      throw new UnknownFeeList("Recent application fee page was not confirmed");
    }
    // Confirm the entire page before any of its rows can authorize a refund.
    const ids = new Set<string>();
    const fees = list.data.map((raw: unknown): Fee => {
      const fee = raw && typeof raw === "object" && !Array.isArray(raw) ? readFee(raw as Record<string, unknown>) : null;
      if (!fee || ids.has(fee.id) || fee.id === after) throw new UnknownFeeList("Recent application fee row was not confirmed");
      ids.add(fee.id);
      return fee;
    });
    const last = fees.length ? fees[fees.length - 1].id : "";
    if (list.has_more && cursors.has(last)) throw new UnknownFeeList("Recent application fee cursor did not advance");
    for (const fee of fees) {
      if (Date.now() > deadline) return false;
      counts.fees += 1;
      try {
        const back = await settleFee(fee, nowSeconds, live, stores);
        if (back > 0) {
          counts.gaveBack += 1;
          counts.cents += back;
        }
      } catch (error) {
        countSettlementFailure(counts, error);
        console.error(`settling the share ${fee.id} failed`, error);
      }
    }
    if (!list.has_more) return true;
    cursors.add(last);
    after = last;
  }
  return false;
}

/** Step 2, for one store: the payments refunded, or whose dispute closed, since this was last read. */
async function settleGivenBack(store: Store, ref: string, nowSeconds: number, deadline: number, counts: SettleCounts, live: boolean): Promise<boolean> {
  const account = store.stripeAccountId;
  if (!account) return true;
  const saved = await redisPipeline([["HGET", READ_UNTIL, ref]]);
  if (!Array.isArray(saved) || saved.length !== 1) throw new UnknownFeeList("Historical settlement cursor was not confirmed");
  const readUntil = saved[0] === null ? 0 : metadataInteger(saved[0]);
  if (readUntil === null) throw new UnknownFeeList("Historical settlement cursor was not confirmed");
  // A day's overlap: what was settled already settles to nothing.
  const since = Math.max(readUntil, nowSeconds - 120 * 86_400) - 86_400;
  let after = "";
  let completeRead = false, allSettled = true;
  const cursors = new Set<string>();
  for (let page = 0; page < 20; page += 1) {
    if (Date.now() > deadline) return false;
    const list = await onAccount(
      "GET",
      account,
      `/events?limit=100&types[0]=charge.refunded&types[1]=charge.dispute.closed&created[gte]=${Math.floor(since)}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    );
    if (list.object !== "list" || typeof list.has_more !== "boolean" || !Array.isArray(list.data)
      || list.data.length > 100 || (list.has_more && list.data.length === 0)) throw new UnknownFeeList("Historical settlement page was not confirmed");
    const ids = new Set<string>();
    const rows = list.data.map((raw: unknown) => {
      const row = historicalEvent(raw);
      if (ids.has(row.id) || row.id === after) throw new UnknownFeeList("Historical settlement event was repeated");
      ids.add(row.id);
      return row;
    });
    const last = rows.length ? rows[rows.length - 1].id : "";
    if (list.has_more && cursors.has(last)) throw new UnknownFeeList("Historical settlement cursor did not advance");
    for (const event of rows) {
      // A refund names its charge's fee; a dispute names its charge, whose fee is read.
      let feeId = event.fee;
      if (event.charge) {
        const charge = await onAccount("GET", account, `/charges/${encodeURIComponent(event.charge)}`, undefined, READ_VERSION);
        if (!charge || typeof charge !== "object" || Array.isArray(charge) || charge.object !== "charge" || charge.id !== event.charge) throw new UnknownFeeList("Historical charge identity was not confirmed");
        feeId = historicalFeeReference(charge.application_fee);
      }
      if (feeId === null) continue;
      try {
        const fee = readFee(await onPlatform("GET", `/application_fees/${encodeURIComponent(feeId)}`));
        if (!fee || fee.id !== feeId || fee.account !== account || (event.charge && fee.charge !== event.charge)) throw new UnknownAmount(feeId, "Historical application fee identity was not confirmed");
        counts.fees += 1;
        // This store's own account: the store is known whatever address the invoice names.
        const back = await settleFee(fee, nowSeconds, live, async (on) => (on === account ? [store] : []));
        if (back > 0) {
          counts.gaveBack += 1;
          counts.cents += back;
        }
      } catch (error) {
        if (error instanceof BillingError && error.status === 404) continue;
        allSettled = false;
        countSettlementFailure(counts, error);
        console.error(`settling a refunded share on ${account} failed`, error);
      }
    }
    if (!list.has_more) { completeRead = true; break; }
    cursors.add(last);
    after = last;
  }
  // Progress is committed only after the full reading and all its fees settle.
  if (!completeRead || !allSettled) return false;
  confirmedMarkerWrite(await redisPipeline([["HSET", READ_UNTIL, ref, String(Math.floor(nowSeconds))]]));
  return true;
}

/**
 * Step 3, for one store: its memberships' percentage, kept to its plan.
 *
 * Every address the store ever sold under is searched, on its own connected
 * account (saleHandles: the current one, the previous ones, the released
 * ones), because a rename does not rewrite the metadata Stripe keeps. Until
 * 9 November 2026 only the current address was, so a membership sold before
 * a rename kept the old share, and the applied mark was written anyway: it
 * was never looked at again (tests/share-settle-handles.test.ts). Each store
 * has a connected account of its own (lib/stripe-connect.ts), so an address
 * let go of and taken by another store never selects that store's sales here.
 *
 * The search asks only for what can still pay (Stripe's search query
 * language: clauses joined by AND, one negated by a leading "-"; status is a
 * subscription search field): an ended membership never comes back, so a
 * store that sold thousands over its life is not read past the same first
 * pages of ended ones on every run (rule 30, the sibling of stopRenewals in
 * #3332). Until 9 November 2026 it asked for every one ever sold, and a store
 * with 2,000 ended ones ahead of a live one never reached it: the live one
 * went on paying the old share (tests/share-membership-search.test.ts).
 *
 * A member who ends mid-pass now leaves that search, and a page may be cut
 * short by an offset into what it matches now, skipping a live one; so an
 * address whose pass took several pages and changed a percentage is not taken
 * as finished, and the applied mark is written only when every address was
 * read to its end, every change was confirmed, and no address had such a pass.
 *
 * No mark and a share of 0 means that nothing sold carries a share: when a
 * store's plan share changes or stops, setSubscription (lib/store.ts) first
 * puts down the share its checkouts wrote until then as the mark, so a store
 * that stopped before this job first read it, or went back to a share already
 * confirmed, is still read here and lowered. Until 9 November 2026 it was not,
 * and those memberships kept the old share for good
 * (tests/share-stop-early.test.ts).
 *
 * Rule 24 bound: at most MEMBERSHIP_SEARCHES (20) searches for a store in a
 * run, over all its addresses, one at least for each. For A addresses and N
 * memberships that can still pay, a run never out of time makes at most
 * min(20, A + ceil(N / 100)) searches, and finishes in 2 runs when that sum
 * is at most 20 and pages stay put (one that changes, one that confirms; each
 * member ending mid-pass can add one). Past it, a run reads the same first 20
 * pages and never writes the mark: never done, never said done.
 */
async function keepMemberships(store: Store, ref: string, deadline: number, counts: SettleCounts, live: boolean): Promise<boolean> {
  const target = planShareBps(store, live);
  const saved = await redisPipeline([["HGET", APPLIED, ref]]);
  if (!Array.isArray(saved) || saved.length !== 1) throw new UnknownFeeList("Applied membership percentage was not confirmed");
  const applied = saved[0] === null ? null : metadataInteger(saved[0]);
  if (saved[0] !== null && (applied === null || applied > 10_000)) throw new UnknownFeeList("Applied membership percentage was not confirmed");
  if (applied === target || (applied === null && target === 0)) return true;
  const account = store.stripeAccountId;
  if (!account) return true;
  const handles = [...saleHandles(store)];
  // Each goes into a search query between quotes: only a confirmed address shape is ever sent.
  if (!handles.every((handle) => HANDLE_PATTERN.test(handle))) throw new UnknownFeeList("Membership settlement address was not confirmed");
  let searches = 0, allRead = true, allApplied = true, confirmed = true;
  const statuses = new Set(["active", "trialing", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"]);
  for (const handle of handles) {
    let page = "";
    let completeRead = false;
    // Pages read, and percentages changed, on this address's pass.
    let read = 0, changed = 0;
    const cursors = new Set<string>();
    try {
      while (searches < MEMBERSHIP_SEARCHES) {
        if (Date.now() > deadline) return false;
        const query = encodeURIComponent(`metadata['store']:'${handle}' AND -status:'canceled' AND -status:'incomplete_expired'`);
        searches += 1;
        const found = await onAccount("GET", account, `/subscriptions/search?limit=100&query=${query}${page ? `&page=${encodeURIComponent(page)}` : ""}`);
        read += 1;
        if (found.object !== "search_result" || !Array.isArray(found.data) || found.data.length > 100 || typeof found.has_more !== "boolean"
          || (found.has_more && (found.data.length === 0 || typeof found.next_page !== "string" || !found.next_page.trim() || cursors.has(found.next_page)))) throw new UnknownFeeList("Membership settlement page was not confirmed");
        const ids = new Set<string>();
        const rows = found.data.map((row: unknown) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) throw new UnknownFeeList("Membership settlement row was not confirmed");
          const subscription = row as Record<string, unknown>, id = str(subscription.id);
          if (!/^sub_[A-Za-z0-9]+$/.test(id) || ids.has(id) || !statuses.has(str(subscription.status))) throw new UnknownFeeList("Membership settlement identity or status was not confirmed");
          ids.add(id);
          return subscription;
        });
        for (const subscription of rows) {
          const status = str(subscription.status);
          // Ended already, though the search, which catches up within moments, still gave it: nothing to keep.
          if (status === "canceled" || status === "incomplete_expired") continue;
          try {
            // Stripe's explicit null means that no fee is set; absence is unknown.
            const written = membershipPercent(subscription);
            if (written === null) throw new Error("Membership fee percent is unknown");
            if (written === target / 100) continue;
            const body = new URLSearchParams({ application_fee_percent: percentOf(target), "metadata[share_bps]": String(target) });
            const updated = await onAccount("POST", account, `/subscriptions/${encodeURIComponent(str(subscription.id))}`, body);
            if (!updated || typeof updated !== "object" || Array.isArray(updated) || updated.object !== "subscription"
              || updated.id !== subscription.id || membershipPercent(updated) !== target / 100) throw new Error("Membership fee update was not confirmed");
            counts.memberships += 1;
            changed += 1;
          } catch (error) {
            allApplied = false;
            countSettlementFailure(counts, error);
            console.error(`keeping a membership share on ${account} failed`, error);
          }
        }
        if (!found.has_more) { completeRead = true; break; }
        page = found.next_page as string;
        cursors.add(page);
      }
    } catch (error) {
      // One address's unconfirmed search does not stop the others from being kept; it keeps the mark unwritten.
      countSettlementFailure(counts, error);
      console.error(`searching the memberships of ${handle} on ${account} failed`, error);
    }
    if (!completeRead) allRead = false;
    // Several pages, and a percentage changed: a later page may have been cut short by a member who left the search,
    // so the end reached is not known to have held every one. The next run's pass must change none.
    if (read > 1 && changed > 0) confirmed = false;
  }
  if (!allRead || !allApplied || !confirmed) return false;
  confirmedMarkerWrite(await redisPipeline([target > 0 ? ["HSET", APPLIED, ref, String(target)] : ["HDEL", APPLIED, ref]]));
  return true;
}

/** Every store the job looks at, by key: those that pay a share now, and those whose memberships still carry one. Null when unconfirmed. */
async function settlementRefs(): Promise<string[] | null> {
  const indexes = await redisPipeline([["SMEMBERS", SHARING_INDEX], ["HKEYS", APPLIED]]);
  if (!Array.isArray(indexes) || indexes.length !== 2 || !Array.isArray(indexes[0]) || !Array.isArray(indexes[1])
    || ![...indexes[0], ...indexes[1]].every(ref => typeof ref === "string" && ref.trim() !== "")) return null;
  const [members, applied] = indexes as [string[], string[]];
  return [...new Set([...members, ...applied])];
}

/**
 * For step 1, which reads fees across every account: the stores of the job's
 * lists by connected account, read once a run and only when a membership
 * invoice names an address that does not lead to its account's store (one
 * the store let go of). At most one read of the lists and one of each store
 * they hold, a run. Null when the lists could not be read.
 */
function listedStores(): AccountStores {
  let byAccount: Promise<Map<string, Store[]> | null> | null = null;
  const read = async (): Promise<Map<string, Store[]> | null> => {
    const refs = await settlementRefs();
    if (!refs) return null;
    const map = new Map<string, Store[]>();
    for (const ref of refs) {
      const store = await storeForEmail(ref);
      if (!store?.stripeAccountId) continue;
      map.set(store.stripeAccountId, [...(map.get(store.stripeAccountId) ?? []), store]);
    }
    return map;
  };
  return async (account) => {
    byAccount ??= read().catch(() => null);
    const map = await byAccount;
    return map ? map.get(account) ?? [] : null;
  };
}

/**
 * The whole run. The stores looked at are those that pay a share now, and
 * those whose memberships still carry one written earlier.
 */
export async function settleShares(deadline: number, nowSeconds = Date.now() / 1000, live = COMMISSION_LIVE): Promise<SettleCounts> {
  const counts: SettleCounts = { fees: 0, gaveBack: 0, cents: 0, stores: 0, memberships: 0, failed: 0, complete: true, unknownDisputes: 0, unknownDisputeFees: [], unknownAmounts: 0, unknownAmountFees: [], listUnknown: 0 };
  try {
    if (!(await settleRecent(nowSeconds, deadline, counts, live, listedStores()))) counts.complete = false;
  } catch (error) {
    countSettlementFailure(counts, error);
    counts.complete = false;
    console.error("reading the recent shares failed", error);
  }
  const refs = await settlementRefs();
  if (!refs) {
    const error = new UnknownFeeList("Historical settlement store indexes were not confirmed");
    countSettlementFailure(counts, error);
    counts.complete = false;
    console.error("reading historical settlement stores failed", error);
    return counts;
  }
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
    } catch (error) {
      countSettlementFailure(counts, error);
      counts.complete = false;
      console.error(`settling historical shares on ${store.handle} failed`, error);
    }
    // Independent membership evidence may still lower a rate after a failed
    // historical reading. Neither step certifies the other one's work.
    try {
      if (!(await keepMemberships(store, ref, deadline, counts, live))) counts.complete = false;
    } catch (error) {
      countSettlementFailure(counts, error);
      counts.complete = false;
      console.error(`keeping membership shares on ${store.handle} failed`, error);
    }
  }
  counts.complete = counts.complete && counts.failed === 0;
  return counts;
}
