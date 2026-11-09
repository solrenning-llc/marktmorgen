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
 *   nl:rev:refunds:pass:<statsId>  -> where a pass over the refunds stands, seven days after it last moved
 */
import { saleHandles } from "@/lib/store";
import { createHash, randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import { type LostRead, confirmLostRead, keptUnlessLost, lostCursorKey, lostDisputesOrRetry, refundRowKnown, refundedInFull, rowGivesBack } from "@/lib/refunds";
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
/**
 * Where a pass over a store's refunds stands, kept between runs (Claude 5's audit of the Stripe reads, A3): a pass reads
 * the window from its anchor to its end, newest first, and may take several runs. Without it every run read the same
 * newest pages again, and a refund past them was never read.
 */
const passKey = (statsId: string) => `nl:rev:refunds:pass:${statsId}`;
/** How long a pass is kept without moving: well past the runs it takes; one left behind starts again from the anchor. */
const REFUND_PASS_SECONDS = 7 * 86_400;
/** A refund's id as the pass keeps it, to read on from (Stripe's `starting_after`). */
const REFUND_CURSOR = /^[A-Za-z0-9_]{3,255}$/;
/**
 * The Redis commands one run sends for its place in a store's refunds, outside the rows it reads (CX-123 rule 24): one
 * GET of the anchor and one of the pass, then at most three writes, either the pass kept (SET, with the anchor and the
 * read set's expiry written as before when the store had no anchor yet) or, at the end of a pass, the pass deleted and,
 * unless the pass left something unknown and the anchor cannot move, the anchor written and the read set's expiry
 * renewed. The pass is one key a store, under 400 bytes, kept
 * REFUND_PASS_SECONDS. A run still reads at most REFUND_PAGES pages of refunds.
 */
export const REVIEW_REFUND_PLACE_COMMANDS = 5;

/**
 * A pass over the refunds: `from` the anchor it began at (the window starts 300 seconds before), `start` when it began
 * (the anchor never moves past it), `after` the last refund it read to the end, `newest` the latest refund it handled,
 * and `floor` the earliest one it left unknown (null when none), below which the anchor stays.
 */
type RefundPass = { from: number; start: number; after: string; newest: number; floor: number | null };

const passSeconds = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A kept pass read exactly; anything else is no pass, and a new one starts from the anchor, which never moved past it. */
function readRefundPass(raw: unknown): RefundPass | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!plainObject(value)) return null;
  const from = ownField(value, "from");
  const start = ownField(value, "start");
  const after = ownField(value, "after");
  const newest = ownField(value, "newest");
  const floor = ownField(value, "floor");
  if (!passSeconds(from) || !passSeconds(start) || !passSeconds(newest) || (floor !== null && !passSeconds(floor))) return null;
  if (typeof after !== "string" || !REFUND_CURSOR.test(after) || start < from || newest < from) return null;
  return { from, start, after, newest, floor };
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
 *
 * A run reads at most REFUND_PAGES pages. A pass from the anchor to the end of
 * the window may take several runs: where it stands is kept (passKey), so the
 * next run goes on from the last refund read instead of the newest one again
 * (Claude 5's audit of the Stripe reads, A3: 300 newer partial refunds kept a
 * full refund unread and its review counting its stars). A run that resumes a
 * pass first reads the newest page, so a refund made meanwhile does not wait
 * for the pass. A refund left unknown (a review busy just then, a row that
 * does not read) never holds the pass back, only the anchor: the anchor moves
 * at the end of a pass, never past such a refund, so the next pass reads it
 * again.
 */
export async function markRefundedReviews(store: Store, deadline: number): Promise<number> {
  if (!store.stripeAccountId || !store.statsId || !isRedisConfigured()) return 0;
  const statsId = store.statsId;
  const account = store.stripeAccountId;
  const now = Math.floor(Date.now() / 1000);
  const [anchorRaw, passRaw] = await redisPipeline([["GET", anchorKey(statsId)], ["GET", passKey(statsId)]]);
  const anchor = Number(anchorRaw) > 0 ? Number(anchorRaw) : now - REFUND_LOOKBACK_SECONDS;
  // A pass an earlier run began goes on from where it stopped (A3); none, or one in an unknown shape, begins at the
  // anchor, which never moved past anything a pass left unread.
  const kept = readRefundPass(passRaw);
  const pass: RefundPass = kept ? { ...kept } : { from: anchor, start: now, after: "", newest: anchor, floor: null };
  // A little overlap, so a refund created in the second the last pass read is
  // not missed; the set of refunds already read keeps it from counting twice.
  const since = Math.max(0, pass.from - 300);
  let marked = 0;
  /** The anchor stays at or below a refund of this pass left unknown: the next pass reads it again. */
  const hold = (created: number) => {
    pass.floor = pass.floor === null ? created : Math.min(pass.floor, created);
  };

  /**
   * Rows read: each that gives back in full, and that no earlier pass already took, marks its reviews and is then
   * taken. One request for the rows, and nothing written again for one already taken (each pass reads the last days'
   * refunds again). `inPass` false for the newest page a resuming run reads first, which never moves the pass: a refund
   * of the pass's window it leaves unknown is read again by the pass, and a newer one is in the next pass's window.
   */
  const take = async (rows: Row[], inPass: boolean): Promise<void> => {
    const full = rows
      .filter((refund) => typeof refund.id === "string" && refund.id && rowGivesBack(refund))
      .map((refund) => ({ id: refund.id as string, created: typeof refund.created === "number" ? refund.created : 0, pi: idOf(refund.payment_intent) }));
    const seen = full.length ? await redisPipeline(full.map((refund) => ["SISMEMBER", seenKey(statsId), refund.id])) : [];
    for (const [i, refund] of full.entries()) {
      if (Number(seen[i]) !== 1) {
        try {
          if (INTENT_ID.test(refund.pi)) marked += await markRefunded(statsId, refund.pi);
        } catch (error) {
          // A review busy just now, or one that did not read: the refund is not taken, and the anchor stays at or
          // below it, so the next pass tries it again; the pass reads on past it (A3; it used to stop the run there,
          // so the refunds behind it were never read while it stayed busy).
          console.error("marking a refunded payment's reviews failed; tried again in the next pass", error);
          if (inPass) hold(refund.created);
          continue;
        }
        // Taken only once its reviews are marked.
        await redisPipeline([
          ["SADD", seenKey(statsId), refund.id],
          ["EXPIRE", seenKey(statsId), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
        ]);
      }
      if (inPass) pass.newest = Math.max(pass.newest, refund.created);
    }
  };

  /**
   * One page of refunds from `after` (the newest when empty), in its exact shape (lib/stripe-list.ts), each row by the
   * refunds' own rule (refundRowKnown, lib/refunds.ts: its id, time, status, payment and charge.refunded as Stripe gives
   * them); null when the page itself is in another shape, which is not "no refunds" (Codex P on #2774).
   */
  const readPage = async (after: string): Promise<StripePage | null> => {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (after) query.set("starting_after", after);
    try {
      return readStripePage(await onAccount("GET", account, `/refunds?${query}`), refundRowKnown);
    } catch (error) {
      if (!(error instanceof StripeListUnreadable)) throw error;
      console.error("reading refunds for reviews: a page in another shape", error);
      return null;
    }
  };

  // A dispute closed as lost marks its reviews as a full refund does (lib/refunds.ts, queue 388 [TB14]): read once a
  // run, with the first page of refunds that reads, from Stripe's closing events (kept thirty days), from their own
  // kept place in the same window.
  let lost: LostRead | null = null;
  const readLost = async () => {
    if (lost) return;
    const read = await lostDisputesOrRetry(account, since, deadline, lostCursorKey("rev", statsId));
    lost = read;
    await take(read.rows, true);
  };

  let ended = false;
  // A cursor Stripe answers it does not know: the pass starts again from the anchor, which never moved past it.
  let restart = false;
  try {
    let pages = REFUND_PAGES;
    if (pass.after && Date.now() < deadline) {
      // Resuming a pass: the newest refunds first, so one made meanwhile does not wait for the pass to end.
      pages -= 1;
      const top = await readPage("");
      if (top) {
        await readLost();
        await take(top.rows, false);
      }
    }
    for (let page = 0; page < pages && Date.now() < deadline; page += 1) {
      let listed: StripePage | null;
      try {
        listed = await readPage(pass.after);
      } catch (error) {
        if (!pass.after || !(error instanceof StripeError) || (error.status !== 400 && error.status !== 404)) throw error;
        console.error("a store's kept place in its refunds for reviews is not known to Stripe; read again from the anchor", error);
        restart = true;
        break;
      }
      // A page in another shape: the pass stays where it is and reads it again (CX-123 rule 30).
      if (!listed) break;
      await readLost();
      // A row that cannot be read proves nothing: the pass reads on past it, but the anchor stays where this pass
      // began, so the next pass reads it again (CX-123 rule 24). The readable rows are still marked.
      if (listed.unreadable > 0) hold(since);
      await take(listed.rows, true);
      if (!listed.hasMore) {
        ended = true;
        break;
      }
      // The pass goes on from the last row that reads: one that does not is read again from there, never skipped. A
      // page with no row that reads leaves the rest unknown; the next run tries again.
      const last = listed.rows.at(-1);
      if (!last) break;
      pass.after = last.id as string;
    }
  } finally {
    // A refunded review leaves "What buyers say" on the store page (lib/store-quotes.ts), also when an error stopped
    // the pass after others were marked.
    if (marked > 0) await refreshStoreQuotes(store);
  }

  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead), every run.
  // Set inside readLost, which the type checker does not follow.
  const lostRead = lost as LostRead | null;
  const lostKept = lostRead ? await confirmLostRead(lostRead, seenKey(statsId)) : false;
  if (ended) {
    // The end of a pass: the anchor moves to the newest refund it handled (a sweep of the lost disputes that went on
    // from a kept place no further than the newest closing it read, so a dispute closed meanwhile is read from the top
    // next run; review of #2158, inbox C4-24), never past when the pass began, nor past a refund it left unknown, nor
    // at all while the lost disputes were not all read and handled. The read refunds outlive it. A pass that left
    // something unknown and cannot move the anchor leaves it as it is, so it lapses as it always did (reviews of
    // #2158), unless the store has none yet: then it keeps the one the pass began at, as below.
    let top = pass.newest;
    if (!lostRead || !lostKept || !lostRead.complete) hold(since);
    else top = lostRead.resumed ? lostRead.newest : Math.max(top, lostRead.newest);
    const moved = Math.max(pass.from, Math.min(top, pass.start, pass.floor ?? Number.POSITIVE_INFINITY));
    const writes: (string | number)[][] = [["DEL", passKey(statsId)]];
    if (pass.floor === null || moved > pass.from || !(Number(anchorRaw) > 0)) {
      writes.unshift(["SET", anchorKey(statsId), String(moved), "EX", REFUND_LOOKBACK_SECONDS * 2], ["EXPIRE", seenKey(statsId), REFUND_LOOKBACK_SECONDS * 2 + 86_400]);
    }
    await redisPipeline(writes);
    return marked;
  }
  // A pass not at its end is kept only when it moved, so one that cannot move lapses and starts again from the anchor.
  // A store with no anchor yet keeps the one its pass began at, so the next run reads the same window and the lost
  // disputes' kept place still counts; its refunds already read are kept as long (reviews of #2158).
  const next = JSON.stringify(pass);
  const writes: (string | number)[][] = [];
  if (restart) writes.push(["DEL", passKey(statsId)]);
  else if (pass.after && next !== passRaw) writes.push(["SET", passKey(statsId), next, "EX", REFUND_PASS_SECONDS]);
  if (!(Number(anchorRaw) > 0)) {
    writes.push(
      ["SET", anchorKey(statsId), String(pass.from), "EX", REFUND_LOOKBACK_SECONDS * 2],
      ["EXPIRE", seenKey(statsId), REFUND_LOOKBACK_SECONDS * 2 + 86_400],
    );
  }
  if (writes.length) await redisPipeline(writes);
  return marked;
}

/** A short form of an order reference, for the studio: enough to find it in Stripe. */
export function shortReference(reference: string): string {
  return reference.length > 16 ? `${reference.slice(0, 8)}…${reference.slice(-6)}` : reference;
}
