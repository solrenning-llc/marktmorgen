/**
 * Proof that a review comes from a buyer: the order behind it, as the
 * creator's own Stripe account tells it, every time a review is written,
 * changed or deleted — and the refunds that take a review's stars back.
 *
 * Nothing about purchases is written down by Marktmorgen (lib/buyer-orders.ts),
 * so a review is never checked against a list of ours. The buyer comes
 * through one of three doors, each holding something only a buyer has, and
 * the order that door names is then read from Stripe:
 *
 *   - the thanks page, by its checkout id, for the three days its download
 *     works (the same window, lib/store-checkout.ts);
 *   - the list of purchases, by the emailed link that opened it (24 hours)
 *     and one of the orders on it (lib/buyer-orders.ts);
 *   - the link in the one email that asks for a review (60 days), which
 *     names one order and the address it went to.
 *
 * An order counts when it is this store's, paid (not merely free after a
 * discount, and not a trial that has charged nothing yet), and not refunded
 * in full — the rule every other door uses (lib/refunds.ts). A checkout
 * counts for the product bought and the product ticked at checkout; an offer
 * taken in one click after paying counts for what it added. Booked calls are
 * not reviewed here.
 *
 * A refund that comes later is found by the five-minute job, which reads the
 * refunds on the creator's account for stores that have reviews and marks
 * each review that payment paid for (lib/reviews.ts, markRefunded).
 *
 *   nl:rev:link:<hash>             -> the order and address a review link is for, 60 days
 *   nl:rev:refunds:since:<statsId> -> how far the refund pass has read
 *   nl:rev:refunds:seen:<statsId>  -> refunds already handled
 */
import { saleHandles } from "@/lib/store";
import { createHash, randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import { type LostRead, confirmLostRead, confirmedBack, lostCursorKey, lostDisputesOrRetry, noteHeld, refundChecks, refundRowKnown, refundRowState, settleParts } from "@/lib/refunds";
import { ordersGrant } from "@/lib/buyer-orders";
import { DOWNLOAD_WINDOW_SECONDS } from "@/lib/store-checkout";
import { REVIEW_STORES_KEY, markRefunded } from "@/lib/reviews";
import { refreshStoreQuotes } from "@/lib/store-quotes";
import type { Listing, Store } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { deliveredIds } from "@/lib/bundle-rules";
import { takesReviews } from "@/lib/house-store";
import { noteForErasure } from "@/lib/erasure-index";
import { type StripePage, StripeListUnreadable, ownField, plainObject, readStripePage } from "@/lib/stripe-list";

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const INTENT_ID = /^pi_[A-Za-z0-9]{10,200}$/;
const INVOICE_ID = /^in_[A-Za-z0-9]{6,200}$/;
export const REVIEW_LINK_PATTERN = /^[0-9a-f]{48}$/;
/** How long the link in a review request keeps working. */
export const REVIEW_LINK_SECONDS = 60 * 86_400;

export type Proof = {
  reference: string;
  /** The address the order was paid with, as Stripe has it. */
  email: string;
  /** What this order paid for that can be reviewed here. */
  products: Listing[];
  /** The payment behind it, so a later refund can find the review. "" when Stripe did not say. */
  pi: string;
  /** When it was paid, in seconds. */
  paidAt: number;
  refunded: boolean;
};

export type ProofResult = { state: "ok"; proof: Proof } | { state: "no" | "expired" | "error" };

/**
 * A product that can be reviewed at all: still listed, paid, not a booked
 * call. A bundle is not reviewed itself: each product in it is, by whoever
 * bought the bundle (lib/bundle-rules.ts).
 */
export function reviewable(product: Listing | null | undefined): product is Listing {
  return Boolean(product && product.priceCents > 0 && !product.call && !product.bundle);
}

type Row = Record<string, unknown>;

const idOf = (value: unknown): string =>
  typeof value === "string" ? value : value && typeof value === "object" && typeof (value as Row).id === "string" ? ((value as Row).id as string) : "";

/** The payment a membership's first invoice was paid with, whichever way this API version names it. */
async function invoicePayment(account: string, invoice: unknown): Promise<string> {
  const id = idOf(invoice);
  if (!INVOICE_ID.test(id)) return "";
  const read = invoice && typeof invoice === "object" ? (invoice as Row) : await onAccount("GET", account, `/invoices/${encodeURIComponent(id)}`);
  const direct = idOf(read.payment_intent);
  if (INTENT_ID.test(direct)) return direct;
  // Read in its exact shape (lib/stripe-list.ts): a page in another shape, a row not readable, or a failure to read
  // throws, and provePurchase says "error". "No payment" ("") only from a readable page: none listed, or the first
  // one paid otherwise than by a PaymentIntent. Never a membership taken as not refunded on a guess.
  const listed = readStripePage(
    await onAccount("GET", account, `/invoice_payments?${new URLSearchParams({ invoice: id, limit: "1" })}`),
    (row) => plainObject(ownField(row, "payment")),
  );
  if (listed.unreadable) throw new StripeListUnreadable("an invoice payment not readable");
  const payment = listed.rows[0] ? (ownField(listed.rows[0], "payment") as Row) : null;
  const pi = idOf(payment ? ownField(payment, "payment_intent") : undefined);
  return INTENT_ID.test(pi) ? pi : "";
}

/**
 * Reads one order from the creator's Stripe account and says whether it is
 * a paid purchase from this store, what it can be reviewed for, and whether
 * it was refunded in full.
 */
export async function provePurchase(store: Store, reference: string): Promise<ProofResult> {
  const account = store.stripeAccountId;
  if (!account) return { state: "no" };
  // The demo store takes none (lib/house-store.ts): a purchase there is free.
  if (!takesReviews(store)) return { state: "no" };
  const handles = saleHandles(store);
  try {
    if (SESSION_ID.test(reference)) {
      const session = await onAccount(
        "GET",
        account,
        `/checkout/sessions/${encodeURIComponent(reference)}?expand[]=payment_intent.latest_charge`,
      );
      const meta = (session.metadata ?? {}) as Record<string, string>;
      if (!handles.has(meta.store ?? "") || meta.kind === "call") return { state: "no" };
      if (!isSettled(session) || session.payment_status !== "paid") return { state: "no" };
      if (typeof session.amount_total !== "number" || session.amount_total <= 0) return { state: "no" };
      // Read by id (lib/catalog.ts), however many products the store has.
      // What was bought, what was ticked, and each product of a bundle among them.
      const products = (await readListings(store, deliveredIds(meta))).filter(reviewable);
      const details = session.customer_details as { email?: unknown } | null;
      const email =
        typeof details?.email === "string" && details.email
          ? details.email
          : typeof session.customer_email === "string"
            ? session.customer_email
            : "";
      if (!email || products.length === 0) return { state: "no" };
      let pi = idOf(session.payment_intent);
      // Refunded in full and confirmed, or lost to a dispute (lib/refunds.ts, confirmedBack): a full refund still on
      // its way, or an answer that could not be read, counts as not given back, as everywhere a door lets in
      // (the owner's decision 18).
      let refunded = await confirmedBack(account, session.payment_intent);
      if (!INTENT_ID.test(pi) && session.mode === "subscription") {
        pi = await invoicePayment(account, session.invoice);
        if (pi) {
          const intent = await onAccount("GET", account, `/payment_intents/${encodeURIComponent(pi)}?expand[]=latest_charge`);
          refunded = await confirmedBack(account, intent);
        }
      }
      return {
        state: "ok",
        proof: {
          reference,
          email,
          products,
          pi: INTENT_ID.test(pi) ? pi : "",
          paidAt: typeof session.created === "number" ? session.created : 0,
          refunded,
        },
      };
    }
    if (INTENT_ID.test(reference)) {
      const intent = await onAccount("GET", account, `/payment_intents/${encodeURIComponent(reference)}?expand[]=latest_charge`);
      const meta = (intent.metadata ?? {}) as Record<string, string>;
      if (meta.kind !== "upsell" || !handles.has(meta.store ?? "")) return { state: "no" };
      if (intent.status !== "succeeded" || typeof intent.amount !== "number" || intent.amount <= 0) return { state: "no" };
      // What was added: the product, or each product of a bundle added.
      const products = (await readListings(store, deliveredIds(meta))).filter(reviewable);
      if (products.length === 0) return { state: "no" };
      let email = typeof intent.receipt_email === "string" ? intent.receipt_email : "";
      if (!email && SESSION_ID.test(meta.parent ?? "")) {
        const parent = await onAccount("GET", account, `/checkout/sessions/${encodeURIComponent(meta.parent)}`);
        const details = parent.customer_details as { email?: unknown } | null;
        email = typeof details?.email === "string" ? details.email : "";
      }
      if (!email) return { state: "no" };
      return {
        state: "ok",
        proof: {
          reference,
          email,
          products,
          pi: reference,
          paidAt: typeof intent.created === "number" ? intent.created : 0,
          refunded: await confirmedBack(account, intent),
        },
      };
    }
    return { state: "no" };
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return { state: "no" };
    console.error("reading an order for a review failed", error);
    return { state: "error" };
  }
}

/** What a buyer holds that lets them write about one order. */
export type Door =
  | { via: "session"; session: string }
  | { via: "orders"; token: string; reference: string }
  | { via: "ask"; token: string };

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:rev:link:${sha(`nimbus-review-link:${token}`).slice(0, 40)}`;

type LinkGrant = { s: string; r: string; e: string };

/** A link for the review request: one order, one address, 60 days. */
export async function mintReviewLink(store: Store, reference: string, email: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  const grant: LinkGrant = { s: store.statsId ?? "", r: reference, e: email };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", REVIEW_LINK_SECONDS], ...noteForErasure(store.statsId, email, linkKey(token))]);
  return token;
}

async function readLink(store: Store, token: string): Promise<LinkGrant | null> {
  if (!REVIEW_LINK_PATTERN.test(token) || !isRedisConfigured()) return null;
  // Absent (null) is a link that ran out; any other answer is not known and throws, never "expired" (rule 24).
  const reply = repliesFor(await redisPipeline([["GET", linkKey(token)]]), 1);
  if (!reply || (reply[0] !== null && typeof reply[0] !== "string")) throw new UnknownReplyError("a review link");
  const raw = reply[0];
  if (!raw) return null;
  try {
    const grant = JSON.parse(raw) as Partial<LinkGrant>;
    if (grant.s !== store.statsId || typeof grant.r !== "string" || typeof grant.e !== "string") return null;
    return { s: grant.s, r: grant.r, e: grant.e };
  } catch {
    return null;
  }
}

/**
 * The order a door opens, proved, and only for the buyer who holds it. The
 * address a link was sent to has to be the address the order was paid with.
 */
export async function openDoor(store: Store, door: Door, nowSeconds = Date.now() / 1000): Promise<ProofResult> {
  if (door.via === "session") {
    if (!SESSION_ID.test(door.session)) return { state: "no" };
    const result = await provePurchase(store, door.session);
    if (result.state !== "ok") return result;
    return nowSeconds - result.proof.paidAt > DOWNLOAD_WINDOW_SECONDS ? { state: "expired" } : result;
  }
  const expected = door.via === "orders" ? await ordersGrant(store, door.token) : null;
  // A link that cannot be read just now is an error the page says as such, never an expired link.
  const link = door.via === "ask" ? await readLink(store, door.token).catch((error: unknown) => (error instanceof UnknownReplyError ? "error" as const : Promise.reject(error))) : null;
  if (link === "error") return { state: "error" };
  const email = door.via === "orders" ? expected : link?.e ?? null;
  const reference = door.via === "orders" ? door.reference : link?.r ?? "";
  if (!email || !reference) return { state: "expired" };
  const result = await provePurchase(store, reference);
  if (result.state !== "ok") return result;
  return normaliseEmail(result.proof.email) === normaliseEmail(email) ? result : { state: "no" };
}

/** The door as the hidden fields of a form carry it, and back. */
export function doorFields(door: Door): Record<string, string> {
  if (door.via === "session") return { session_id: door.session };
  if (door.via === "orders") return { token: door.token, ref: door.reference };
  return { ask: door.token };
}

export function readDoor(get: (name: string) => string): Door | null {
  const ask = get("ask").slice(0, 60);
  if (REVIEW_LINK_PATTERN.test(ask)) return { via: "ask", token: ask };
  const token = get("token").slice(0, 80);
  const ref = get("ref").slice(0, 220);
  if (/^[0-9a-f]{64}$/.test(token) && (SESSION_ID.test(ref) || INTENT_ID.test(ref))) return { via: "orders", token, reference: ref };
  const session = get("session_id").slice(0, 220);
  if (SESSION_ID.test(session)) return { via: "session", session };
  return null;
}

// ---------------------------------------------------------------- refunds

const REFUND_LOOKBACK_SECONDS = 30 * 86_400;
const REFUND_PAGES = 3;
const anchorKey = (statsId: string) => `nl:rev:refunds:since:${statsId}`;
const seenKey = (statsId: string) => `nl:rev:refunds:seen:${statsId}`;

/** Whether a store has any review, so the refund pass is worth a call to Stripe. */
export async function storeHasReviews(store: Store): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const [member] = await redisPipeline([["SISMEMBER", REVIEW_STORES_KEY, store.statsId]]);
  return Number(member) === 1;
}

/**
 * Reads the refunds made on the creator's account since the last pass and
 * marks every review a fully refunded payment paid for. A partial refund
 * changes nothing. Returns how many reviews it marked.
 */
export async function markRefundedReviews(store: Store, deadline: number): Promise<number> {
  if (!store.stripeAccountId || !store.statsId || !isRedisConfigured()) return 0;
  const statsId = store.statsId;
  const now = Math.floor(Date.now() / 1000);
  const [anchorRaw] = await redisPipeline([["GET", anchorKey(statsId)]]);
  const anchor = Number(anchorRaw) > 0 ? Number(anchorRaw) : now - REFUND_LOOKBACK_SECONDS;
  const since = Math.max(0, anchor - 300);
  let newest = anchor;
  let marked = 0;
  let after = "";
  let complete = false;
  // A failed or unfinished read of the lost disputes keeps the anchor.
  let unsure = false;
  let lostRead: LostRead | null = null;
  // The earliest refund left for later because its money is not back for good yet: the anchor never moves past it.
  let holdAt = Number.POSITIVE_INFINITY;
  // Reads of a charge's own refunds and alert marks this run may make (lib/refunds.ts, CHARGE_REFUND_READS).
  const checks = refundChecks();
  try {
    for (let page = 0; page < REFUND_PAGES && Date.now() < deadline; page += 1) {
      const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
      query.append("expand[]", "data.charge");
      if (after) query.set("starting_after", after);
      // The page in its exact shape (lib/stripe-list.ts), each row by the refunds' own rule (refundRowKnown,
      // lib/refunds.ts: its id, time, status, payment and charge.refunded as Stripe gives them). A page in another
      // shape, or a row not readable, keeps the anchor (unsure), so no refund on it is passed over; the readable
      // rows are still marked (Codex P on #2774).
      let listed: StripePage;
      try {
        listed = readStripePage(await onAccount("GET", store.stripeAccountId, `/refunds?${query}`), refundRowKnown);
      } catch (error) {
        if (!(error instanceof StripeListUnreadable)) throw error;
        console.error("reading refunds for reviews: a page in another shape", error);
        unsure = true;
        break;
      }
      if (listed.unreadable) unsure = true;
      const refunds: Row[] = listed.rows;
      // A dispute closed as lost marks its reviews as a
      // full refund does (lib/refunds.ts, queue 388 [TB14]): read once, with
      // the first page, from Stripe's closing events (kept thirty days).
      const lost = page === 0 ? await lostDisputesOrRetry(store.stripeAccountId, since, deadline, lostCursorKey("rev", statsId)) : null;
      if (lost) lostRead = lost;
      if (lost && !lost.complete) unsure = true;
      // What gives back on the page, and which of it an earlier pass already took: one request for the page, and
      // nothing written again for one already taken (each pass reads the last days' refunds again).
      // Only money back for good marks a review (lib/refunds.ts, refundRowState; the owner's decision 18): a refund
      // still on its way marks nothing and holds the anchor at its time, so the next run reads it again (said in the
      // log past seven days); a succeeded part marks only once its charge's succeeded refunds add up to it.
      const full: { id: string; created: number; pi: string; row: Row; parts: boolean }[] = [];
      for (const refund of [...(lost?.rows ?? []), ...refunds]) {
        if (typeof refund.id !== "string" || !refund.id) continue;
        const created = typeof refund.created === "number" ? refund.created : 0;
        const state = refundRowState(refund);
        if (state === "held") {
          holdAt = Math.min(holdAt, created);
          await noteHeld(refund, checks);
        } else if (state !== "no") full.push({ id: refund.id, created, pi: idOf(refund.payment_intent), row: refund, parts: state === "parts" });
      }
      const seen = full.length ? await redisPipeline(full.map((refund) => ["SISMEMBER", seenKey(statsId), refund.id])) : [];
      for (const [i, refund] of full.entries()) {
        if (Number(seen[i]) !== 1) {
          if (refund.parts && (await settleParts(store.stripeAccountId, refund.row, checks)) !== "back") {
            holdAt = Math.min(holdAt, refund.created);
            continue;
          }
          if (INTENT_ID.test(refund.pi)) marked += await markRefunded(statsId, refund.pi);
          // Taken only once its reviews are marked: a busy review throws first, so the next pass tries it again.
          await redisPipeline([
            ["SADD", seenKey(statsId), refund.id],
            ["EXPIRE", seenKey(statsId), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
          ]);
        }
        newest = Math.max(newest, refund.created);
      }
      if (!listed.hasMore) {
        complete = true;
        break;
      }
      // More pages, and no readable last row to read them from: not complete.
      if (!listed.lastId) break;
      after = listed.lastId;
    }
  } finally {
    // A refunded review leaves "What buyers say" on the store page (lib/store-quotes.ts), also when a busy review
    // stopped the pass after others were marked.
    if (marked > 0) await refreshStoreQuotes(store);
  }
  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead); a sweep
  // that went on from a kept place moves the job no further than the newest closing it read, so a dispute closed
  // meanwhile is read from the top next run (review of #2158, inbox C4-24).
  if (lostRead) {
    if (!(await confirmLostRead(lostRead, seenKey(statsId)))) unsure = true;
    else if (lostRead.complete) newest = lostRead.resumed ? lostRead.newest : Math.max(newest, lostRead.newest);
  }
  // The place moves only past what was read to the end, sure and inside its time. A store with no place yet keeps
  // the one it started from, so the next run reads the same window and the lost disputes' kept place still counts; its
  // refunds already read are kept as long (reviews of #2158). Otherwise nothing is written: a place that cannot move
  // lapses as it always did, and the read refunds, kept sixty-one days after the last one, always outlive it.
  const done = complete && !unsure && Date.now() < deadline;
  // A refund held for later keeps the anchor at its time, never before where it already was (decision 18).
  if (done) await redisPipeline([["SET", anchorKey(statsId), String(Math.max(Math.min(newest, holdAt), anchor)), "EX", REFUND_LOOKBACK_SECONDS * 2]]);
  else if (!(Number(anchorRaw) > 0)) {
    await redisPipeline([
      ["SET", anchorKey(statsId), String(anchor), "EX", REFUND_LOOKBACK_SECONDS * 2],
      ["EXPIRE", seenKey(statsId), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
    ]);
  }
  return marked;
}

/** A short form of an order reference, for the studio: enough to find it in Stripe. */
export function shortReference(reference: string): string {
  return reference.length > 16 ? `${reference.slice(0, 8)}…${reference.slice(-6)}` : reference;
}
