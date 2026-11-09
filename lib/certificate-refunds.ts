/**
 * A course's certificate goes when the payment that gave the course is given back (audit R41; Claude 2 on #3374;
 * owner decision DONO-18, 9 November 2026).
 *
 * A buyer refunded in full, or whose bank took the payment back in a dispute Stripe closed as lost, loses the course
 * (lib/refunds.ts, purchaseRefunded). Their certificate of it, with their name, stood at its public address until the
 * creator withdrew it by hand. The checkout sweep now runs this pass every five minutes for a store with courses that
 * issued certificates: it reads the refunds made on the creator's account and the disputes closed as lost since the
 * last pass, finds the checkout each paid for, and for each course that checkout gave, once that course no longer
 * opens for the buyer (lib/learn.ts, courseStandingFor), withdraws the buyer's standing certificate of it
 * (lib/certificate.ts, withdrawForRefund), marked as withdrawn for a refund, so its page no longer shows the name.
 *
 * DONO-18, applied exactly:
 *   - only a refund Stripe says `succeeded`, on a charge every refund of which that gives money back has succeeded and
 *     together covers the whole amount, or a dispute closed as `lost`, takes a certificate;
 *   - a refund still `pending` (or `requires_action`) takes nothing: it is read again on the next passes, and the
 *     place in the refunds waits at it; one that ends `failed` or `canceled` takes nothing, ever;
 *   - a partial refund takes nothing; a full refund made of parts takes it once every part has succeeded;
 *   - a buyer who still holds the course another way (bought it again, a gift, a level) keeps the certificate.
 *
 * Every answer is read in its exact shape (CX-123 rule 24): a charge's refunds, the payment's checkout, the buyer's
 * courses or the certificate's slot that cannot be read withdraws nothing and leaves the row unhandled, and the place
 * in the refunds does not move past it, so a later pass reads it again. A row is marked read only once handled, and
 * withdrawing twice changes nothing.
 *
 * How far it reads (review of #3409, Claude 3): the refunds since the place are read at most
 * CERTIFICATE_REFUND_PAGES_PER_STORE pages a pass, newest first, from where the last pass stopped (the place keeps
 * the last row dealt with), and every row read is dealt with in order, at most CERTIFICATE_REFUND_LOOKUPS_PER_STORE of
 * them asking Stripe more; the next pass reads on from there. The place moves only once the refunds are read to their
 * end, and then only to the oldest row not handled: one still pending, one whose reading failed, one younger than
 * CERTIFICATE_REFUND_SETTLE_SECONDS, or, for a row Stripe answered in a shape that cannot be read, the next readable
 * row after it, so the rows behind an unreadable one are still handled and it is read again. The place is written on
 * every pass, so it never expires into a skip. A refund younger than CERTIFICATE_REFUND_SETTLE_SECONDS waits: until
 * then an answer about the buyer's courses kept from before it (lib/learn.ts, PAID_SECONDS) may still let a
 * certificate be issued, and once it is older none can.
 *
 * Not here: a course paid through PayPal (its refunds are not on the creator's Stripe account), a course given as a
 * gift, a pre-order or a group place (taken back by their own passes, lib/gifts.ts, lib/preorders.ts,
 * lib/group-buy.ts), a course added after checkout in one click (lib/upsell.ts) and a payment plan's first payment,
 * whose purchases are not a checkout's own payment. Their certificates stay until the creator withdraws them.
 *
 *   nl:certrefunds:since:<stats>   the place: how far the refunds were read, in seconds, and while a reading of them
 *                                  is under way, the last row dealt with, the time the place may move to and whether
 *                                  an unreadable row waits for the next readable one
 *   nl:certrefunds:seen:<stats>    the refunds and closing events already handled, each by its time, trimmed below
 *                                  the place
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReply, exactReplies, replyCount } from "@/lib/redis-exact";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { type StripePage, StripeListUnreadable, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { type LostRead, lostCursorKey, lostDisputesOrRetry, refundRowKnown, refundedInFull } from "@/lib/refunds";
import { KIND, readKindExact } from "@/lib/catalog";
import { deliveredIds } from "@/lib/bundle-rules";
import { type Listing, type Store, saleHandles } from "@/lib/store";
import { EMAIL_PATTERN } from "@/lib/auth";
import { allKey, withdrawForRefund } from "@/lib/certificate";
import { PAID_SECONDS, courseStandingFor } from "@/lib/learn";

/**
 * Pages of the creator's refunds (GET /refunds, up to 100 each, newest first) read in one pass, from where the last
 * one stopped; priced in tests/plan-cost-registry.ts (NOT_A_COST).
 */
export const CERTIFICATE_REFUND_PAGES_PER_STORE = 3;
/** Refunds and lost disputes looked up in one pass: each asks Stripe for its charge's refunds, its checkout and the buyer's courses. */
export const CERTIFICATE_REFUND_LOOKUPS_PER_STORE = 20;
/** How far back a store's first pass reads, and how long its place and the refunds read are kept. */
export const CERTIFICATE_REFUND_LOOKBACK_SECONDS = 7 * 86_400;
/**
 * How old a refund or a lost dispute must be before it takes a certificate: the ten minutes an answer about a buyer's
 * courses is kept (PAID_SECONDS), and five more for a press of "Get my certificate" still under way on such an answer.
 */
export const CERTIFICATE_REFUND_SETTLE_SECONDS = PAID_SECONDS + 300;
/** The most time one pass takes of the checkout sweep's run, so the stores after it are reached in the same run. */
export const CERTIFICATE_REFUND_PASS_MS = 4_000;

const anchorKey = (sid: string) => `nl:certrefunds:since:${sid}`;
const seenKey = (sid: string) => `nl:certrefunds:seen:${sid}`;
const PI_ID = /^pi_[A-Za-z0-9]{6,255}$/;
/** A row's id the next page may be read after (Stripe's ids are a prefix and 24 characters). */
const CURSOR_ID = /^[a-z]{2,4}_[A-Za-z0-9]{6,64}$/;
/** The place: seconds, then, while a reading is under way, the last row dealt with, the time it may move to and whether an unreadable row waits. */
const PLACE = /^(\d{1,12})(?:\|([a-z]{2,4}_[A-Za-z0-9]{6,64})\|(\d{1,12})\|([01]))?$/;
/** A row's time as the set of rows handled keeps it. */
const SCORE = /^\d{1,12}$/;
const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]{6,255}$/;

const WHAT = "the certificates' refund pass";
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const idOf = (value: unknown): string =>
  typeof value === "string" ? value : plainObject(value) && typeof ownField(value, "id") === "string" ? (ownField(value, "id") as string) : "";

/** Every page of a list, read whole: the rows, or null when a page did not read, a row did not, or there were more pages. */
async function wholeList(account: string, path: string, query: URLSearchParams, legible: (row: Record<string, unknown>) => boolean, pages: number, deadline: number): Promise<Record<string, unknown>[] | null> {
  const rows: Record<string, unknown>[] = [];
  let after = "";
  for (let page = 0; page < pages; page += 1) {
    if (Date.now() >= deadline) return null;
    if (after) query.set("starting_after", after);
    let read: StripePage;
    try {
      read = readStripePage(await onAccount("GET", account, `${path}?${query}`), legible);
    } catch (error) {
      if (!(error instanceof StripeListUnreadable)) throw error;
      return null;
    }
    if (read.unreadable) return null;
    rows.push(...read.rows);
    if (!read.hasMore) return rows;
    if (!read.lastId) return null;
    after = read.lastId;
  }
  return null;
}

/**
 * Whether the whole of a charge went back through refunds that all succeeded (DONO-18): "yes"; "waiting" while a part
 * is pending or waits on an action; "no" when what succeeded does not cover it and nothing waits. Throws when the
 * charge's refunds cannot be read whole.
 */
async function refundedForGood(account: string, charge: Record<string, unknown>, deadline: number): Promise<"yes" | "waiting" | "no"> {
  const id = idOf(charge);
  const amount = ownField(charge, "amount");
  if (!CHARGE_ID.test(id) || !whole(amount)) throw new UnknownReply(WHAT);
  const legible = (row: Record<string, unknown>) => refundRowKnown(row) && whole(ownField(row, "amount"));
  const rows = await wholeList(account, "/refunds", new URLSearchParams({ charge: id, limit: "100" }), legible, 2, deadline);
  if (!rows) throw new UnknownReply(WHAT);
  if (rows.some((row) => row.status === "pending" || row.status === "requires_action")) return "waiting";
  const back = rows.filter((row) => row.status === "succeeded").reduce((sum, row) => sum + (row.amount as number), 0);
  return amount > 0 && back >= amount ? "yes" : "no";
}

/** The buyer and the courses with certificates a payment's checkout gave, or null when it was no checkout of this store. Throws when unreadable. */
async function saleOf(store: Store, account: string, pi: string, courses: Map<string, Listing>, deadline: number): Promise<{ email: string; courses: Listing[] } | null> {
  const legible = (row: Record<string, unknown>) => plainObject(ownField(row, "metadata"));
  const rows = await wholeList(account, "/checkout/sessions", new URLSearchParams({ payment_intent: pi, limit: "10" }), legible, 1, deadline);
  if (!rows) throw new UnknownReply(WHAT);
  const session = rows.find((row) => idOf(row.payment_intent) === pi);
  if (!session) return null;
  const meta = ownField(session, "metadata") as Record<string, string>;
  if (!saleHandles(store).has(meta.store ?? "")) return null;
  const given = deliveredIds(meta)
    .map((id) => courses.get(id))
    .filter((p): p is Listing => Boolean(p));
  if (!given.length) return null;
  const details = ownField(session, "customer_details");
  const email = plainObject(details) ? ownField(details, "email") : undefined;
  if (typeof email !== "string" || !EMAIL_PATTERN.test(email)) throw new UnknownReply(WHAT);
  return { email, courses: given };
}

/** Whether a store may hold certificates this pass looks after: one paid through Stripe with a course among its products. */
export function mayHaveCertificates(store: Store): boolean {
  return Boolean(store.stripeAccountId && store.statsId) && store.catalog.items.some((item) => (item.kind & KIND.course) !== 0);
}

/** A list's row at `i`, read without running a getter (as lib/stripe-list.ts reads it). */
function rowAt(data: unknown[], i: number): unknown {
  const slot = Object.getOwnPropertyDescriptor(data, String(i));
  return slot && Object.hasOwn(slot, "value") ? slot.value : undefined;
}

/**
 * Keeps the lost disputes' place only when every one read was handled, that is, is in the set of rows handled (one
 * ZSCORE each, read exactly), as lib/refunds.ts confirmLostRead does for a plain set. False when one was not, or a
 * reply cannot be read: the place stays and they are read again.
 */
async function keepLostPlace(lost: LostRead, sid: string): Promise<boolean> {
  try {
    const ids = lost.rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
    if (ids.length) {
      const scores = exactReplies(await redisPipeline(ids.map((id) => ["ZSCORE", seenKey(sid), id])), ids.length, WHAT);
      if (scores.some((score) => typeof score !== "string" || !SCORE.test(score))) return false;
    }
    await lost.commit();
    return true;
  } catch (error) {
    console.error("the lost disputes' place for certificates was kept as it was", error instanceof Error ? error.name : typeof error);
    return false;
  }
}

/**
 * Reads the refunds and lost disputes since the last pass and withdraws each certificate whose course's payment was
 * given back, as the header says. Returns how many it withdrew. Asks Stripe nothing of a store none of whose courses
 * ever issued a certificate.
 */
export async function withdrawRefundedCertificates(store: Store, deadline: number): Promise<number> {
  if (!store.stripeAccountId || !store.statsId || !isRedisConfigured()) return 0;
  // Its own slice of the sweep's run (review of #3409, L4): what is left is read from where it stopped next run.
  const until = Math.min(deadline, Date.now() + CERTIFICATE_REFUND_PASS_MS);
  const account = store.stripeAccountId;
  const sid = store.statsId;
  const listed = (await readKindExact(store, "course")).filter((p) => p.course);
  if (!listed.length) return 0;
  const replies = exactReplies(await redisPipeline([["GET", anchorKey(sid)], ...listed.map((p) => ["SCARD", allKey(p.course!.id)])]), listed.length + 1, WHAT);
  const [anchorRaw, ...issued] = replies;
  const courses = new Map(listed.filter((_, i) => replyCount(issued[i], WHAT) > 0).map((p) => [p.id, p]));
  if (!courses.size) return 0;
  const place = anchorRaw === null ? null : typeof anchorRaw === "string" ? PLACE.exec(anchorRaw) : null;
  if (anchorRaw !== null && !place) throw new UnknownReply(WHAT);
  const now = Math.floor(Date.now() / 1000);
  const anchor = place ? Number(place[1]) : now - CERTIFICATE_REFUND_LOOKBACK_SECONDS;
  // A little overlap, so a refund made in the second the last pass read is not missed; the set read keeps it once.
  const since = Math.max(0, anchor - 300);
  // Where a reading of the refunds under way stopped (none: from the newest): the row to read on after, the time the
  // place may move to once they are read to the end (the newest read, or an older row not handled), and whether an
  // unreadable row still waits for the next readable one, whose time then holds the place.
  let after = place?.[2] ?? "";
  const resumed = after !== "";
  let reach = resumed ? Number(place![3]) : anchor;
  let blind = place?.[4] === "1";
  let lookups = CERTIFICATE_REFUND_LOOKUPS_PER_STORE;
  let withdrawn = 0;

  /** One refund or lost dispute: "done" when dealt with, "held" when it must be read again, "stop" when this pass can do no more. */
  const handle = async (row: Record<string, unknown>, dispute: boolean): Promise<"done" | "held" | "stop"> => {
    if (Date.now() >= until) return "stop";
    const id = typeof row.id === "string" ? row.id : "";
    const created = whole(row.created) ? row.created : 0;
    const pi = idOf(row.payment_intent);
    if (!id) return "done";
    if (!dispute) {
      // DONO-18: only a refund that went through takes anything; one still under way is read again until it ends.
      if (row.status === "pending" || row.status === "requires_action") return "held";
      if (row.status !== "succeeded" || !refundedInFull(row.charge)) return "done";
      if (!PI_ID.test(pi)) return "done";
    }
    // Younger than an answer about the buyer's courses may be kept: read again once it is older (review of #3409, L1).
    if (now - created < CERTIFICATE_REFUND_SETTLE_SECONDS) return "held";
    try {
      const [seen] = exactReplies(await redisPipeline([["ZSCORE", seenKey(sid), id]]), 1, WHAT);
      if (seen !== null) {
        if (typeof seen !== "string" || !SCORE.test(seen)) throw new UnknownReply(WHAT);
        return "done";
      }
      // A lost dispute with no payment to look up: nothing of this store can be told from it, so it is read and never
      // holds the disputes' place back.
      if (dispute && !PI_ID.test(pi)) return await markRead(id, created);
      if (lookups <= 0) return "stop";
      lookups -= 1;
      if (!dispute) {
        const settled = await refundedForGood(account, row.charge as Record<string, unknown>, until);
        if (settled === "waiting") return "held";
        if (settled === "no") return "done";
      }
      const sale = await saleOf(store, account, pi, courses, until);
      let left = false;
      for (const product of sale?.courses ?? []) {
        const standing = await courseStandingFor(store, sale!.email, product.id);
        if (standing === "unknown") {
          left = true;
          continue;
        }
        if (standing === "shut" && (await withdrawForRefund(product.course!.id, sale!.email))) withdrawn += 1;
      }
      if (left) return "held";
      // Marked read once handled: a pass that stops halfway leaves it to the next, which does the same again.
      return await markRead(id, created);
    } catch (error) {
      console.error("a refund for certificates was left for the next pass", id, error instanceof Error ? error.name : typeof error);
      return "held";
    }
  };
  /** The row marked handled, by its time, each reply read exactly. */
  const markRead = async (id: string, created: number): Promise<"done"> => {
    exactReplies(
      await redisPipeline([
        ["ZADD", seenKey(sid), created, id],
        ["EXPIRE", seenKey(sid), CERTIFICATE_REFUND_LOOKBACK_SECONDS * 2 + 86_400],
      ]),
      2,
      WHAT,
    ).forEach((reply) => {
      if (replyCount(reply, WHAT) > 1) throw new UnknownReply(WHAT);
    });
    return "done";
  };

  // A dispute closed as lost takes the certificate as a full refund does (lib/refunds.ts, the owner's rule of
  // 4 November 2026): read from Stripe's closing events with their own place; a read that fails or does not end
  // keeps it.
  const lost = await lostDisputesOrRetry(account, since, until, lostCursorKey("cert", sid));
  let stopped = false;
  for (const row of lost.rows) {
    if ((await handle(row as unknown as Record<string, unknown>, true)) === "stop") {
      stopped = true;
      break;
    }
  }

  // The refunds, a page at a time from where the last pass stopped, each row dealt with in order.
  let ended = false;
  let restart = false;
  let hold = Infinity;
  for (let page = 0; page < CERTIFICATE_REFUND_PAGES_PER_STORE && !stopped; page += 1) {
    if (Date.now() >= until) break;
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (after) query.set("starting_after", after);
    let raw: unknown;
    let read: StripePage;
    try {
      raw = await onAccount("GET", account, `/refunds?${query}`);
      read = readStripePage(raw, refundRowKnown);
    } catch (error) {
      // A page that does not read, or Stripe not answering: read again from the same row next pass. A row to read on
      // after that Stripe no longer knows (another account connected since): read again from the newest.
      if (after && error instanceof StripeError && error.code === "resource_missing") restart = true;
      console.error("a page of refunds for certificates did not read", error instanceof Error ? error.name : typeof error);
      break;
    }
    const data = ownField(raw as Record<string, unknown>, "data") as unknown[];
    const legible = new Set<unknown>(read.rows);
    let next = true;
    for (let i = 0; i < data.length; i += 1) {
      const row = rowAt(data, i);
      if (!legible.has(row)) {
        // Unreadable: nothing is decided on it, and the next readable row's time holds the place (it is no newer).
        blind = true;
        const id = plainObject(row) ? ownField(row, "id") : undefined;
        if (typeof id === "string" && CURSOR_ID.test(id)) after = id;
        else if (i === data.length - 1) next = false;
        continue;
      }
      const refund = row as Record<string, unknown>;
      const created = refund.created as number;
      const outcome = await handle(refund, false);
      if (outcome === "stop") {
        stopped = true;
        break;
      }
      if (!resumed) reach = Math.max(reach, created);
      if (blind) {
        hold = Math.min(hold, created);
        blind = false;
      }
      if (outcome === "held") hold = Math.min(hold, created);
      if (CURSOR_ID.test(refund.id as string)) after = refund.id as string;
      else if (i === data.length - 1) next = false;
    }
    if (stopped) break;
    if (!read.hasMore) {
      ended = true;
      break;
    }
    // More pages, and no row to read them after: read again from the last one dealt with next pass.
    if (!next) break;
  }
  reach = Math.min(reach, hold);

  // The lost disputes' place moves only once every one read was handled, and the refunds' place with it.
  const lostKept = await keepLostPlace(lost, sid);
  const keep = String(CERTIFICATE_REFUND_LOOKBACK_SECONDS * 2);
  if (ended && lostKept && lost.complete) {
    // Read to the end: the place moves to the oldest row not handled, never past an unreadable one still waiting,
    // nor past the newest lost dispute of a reading of them that went on from an earlier pass.
    let to = reach;
    if (blind) to = Math.min(to, anchor);
    if (lost.resumed) to = Math.min(to, Math.max(lost.newest, since));
    const moved = Math.max(to, since);
    // The rows handled below the next window are never read again.
    const [written, trimmed] = exactReplies(
      await redisPipeline([
        ["SET", anchorKey(sid), String(moved), "EX", keep],
        ["ZREMRANGEBYSCORE", seenKey(sid), "-inf", String(Math.max(0, moved - 300) - 1)],
      ]),
      2,
      WHAT,
    );
    if (written !== "OK") throw new UnknownReply(WHAT);
    replyCount(trimmed, WHAT);
  } else {
    // Not read to the end (or the disputes not handled): the place stays, written again so it never expires, with
    // where the refunds stopped, so the next pass reads on from there; read to the end, it reads them again from the newest.
    const value = !ended && !restart && after ? `${anchor}|${after}|${reach}|${blind ? 1 : 0}` : String(anchor);
    const [written] = exactReplies(await redisPipeline([["SET", anchorKey(sid), value, "EX", keep]]), 1, WHAT);
    if (written !== "OK") throw new UnknownReply(WHAT);
  }
  return withdrawn;
}
