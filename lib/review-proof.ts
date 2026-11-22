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
 *   nl:rev:refunds:seenat:<statsId> -> refunds already handled and payments marked, scored by the row's time
 *   nl:rev:refunds:next:<statsId>  -> the store's turn for its pass, while the pass is not due
 *   nl:rev:refunds:rows:<statsId>:<window>  -> rows handled in the store's billing month
 *   nl:rev:refunds:marks:<statsId>:<window> -> payments marked in the store's billing month
 */
import { saleHandles } from "@/lib/store";
import { createHash, randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import { type LostRead, confirmLostRead, keptUnlessLost, lostCursorKey, lostDisputesOrRetry, refundRowKnown, refundedInFull, rowGivesBack } from "@/lib/refunds";
import { ordersGrant } from "@/lib/buyer-orders";
import { DOWNLOAD_WINDOW_SECONDS } from "@/lib/store-checkout";
import { PaymentsSpentError, REVIEW_STORES_KEY, ReviewBusyError, ReviewStoreGoneError, markRefunded } from "@/lib/reviews";
import { storeLiveFence } from "@/lib/store-live-cache";
import { type FencedCommand, countIfStoreLive, writeIfStoreLive } from "@/lib/live-fence";
import { windowId, windowKeySeconds } from "@/lib/allowance-window";
import { refreshStoreQuotes } from "@/lib/store-quotes";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import type { Tier } from "@/lib/plan";
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
      // Refunded in full or lost to a dispute (lib/refunds.ts); a dispute that
      // could not be read counts as not lost, as everywhere a door lets in.
      let refunded = refundedInFull(session.payment_intent) || (await keptUnlessLost(account, session.payment_intent));
      if (!INTENT_ID.test(pi) && session.mode === "subscription") {
        pi = await invoicePayment(account, session.invoice);
        if (pi) {
          const intent = await onAccount("GET", account, `/payment_intents/${encodeURIComponent(pi)}?expand[]=latest_charge`);
          refunded = refundedInFull(intent) || (await keptUnlessLost(account, intent));
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
          refunded: refundedInFull(intent) || (await keptUnlessLost(account, intent)),
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

// A review link written only while its erasure note is still there, in one step, so an erasure of the address that
// ran after the note (and deleted it) is never undone by a grant no later erasure can find (Codex Z on #3296).
// KEYS: the address's erasure note, the link. ARGV: the link's key as noted, the grant, its seconds. 1 written, 0 not.
const REVIEW_LINK_IF_NOTED =
  '-- marktmorgen:review-link-if-noted:v1\nif redis.call("ZSCORE", KEYS[1], ARGV[1]) then redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3]) return 1 else return 0 end';

/** A link for the review request: one order, one address, 60 days. Throws when its erasure note or its write does not read exactly, or when the address was erased meanwhile; nothing may be sent then. */
export async function mintReviewLink(store: Store, reference: string, email: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  const key = linkKey(token);
  const grant: LinkGrant = { s: store.statsId ?? "", r: reference, e: email };
  const notes = noteForErasure(store.statsId, email, key);
  // Read in their exact shape (CX-123 rule 24, as lib/checkout-recovery.ts reads a reminder's stop link). The erasure
  // note goes first, each reply a count: until it is known, nothing with the address is written (a note left for a
  // link never written only deletes nothing). So a link that may have landed is always one an erasure finds, whatever
  // its own pipeline answered, threw, or its take-back did (Codex Z on #3296).
  if (notes.length) {
    const noted = repliesFor(await redisPipeline(notes), notes.length);
    if (!noted || noted.some((reply) => countOf(reply) === null)) throw new UnknownReplyError("a review request's erasure note");
  }
  // Then the link: with a note, only while that note is still there (1 written, 0 not, as one step); without one (a
  // store with no stats id has no erasure note), a plain SET, "OK". Unknown, or a pipeline that threw, may have landed:
  // it is taken back at once so it is not kept 60 days unsent, and no token comes back, so no request is sent with a
  // link that may lead nowhere.
  const write: (string | number)[] = notes.length
    ? ["EVAL", REVIEW_LINK_IF_NOTED, 2, String(notes[0][1]), key, key, JSON.stringify(grant), REVIEW_LINK_SECONDS]
    : ["SET", key, JSON.stringify(grant), "EX", REVIEW_LINK_SECONDS];
  let written: unknown[] | null;
  try {
    written = repliesFor(await redisPipeline([write]), 1);
  } catch (error) {
    await takeBackLink(key, notes.length > 0);
    throw error;
  }
  // Its note is gone: the address was erased after the note was written. Nothing was written, so nothing is taken back.
  if (notes.length && written?.[0] === 0) throw new Error("a review request's address was erased before its link was written; no link was written");
  if (!written || written[0] !== (notes.length ? 1 : "OK")) {
    await takeBackLink(key, notes.length > 0);
    throw new UnknownReplyError("a review request's link");
  }
  return token;
}

/** Deletes an unsent review link that may have landed; a take-back not confirmed is logged with what may be left. */
async function takeBackLink(key: string, noted: boolean): Promise<void> {
  const gone = await redisPipeline([["DEL", key]]).then((replies) => repliesFor(replies, 1), () => null);
  if (gone && countOf(gone[0]) !== null) return;
  console.error(
    noted
      ? "an unsent review request's link may be left until it expires (60 days); it is noted for erasure, so deleting the person deletes it"
      : "an unsent review request's link may be left until it expires (60 days); its store has no stats id, so it has no erasure note",
  );
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

/**
 * The page a review form sends the buyer back to, with a word on what happened (`status`) and the part of the
 * page to open on: the thanks page when the order was proven by its checkout session, else the review page with
 * whatever proved the order. One rule for the route's answers and for the links the form draws itself ("Keep my
 * review"), so both land on the same page. `fields` are the door's fields (doorFields).
 */
export function reviewPagePath(handle: string, back: "thanks" | "review", fields: Record<string, string>, productId: string, status: string, fragment = `r-${productId}`): string {
  if (back === "thanks" && fields.session_id) {
    return `/@${handle}/thanks?${new URLSearchParams({ session_id: fields.session_id, review: status, product: productId })}#${fragment}`;
  }
  return `/@${handle}/review?${new URLSearchParams({ ...fields, status, product: productId })}#${fragment}`;
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
/**
 * Refund rows a store's passes may handle in a billing month, by its plan: a ceiling of what the pass may spend,
 * priced in tests/plan-cost-registry.ts (review-refund-sweep), as the certificates' pass has (lib/certificate-refunds.ts,
 * CERTIFICATE_REFUND_CHECKS_PER_MONTH; 9th triple audit on #5100, point 2). Every row not handled yet counts, with a
 * review or without, a payment's second part included; past it the pass stops where it is, keeps its place and goes
 * on next month: nothing is skipped. Several times the plan's orders: refunds are fewer than orders, a refund in parts
 * gives one row a part, and the lost disputes read with the first page (LOST_DISPUTE_PAGES of 100) count too, so a
 * healthy pass over several runs is never held. A store whose plan reads in no known way is held to the smallest.
 */
export const REVIEW_REFUND_ROWS_PER_MONTH: Readonly<Record<Tier, number>> = { creator: 1_000, pro: 2_000, scale: 5_000 };
/**
 * Payments whose reviews a store's passes may mark in a billing month, by its plan: the plan's orders
 * (ORDERS_INCLUDED), which is what the line prices at a mark's full cost (10th triple audit on #5100: the rows'
 * ceiling alone let up to a thousand older payments be marked at full cost in one month). Counted with the same exact
 * INCRBY before markRefunded; past it the row stays unhandled, the place keeps and the pass stops until next month.
 */
export const REVIEW_REFUND_PAYMENTS_PER_MONTH: Readonly<Record<Tier, number>> = ORDERS_INCLUDED;
/** Pages of refunds (100 each) one pass reads from the creator's account, at the most. */
export const REVIEW_REFUND_PAGES = 3;
const REFUND_PAGES = REVIEW_REFUND_PAGES;
const anchorKey = (statsId: string) => `nl:rev:refunds:since:${statsId}`;
/**
 * The refund rows handled and the payments marked, a sorted set scored by the row's time: trimmed each run below the
 * window read (ZREMRANGEBYSCORE), so it holds at most the window's rows and their payments, never the store's whole
 * history (Claude 2 lpgvy's MEDIUM 2 on #5100: a set whose expiry every write renewed had no bound). Under a name of
 * its own: nl:rev:refunds:seen: was a plain set until 22 November 2026, and a sorted-set command against it answers
 * WRONGTYPE on a real Redis (lpgvy's MEDIUM on #5100); nothing reads or writes that name any more, and its last keys
 * expire sixty-one days after their last write (tests/store-data-registry.ts keeps its family until then).
 */
const seenKey = (statsId: string) => `nl:rev:refunds:seenat:${statsId}`;
/**
 * The set the pass kept its handled rows in until 22 November 2026: written by no code since, read by none; a
 * closing store still deletes its keys (lib/data-families.ts), and the rest expire. Named here so the data registry
 * keeps the family until the last key is gone (tests/store-data-registry.ts).
 */
export const SEEN_SET_UNTIL_20261122 = "nl:rev:refunds:seen:";
/** The rows handled in a billing month (REVIEW_REFUND_ROWS_PER_MONTH), kept forty days at the least (countKeep). */
const rowsKey = (statsId: string, month: string) => `nl:rev:refunds:rows:${statsId}:${month}`;
/** The payments marked in a billing month (REVIEW_REFUND_PAYMENTS_PER_MONTH), kept forty days at the least (countKeep). */
const marksKey = (statsId: string, month: string) => `nl:rev:refunds:marks:${statsId}:${month}`;
/**
 * The month the ceilings count in: the store's billing month (lib/allowance-window.ts windowId, the window every
 * other allowance of the plan is counted in; the calendar month for a store not paying), so a ceiling is spent once
 * a billing month and the line prices it once (tests/plan-cost-registry.ts: a counter by the calendar month would
 * touch two in one billing month and be priced at two; 11th triple audit on #5100, ALTO (a)). Null for a paying store
 * whose period is not known: then nothing that costs money may start, and the pass does not run.
 */
const monthOf = (store: Store) => windowId(store);
/** Seconds a count of the month is kept: forty days, and never less than the window's own keep (windowKeySeconds). */
const countKeep = (store: Store) => windowKeySeconds(store, 40 * 86_400);
/** The store's figure of the month by its plan; the smallest for a plan read in no known way. */
function ofPlan(store: Store, figures: Readonly<Record<Tier, number>>): number {
  const tier = store.tier as unknown;
  return tier === "pro" || tier === "scale" ? figures[tier] : figures.creator;
}
/**
 * How often a store's pass runs, at the most: its turn is taken with one SET NX EX held this long (takeReviewPass), as
 * the certificates' pass does (lib/certificate-refunds.ts). Before 22/11/2026 the pass ran on every run of the
 * five-minute sweep for every store with reviews (288 a day), re-reading the refunds of the last thirty days and
 * the lost disputes each time: a spend with no line and no ceiling (Claude 1 c1-revcusto on #5092; MR). A refunded
 * buyer's review is marked within this long of the refund, never sooner than the sweep's next run.
 */
export const REVIEW_REFUND_PASS_EVERY_SECONDS = 2 * 3_600;
/**
 * How long the store's turn is held after a review of a refunded payment was busy (its product's lock held at every
 * try, lib/reviews.ts ReviewBusyError): the pass ends there, keeps its place and runs again a day later, so a review
 * busy at every try is tried at most REVIEW_REFUND_BUSY_RUNS times a month, each priced at the full tries
 * (tests/plan-cost-registry.ts; 11th triple audit on #5100, MÉDIO 3: a mark that failed was tried again at every
 * run with no price). A lock is held for milliseconds, so the next try almost always marks it.
 */
export const REVIEW_REFUND_BUSY_WAIT_SECONDS = 86_400;
const nextKey = (statsId: string) => `nl:rev:refunds:next:${statsId}`;
const NOT_DUE = "1";

/**
 * The stats ids of these stores whose review refund pass is due, read in one MGET for them all: a store's turn absent
 * (nil) is due; one that reads NOT_DUE is not. A reply in any other shape, for one store or for all, runs none of
 * those passes this run (CX-123 rule 24): nothing is marked and nothing is taken as seen, and the next run reads again.
 * Only a store paid through Stripe with a stats id can have a pass.
 */
export async function reviewPassesDue(stores: Store[]): Promise<Set<string>> {
  const due = new Set<string>();
  if (!isRedisConfigured()) return due;
  const sids = [...new Set(stores.filter((store) => store.stripeAccountId && store.statsId).map((store) => store.statsId as string))];
  if (!sids.length) return due;
  try {
    const values = repliesFor(await redisPipeline([["MGET", ...sids.map(nextKey)]]), 1)?.[0];
    if (!Array.isArray(values) || values.length !== sids.length) throw new UnknownReplyError("the turns for the reviews' refund pass");
    values.forEach((value, i) => {
      if (value === null) due.add(sids[i]);
      else if (value !== NOT_DUE) console.error("a store's turn for the reviews' refund pass did not read; no pass this run");
    });
  } catch (error) {
    console.error("the turns for the reviews' refund pass did not read; no pass this run", error instanceof Error ? error.name : typeof error);
    return new Set();
  }
  return due;
}

/**
 * Takes the store's turn for its pass, held REVIEW_REFUND_PASS_EVERY_SECONDS, with one SET NX EX read exactly: true
 * when this run took it; false when another run holds it. Any other reply throws: no pass runs on a turn not known to
 * be taken, so a pass never runs more often than its price says.
 */
export async function takeReviewPass(store: Store): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const taken = repliesFor(await redisPipeline([["SET", nextKey(store.statsId), NOT_DUE, "NX", "EX", REVIEW_REFUND_PASS_EVERY_SECONDS]]), 1)?.[0];
  if (taken === null) return false;
  if (taken !== "OK") throw new UnknownReplyError("the store's turn for the reviews' refund pass");
  return true;
}

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
  // The billing month the ceilings count in, one for the run; a paying store whose period is not known starts nothing
  // that costs money (lib/allowance-window.ts): no pass, its turn runs out as taken.
  const month = monthOf(store);
  if (month === null) {
    console.error("reviews' refund pass: the store's billing month is not known; no pass this turn", store.handle);
    return 0;
  }
  const keep = countKeep(store);
  const fence = await storeLiveFence(store);
  // The pass's own keys (the read refunds, the anchor) are written only while the store is live, in one step with the
  // fence's reads (lib/live-fence.ts): false when the store is erasing or gone, and then nothing was written; an answer
  // of another shape throws (rule 24). So a store closed during the Stripe read, before any review is marked, never
  // gets them back after the closing walk passed them (Claude 1 E on #5092).
  const keyed = (command: (string | number)[]): FencedCommand => [command[0], { key: String(command[1]) }, ...command.slice(2)];
  const writeWhileLive = async (commands: (string | number)[][]): Promise<boolean> => {
    const written = await writeIfStoreLive(fence, commands.map(keyed));
    if (written === "unknown") throw new UnknownReplyError("the refund pass's keys, written while the store is live");
    return written === "kept";
  };
  /**
   * Adds `n` to a count of the month through the fence (COUNT_IF_STORE_LIVE: INCRBY and EXPIRE, kept `keep` seconds,
   * in one step with the fence's reads): the count after it, or "gone" for a store erasing or gone (nothing written);
   * an answer in another shape throws (rule 24), so nothing it guarded is handled this run.
   */
  const countWhileLive = async (key: string, n: number): Promise<number | "gone"> => {
    const answer = await countIfStoreLive(fence, key, n, keep);
    if (answer === "unknown") throw new UnknownReplyError("a count of the month");
    return answer;
  };
  /** Gives `n` back to a count of the month, through the fence (a store gone gets nothing written). */
  const giveBackWhileLive = async (key: string, n: number): Promise<void> => {
    if (n > 0) await writeWhileLive([["DECRBY", key, n]]);
  };
  /**
   * Puts off the store's next pass REVIEW_REFUND_BUSY_WAIT_SECONDS after a busy review, with one SET EX over the turn
   * this run holds, through the fence (a store gone gets nothing written; a reply in another shape only leaves the
   * turn at its two hours, and the tries are then bounded by the turn as before).
   */
  const deferWhileLive = async (): Promise<void> => {
    await writeIfStoreLive(fence, [["SET", { key: nextKey(statsId) }, NOT_DUE, "EX", REVIEW_REFUND_BUSY_WAIT_SECONDS]]);
  };
  const now = Math.floor(Date.now() / 1000);
  const [anchorRaw] = await redisPipeline([["GET", anchorKey(statsId)]]);
  const anchor = Number(anchorRaw) > 0 ? Number(anchorRaw) : now - REFUND_LOOKBACK_SECONDS;
  const since = Math.max(0, anchor - 300);
  // Rows older than the window are never read again: their ids and payments leave the seen set (one command a run;
  // a reply in another shape only leaves them a run longer).
  await redisPipeline([["ZREMRANGEBYSCORE", seenKey(statsId), "-inf", String(since - 1)]]);
  let newest = anchor;
  let marked = 0;
  let after = "";
  let complete = false;
  // A failed or unfinished read of the lost disputes keeps the anchor.
  let unsure = false;
  let lostRead: LostRead | null = null;
  // The store's erasure began, or its record is gone, under a mark's fence (ReviewStoreGoneError): the pass stops at
  // once and writes nothing more for the store, so the read refunds, the anchor, the lost disputes' place and the
  // quotes never come back after the closing walk passed them (Claude 1 on #5092). The closing walk erases the rest.
  let gone = false;
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
        const raw = await onAccount("GET", store.stripeAccountId, `/refunds?${query}`);
        const latest = Math.floor(Date.now() / 1000) + 300;
        listed = readStripePage(raw, row => refundRowKnown(row) && (row.created as number) <= latest);
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
      const full = [...(lost?.rows ?? []), ...refunds]
        .filter((refund) => typeof refund.id === "string" && refund.id && rowGivesBack(refund))
        .map((refund) => ({ id: refund.id as string, created: typeof refund.created === "number" ? refund.created : 0, pi: idOf(refund.payment_intent) }));
      // Which of them an earlier pass already took, and which payments it already marked, in one command for the
      // page (ZMSCORE: the rows' ids, then the payments' ids), read exactly: one answer each, null (never taken) or
      // the time it was taken at; anything else is unknown, and the page is not handled this run (its anchor keeps).
      // A payment refunded in parts gives one row a part, each with the charge refunded: its reviews are marked with
      // the first row handled, and the rows after it are only taken as seen (9th triple audit on #5100, point 1).
      const pis = [...new Set(full.map((refund) => refund.pi).filter((pi) => INTENT_ID.test(pi)))];
      const asked = [...full.map((refund) => refund.id), ...pis];
      const scores = asked.length ? repliesFor(await redisPipeline([["ZMSCORE", seenKey(statsId), ...asked]]), 1)?.[0] : [];
      if (!Array.isArray(scores) || scores.length !== asked.length || !scores.every((score) => score === null || Number.isFinite(Number(score)))) {
        throw new UnknownReplyError("which of the refunds' rows were already read");
      }
      const seen = (scores as unknown[]).map((score) => score !== null);
      const paymentSeen = new Set(pis.filter((_, i) => seen[full.length + i]));
      const unseen = full.filter((_, i) => !seen[i]);
      // The month's rows (REVIEW_REFUND_ROWS_PER_MONTH), taken for the page's rows not handled yet before any is:
      // past the ceiling only what was left of it is handled, oldest first, the place keeps (unsure) and the pass
      // ends here; the rest waits for next month. Nothing is skipped. What is taken and not handled after all is
      // given back when the page ends, however it ends.
      let allowed = unseen.length;
      let spent = false;
      if (unseen.length > 0) {
        const ceiling = ofPlan(store, REVIEW_REFUND_ROWS_PER_MONTH);
        // Counted through the store's fence (lib/live-fence.ts COUNT_IF_STORE_LIVE): a store erasing meanwhile gets
        // no count of the month written back (10th audit on #5092, LEVE 5), and the pass stops here.
        const after = await countWhileLive(rowsKey(statsId, month), unseen.length);
        if (after === "gone") {
          gone = true;
          break;
        }
        if (after > ceiling) {
          allowed = Math.max(0, ceiling - (after - unseen.length));
          spent = true;
          console.error(`reviews' refund pass: a store's rows of the month are spent (${ceiling}); the rest waits for next month`, store.handle);
        }
      }
      // The rows handled this run: every one not handled yet, or, past the ceiling, the oldest of them (the page
      // reads newest first) up to what was left.
      const kept = allowed >= unseen.length ? unseen : allowed > 0 ? unseen.slice(unseen.length - allowed) : [];
      const handled = new Set(kept.map((refund) => refund.id));
      let done = 0;
      let busy = false;
      try {
        for (const [i, refund] of full.entries()) {
          if (seen[i]) {
            newest = Math.max(newest, refund.created);
            continue;
          }
          if (!handled.has(refund.id)) continue;
          const payment = INTENT_ID.test(refund.pi) && !paymentSeen.has(refund.pi);
          if (payment) {
            // One of the month's payments (REVIEW_REFUND_PAYMENTS_PER_MONTH), taken inside the mark once the payment
            // is known to have reviews (a payment with none is a row, not a payment): past the ceiling the row stays
            // unhandled (its take given back), the place keeps and the pass ends here; a mark that fails after the
            // take (a busy review) gives it back too. Through the fence: a store gone meanwhile is not counted.
            const payments = ofPlan(store, REVIEW_REFUND_PAYMENTS_PER_MONTH);
            let taken = false;
            const take = async (): Promise<"ok" | "spent"> => {
              const count = await countWhileLive(marksKey(statsId, month), 1);
              if (count === "gone") throw new ReviewStoreGoneError();
              if (count > payments) {
                await giveBackWhileLive(marksKey(statsId, month), 1);
                return "spent";
              }
              taken = true;
              return "ok";
            };
            try {
              marked += await markRefunded(statsId, refund.pi, fence, take);
            } catch (error) {
              if (error instanceof PaymentsSpentError) {
                spent = true;
                console.error(`reviews' refund pass: a store's payments of the month are spent (${payments}); the rest waits for next month`, store.handle);
                break;
              }
              if (error instanceof ReviewStoreGoneError) {
                gone = true;
                break;
              }
              if (taken) await giveBackWhileLive(marksKey(statsId, month), 1);
              if (error instanceof ReviewBusyError) {
                // A review busy at every try: the row is not taken as seen and the place keeps, so the next pass
                // marks it; that pass is a day off (deferWhileLive), never the next run, so a review busy at every
                // try is tried at most REVIEW_REFUND_BUSY_RUNS times a month, each within its price.
                busy = true;
                console.error(`reviews' refund pass: a review is busy; the pass tries again in ${REVIEW_REFUND_BUSY_WAIT_SECONDS} s`, store.handle);
                break;
              }
              throw error;
            }
            paymentSeen.add(refund.pi);
          }
          // Taken only once its reviews are marked: a busy review throws first, so the next pass tries it again.
          // Written only while the store is live: gone meanwhile, the pass stops here.
          if (!(await writeWhileLive([
            ["ZADD", seenKey(statsId), refund.created, refund.id, ...(payment ? [refund.created, refund.pi] : [])],
            ["EXPIRE", seenKey(statsId), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
          ]))) {
            gone = true;
            break;
          }
          done += 1;
          newest = Math.max(newest, refund.created);
        }
      } finally {
        // What the page took and did not handle goes back, through the fence too (nothing for a store gone).
        if (!gone) await giveBackWhileLive(rowsKey(statsId, month), unseen.length - done);
      }
      if (gone) break;
      if (busy) await deferWhileLive();
      if (spent || busy) {
        unsure = true;
        break;
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
    if (marked > 0 && !gone) await refreshStoreQuotes(store);
  }
  if (gone) return marked;
  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead); a sweep
  // that went on from a kept place moves the job no further than the newest closing it read, so a dispute closed
  // meanwhile is read from the top next run (review of #2158, inbox C4-24).
  if (lostRead) {
    if (!(await confirmLostRead(lostRead, seenKey(statsId), "sorted"))) unsure = true;
    else if (lostRead.complete) newest = lostRead.resumed ? lostRead.newest : Math.max(newest, lostRead.newest);
  }
  // The place moves only past what was read to the end, sure and inside its time. A store with no place yet keeps
  // the one it started from, so the next run reads the same window and the lost disputes' kept place still counts; its
  // refunds already read are kept as long (reviews of #2158). Otherwise nothing is written: a place that cannot move
  // lapses as it always did, and the read refunds, kept sixty-one days after the last one, always outlive it.
  const done = complete && !unsure && Date.now() < deadline;
  if (done) await writeWhileLive([["SET", anchorKey(statsId), String(Math.max(newest, anchor)), "EX", REFUND_LOOKBACK_SECONDS * 2]]);
  else if (!(Number(anchorRaw) > 0)) {
    await writeWhileLive([
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
