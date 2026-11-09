/**
 * A course's certificate goes when the payment that gave the course is given back (audit R41; Claude 2 on #3374;
 * owner decision DONO-18, 9 November 2026).
 *
 * A buyer refunded in full, or whose bank took the payment back in a dispute Stripe closed as lost, loses the course
 * (lib/refunds.ts, purchaseRefunded). Their certificate of it, with their name, stood at its public address until the
 * creator withdrew it by hand. The checkout sweep now runs this pass, at most once every
 * CERTIFICATE_PASS_EVERY_SECONDS, for a store paid through Stripe with a course: it reads the refunds made on the
 * creator's account and the disputes closed as lost since the last pass, finds the checkout each paid for, and for
 * each course that checkout gave that issued a certificate, once that course no longer opens for the buyer
 * (lib/learn.ts, courseStandingFor), withdraws the buyer's certificates of it (lib/certificate.ts, withdrawForRefund),
 * marked as withdrawn for a refund, so no page of theirs shows the name.
 *
 * Its pace (focal review of #3409, Claude 5, ALTO 2): run every five minutes, the pass cost a store more than the Store
 * plan's first year given back has room for. Now the sweep reads, in one MGET for its whole batch of stores
 * (certificatePassesDue), which stores' passes are due, and a store's pass takes its turn with one SET NX EX
 * (takeCertificatePass) that holds for CERTIFICATE_PASS_EVERY_SECONDS; a store whose pass is not due costs no
 * command of its own. A reply in any other shape runs no pass that run and forgets nothing: the place holds, and the
 * next run reads again. No look at a store's courses is needed: a pass's work is bounded by its refunds, never by its
 * courses, since only the courses a refunded checkout gave are read (their listings and one SCARD each).
 *
 * What a store's pass may spend (second review of #3409, Claude 5, ALTO 1, and the focal review): whether rows were
 * handled already is read with one ZMSCORE a page, by their ids, never one command a row; and every course a
 * refunded checkout gave takes one of the store's checks of the month (CERTIFICATE_REFUND_CHECKS_PER_MONTH, by its
 * plan) before anything is read for it, and every row one more before it is marked handled. Past them, the pass
 * stops where it is and goes on from that row the next month: nothing is skipped. A row read again while it waits (a
 * part of its refund still pending) asks Stripe only and takes none. A row that took its checks and was left unknown
 * (MÉDIO 2: its buyer's courses, its checkout's courses or its certificate could not be read) is marked to wait
 * CERTIFICATE_REFUND_RETRY_SECONDS, read with the same ZMSCORE: until then it holds the place without taking a check
 * again, and the rows after it go on; then it is tried again, and it is never forgotten. Priced per plan in
 * tests/plan-cost-registry.ts (COST_LINES, certificate-refund-pass).
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
 *                                  the place; and "w:<id>" for a row left unknown, by the time it may be tried again
 *   nl:certrefunds:next:<stats>    "1" while the store's pass is not due, for CERTIFICATE_PASS_EVERY_SECONDS
 *   nl:certrefunds:n:<stats>:<month>  the rows marked handled and courses checked in a calendar month (UTC), forty days
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReply, exactReplies, plainList, replyCount } from "@/lib/redis-exact";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { type StripePage, StripeListUnreadable, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { type LostRead, lostCursorKey, lostDisputesOrRetry, refundRowKnown, refundedInFull } from "@/lib/refunds";
import { KIND, idsOfKind, readListingsExact } from "@/lib/catalog";
import { deliveredIds } from "@/lib/bundle-rules";
import { type Listing, type Store, saleHandles } from "@/lib/store";
import type { Tier } from "@/lib/plan";
import { EMAIL_PATTERN } from "@/lib/auth";
import { allKey, withdrawForRefund } from "@/lib/certificate";
import { PAID_SECONDS, courseStandingFor } from "@/lib/learn";

/**
 * Pages of the creator's refunds (GET /refunds, up to 100 each, newest first) read in one pass, from where the last
 * one stopped; priced per plan in tests/plan-cost-registry.ts (COST_LINES, certificate-refund-pass).
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
/**
 * The most often the sweep runs one store's pass (focal review of #3409, Claude 5, ALTO 2): a store's turn holds this
 * long, so a month has at most DAY_WINDOWS days of 86,400 / CERTIFICATE_PASS_EVERY_SECONDS passes
 * (tests/plan-cost-registry.ts, CERTIFICATE_PASS_RUNS).
 */
export const CERTIFICATE_PASS_EVERY_SECONDS = 2 * 3_600;
/** How long a row that took its checks and was left unknown waits before it is tried again (focal review, MÉDIO 2). */
export const CERTIFICATE_REFUND_RETRY_SECONDS = 86_400;
/**
 * Rows marked handled and courses checked for one store in a calendar month (UTC), by its plan: each course a refunded
 * checkout gave takes one before anything is read for it, and each row one before it is marked handled. Past it the
 * pass stops at that row until the next month. A ceiling of what the pass may spend for a store, priced in COST_LINES;
 * not an allowance of the plan. A store whose plan reads in no known way is held to the smallest.
 */
export const CERTIFICATE_REFUND_CHECKS_PER_MONTH: Readonly<Record<Tier, number>> = { creator: 100, pro: 1_000, scale: 5_000 };
const checksKey = (sid: string, month: string) => `nl:certrefunds:n:${sid}:${month}`;
/** The month's checks are spent: the pass stops where it is. */
class ChecksSpent extends Error {}

/** The store's checks of the month, by its plan; the smallest for a plan read in no known way. */
function checksOf(store: Store): number {
  const tier = store.tier as unknown;
  return tier === "pro" || tier === "scale" ? CERTIFICATE_REFUND_CHECKS_PER_MONTH[tier] : CERTIFICATE_REFUND_CHECKS_PER_MONTH.creator;
}

/** Takes `n` of the store's checks of the month before they are spent, each reply read exactly; throws ChecksSpent past them. */
async function takeChecks(sid: string, n: number, ceiling: number): Promise<void> {
  const key = checksKey(sid, new Date(Date.now()).toISOString().slice(0, 7));
  const [count, kept] = exactReplies(await redisPipeline([["INCRBY", key, n], ["EXPIRE", key, 40 * 86_400]]), 2, WHAT);
  if (replyCount(kept, WHAT) !== 1) throw new UnknownReply(WHAT);
  if (replyCount(count, WHAT) > ceiling) throw new ChecksSpent();
}

/** What the set of rows handled says of some rows: the ids handled, and when each row left unknown may be tried again. */
type Seen = { handled: Set<string>; until: Map<string, number> };
/** A row left unknown, in the set of rows handled, by the time it may be tried again. */
const waitMember = (id: string) => `w:${id}`;
/** A score as ZMSCORE answers it: whole seconds, as a string or a number. */
const SCORE = /^\d{1,13}$/;

/**
 * Of these rows, the ids already handled and the waits of those left unknown, read in one ZMSCORE by their ids (each
 * id and its wait), so the reply is two entries a row whatever the set holds. A reply that is not exactly one entry
 * an id asked, each nil or whole seconds, throws (CX-123 rule 24).
 */
async function seenAmong(sid: string, rows: Record<string, unknown>[]): Promise<Seen> {
  const ids = [...new Set(rows.map((row) => row.id).filter((id): id is string => typeof id === "string" && id !== ""))];
  const seen: Seen = { handled: new Set(), until: new Map() };
  if (!ids.length) return seen;
  const [reply] = exactReplies(await redisPipeline([["ZMSCORE", seenKey(sid), ...ids, ...ids.map(waitMember)]]), 1, WHAT);
  const scores = plainList(reply);
  if (!scores || scores.length !== 2 * ids.length) throw new UnknownReply(WHAT);
  const secondsOf = (raw: unknown): number | null => {
    if (raw === null) return null;
    if (typeof raw === "number" && whole(raw)) return raw;
    if (typeof raw === "string" && SCORE.test(raw)) return Number(raw);
    throw new UnknownReply(WHAT);
  };
  ids.forEach((id, i) => {
    if (secondsOf(scores[i]) !== null) seen.handled.add(id);
    const until = secondsOf(scores[ids.length + i]);
    if (until !== null) seen.until.set(id, until);
  });
  return seen;
}

const anchorKey = (sid: string) => `nl:certrefunds:since:${sid}`;
const seenKey = (sid: string) => `nl:certrefunds:seen:${sid}`;
const nextKey = (sid: string) => `nl:certrefunds:next:${sid}`;
/** The value of a store's turn while its pass is not due. */
const NOT_DUE = "1";
const PI_ID = /^pi_[A-Za-z0-9]{6,255}$/;
/** A row's id the next page may be read after (Stripe's ids are a prefix and 24 characters). */
const CURSOR_ID = /^[a-z]{2,4}_[A-Za-z0-9]{6,64}$/;
/** The place: seconds, then, while a reading is under way, the last row dealt with, the time it may move to and whether an unreadable row waits. */
const PLACE = /^(\d{1,12})(?:\|([a-z]{2,4}_[A-Za-z0-9]{6,64})\|(\d{1,12})\|([01]))?$/;
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

/**
 * The buyer and the courses with certificates a payment's checkout gave, or null when it was no checkout of this store
 * or gave none: only those courses are read, their listings and one SCARD each. `charged` is called once their
 * checks are taken. Throws when unreadable.
 */
async function saleOf(store: Store, account: string, pi: string, deadline: number, charged: () => void): Promise<{ email: string; courses: Listing[] } | null> {
  const sid = store.statsId!;
  const legible = (row: Record<string, unknown>) => plainObject(ownField(row, "metadata"));
  const rows = await wholeList(account, "/checkout/sessions", new URLSearchParams({ payment_intent: pi, limit: "10" }), legible, 1, deadline);
  if (!rows) throw new UnknownReply(WHAT);
  const session = rows.find((row) => idOf(row.payment_intent) === pi);
  if (!session) return null;
  const meta = ownField(session, "metadata") as Record<string, string>;
  if (!saleHandles(store).has(meta.store ?? "")) return null;
  const kinds = new Set(idsOfKind(store, "course"));
  const asked = [...new Set(deliveredIds(meta).filter((id) => kinds.has(id)))];
  if (!asked.length) return null;
  await takeChecks(sid, asked.length, checksOf(store));
  charged();
  const listed = (await readListingsExact(store, asked)).filter((p) => p.course);
  if (!listed.length) return null;
  const issued = exactReplies(await redisPipeline(listed.map((p) => ["SCARD", allKey(p.course!.id)])), listed.length, WHAT);
  const given = listed.filter((_, i) => replyCount(issued[i], WHAT) > 0);
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

/**
 * The stats ids of these stores whose pass is due, read in one MGET for them all (focal review of #3409, ALTO 2): a
 * store's turn absent (nil) is due; one that reads NOT_DUE is not. A reply in any other shape, for one store or for
 * all, runs none of those passes this run (CX-123 rule 24): nothing is withdrawn on it and nothing is forgotten, the
 * place holding where it was, and the next run reads again.
 */
export async function certificatePassesDue(stores: Store[]): Promise<Set<string>> {
  const due = new Set<string>();
  if (!isRedisConfigured()) return due;
  const sids = [...new Set(stores.filter(mayHaveCertificates).map((store) => store.statsId!))];
  if (!sids.length) return due;
  try {
    const [reply] = exactReplies(await redisPipeline([["MGET", ...sids.map(nextKey)]]), 1, WHAT);
    const values = plainList(reply);
    if (!values || values.length !== sids.length) throw new UnknownReply(WHAT);
    values.forEach((value, i) => {
      if (value === null) due.add(sids[i]);
      else if (value !== NOT_DUE) console.error("a store's turn for the certificates' refund pass did not read; no pass this run");
    });
  } catch (error) {
    console.error("the turns for the certificates' refund pass did not read; no pass this run", error instanceof Error ? error.name : typeof error);
    return new Set();
  }
  return due;
}

/**
 * Takes the store's turn for its pass, held CERTIFICATE_PASS_EVERY_SECONDS, with one SET NX EX read exactly: true when
 * this run took it; false when another run holds it. Any other reply throws: no pass runs on a turn not known to be
 * taken, so a pass never runs more often than its price says.
 */
export async function takeCertificatePass(store: Store): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const [taken] = exactReplies(await redisPipeline([["SET", nextKey(store.statsId), NOT_DUE, "NX", "EX", CERTIFICATE_PASS_EVERY_SECONDS]]), 1, WHAT);
  if (taken === null) return false;
  if (taken !== "OK") throw new UnknownReply(WHAT);
  return true;
}

/** A list's row at `i`, read without running a getter (as lib/stripe-list.ts reads it). */
function rowAt(data: unknown[], i: number): unknown {
  const slot = Object.getOwnPropertyDescriptor(data, String(i));
  return slot && Object.hasOwn(slot, "value") ? slot.value : undefined;
}

/**
 * Keeps the lost disputes' place only when every one read was handled, that is, is in the set of rows handled (one
 * ZMSCORE by their ids, read exactly), as lib/refunds.ts confirmLostRead does for a plain set. False when one was not,
 * or a reply cannot be read: the place stays and they are read again.
 */
async function keepLostPlace(lost: LostRead, sid: string): Promise<boolean> {
  try {
    const ids = lost.rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
    if (ids.length) {
      if (lost.rows.some((row) => !whole(row.created))) return false;
      const { handled } = await seenAmong(sid, lost.rows);
      if (ids.some((id) => !handled.has(id))) return false;
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
 * given back, as the header says. Returns how many it withdrew. The sweep runs it only on the store's turn
 * (certificatePassesDue, takeCertificatePass).
 */
export async function withdrawRefundedCertificates(store: Store, deadline: number): Promise<number> {
  if (!store.stripeAccountId || !store.statsId || !isRedisConfigured()) return 0;
  // Its own slice of the sweep's run (review of #3409, L4): what is left is read from where it stopped next run.
  const until = Math.min(deadline, Date.now() + CERTIFICATE_REFUND_PASS_MS);
  const account = store.stripeAccountId;
  const sid = store.statsId;
  const ceiling = checksOf(store);
  const [anchorRaw] = exactReplies(await redisPipeline([["GET", anchorKey(sid)]]), 1, WHAT);
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
  const handle = async (row: Record<string, unknown>, dispute: boolean, seen: Seen): Promise<"done" | "held" | "stop"> => {
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
    if (seen.handled.has(id)) return "done";
    // Left unknown by an earlier pass after it took its checks: it holds the place, and takes none again, until its
    // wait is over (focal review of #3409, MÉDIO 2); the rows after it go on.
    if ((seen.until.get(id) ?? 0) > now) return "held";
    // Whether this row took any of the month's checks in this pass: if it is left unknown, it then waits.
    let charged = false;
    const wait = async (): Promise<"held"> => {
      if (!charged) return "held";
      try {
        exactReplies(
          await redisPipeline([
            ["ZADD", seenKey(sid), now + CERTIFICATE_REFUND_RETRY_SECONDS, waitMember(id)],
            ["EXPIRE", seenKey(sid), CERTIFICATE_REFUND_LOOKBACK_SECONDS * 2 + 86_400],
          ]),
          2,
          WHAT,
        ).forEach((reply) => {
          if (replyCount(reply, WHAT) > 1) throw new UnknownReply(WHAT);
        });
      } catch (error) {
        // Not known to be marked: it is tried again at the next pass, inside the month's checks.
        console.error("a refund for certificates left unknown was not marked to wait", id, error instanceof Error ? error.name : typeof error);
      }
      return "held";
    };
    try {
      // A lost dispute with no payment to look up: nothing of this store can be told from it, so it is read and never
      // holds the disputes' place back.
      if (dispute && !PI_ID.test(pi)) return await markRead(id, created, () => (charged = true));
      if (lookups <= 0) return "stop";
      lookups -= 1;
      if (!dispute) {
        const settled = await refundedForGood(account, row.charge as Record<string, unknown>, until);
        if (settled === "waiting") return "held";
        if (settled === "no") return "done";
      }
      const sale = await saleOf(store, account, pi, until, () => (charged = true));
      let left = false;
      for (const product of sale?.courses ?? []) {
        const standing = await courseStandingFor(store, sale!.email, product.id);
        if (standing === "unknown") {
          left = true;
          continue;
        }
        if (standing === "shut" && (await withdrawForRefund(product.course!.id, sale!.email))) withdrawn += 1;
      }
      if (left) return await wait();
      // Marked read once handled: a pass that stops halfway leaves it to the next, which does the same again.
      return await markRead(id, created, () => (charged = true));
    } catch (error) {
      if (error instanceof ChecksSpent) return "stop";
      console.error("a refund for certificates was left for the next pass", id, error instanceof Error ? error.name : typeof error);
      return await wait();
    }
  };
  /** The row marked handled, by its time, each reply read exactly; `charged` is called once its check is taken. */
  const markRead = async (id: string, created: number, charged: () => void): Promise<"done"> => {
    await takeChecks(sid, 1, ceiling);
    charged();
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
  let lostSeen: Seen | null = null;
  try {
    lostSeen = await seenAmong(sid, lost.rows as unknown as Record<string, unknown>[]);
  } catch {
    // Unknown which were handled: none is acted on this pass, and the place stays.
    stopped = true;
  }
  for (const row of lostSeen ? lost.rows : []) {
    if ((await handle(row as unknown as Record<string, unknown>, true, lostSeen!)) === "stop") {
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
    let handled: Seen;
    try {
      handled = await seenAmong(sid, read.rows);
    } catch {
      // Unknown which of this page were handled: read again from the same row next pass.
      console.error("the refunds handled for certificates did not read");
      break;
    }
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
      const outcome = await handle(refund, false, handled);
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
