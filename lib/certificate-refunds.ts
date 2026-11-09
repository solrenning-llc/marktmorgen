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
 * Every answer is read in its exact shape (CX-123 rule 24): a page of refunds, a charge's refunds, the payment's
 * checkout, the buyer's courses or the certificate's slot that cannot be read withdraws nothing and leaves the row
 * unread, and the place in the refunds does not move past it, so the next pass reads it again. A row is marked read
 * only once handled, and withdrawing twice changes nothing.
 *
 * Not here: a course given as a gift, a pre-order or a group place (taken back by their own passes, lib/gifts.ts,
 * lib/preorders.ts, lib/group-buy.ts), a course added after checkout in one click (lib/upsell.ts) and a payment
 * plan's first payment, whose purchases are not a checkout's own payment. Their certificates stay until those
 * passes withdraw them too.
 *
 *   nl:certrefunds:since:<stats>   how far the refunds were read, in seconds
 *   nl:certrefunds:seen:<stats>    set of refunds and closing events already handled
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReply, exactReplies, replyCount } from "@/lib/redis-exact";
import { onAccount } from "@/lib/stripe-account";
import { type StripePage, StripeListUnreadable, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { confirmLostRead, lostCursorKey, lostDisputesOrRetry, refundRowKnown, refundedInFull } from "@/lib/refunds";
import { KIND, readKindExact } from "@/lib/catalog";
import { deliveredIds } from "@/lib/bundle-rules";
import { type Listing, type Store, saleHandles } from "@/lib/store";
import { EMAIL_PATTERN } from "@/lib/auth";
import { allKey, withdrawForRefund } from "@/lib/certificate";
import { courseStandingFor } from "@/lib/learn";

/** Pages of the creator's refunds (GET /refunds, up to 100 each, newest first) read in one pass. */
const REFUND_PAGES = 3;
/** Refunds and lost disputes looked up in one pass: each asks Stripe for its charge's refunds, its checkout and the buyer's courses. */
const LOOKUPS = 20;
/** How far back a store's first pass reads, and how long its place and the refunds read are kept. */
const LOOKBACK_SECONDS = 7 * 86_400;

const anchorKey = (sid: string) => `nl:certrefunds:since:${sid}`;
const seenKey = (sid: string) => `nl:certrefunds:seen:${sid}`;
const PI_ID = /^pi_[A-Za-z0-9]{6,255}$/;
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

/**
 * Reads the refunds and lost disputes since the last pass and withdraws each certificate whose course's payment was
 * given back, as the header says. Returns how many it withdrew. Asks Stripe nothing of a store none of whose courses
 * ever issued a certificate.
 */
export async function withdrawRefundedCertificates(store: Store, deadline: number): Promise<number> {
  if (!store.stripeAccountId || !store.statsId || !isRedisConfigured()) return 0;
  const account = store.stripeAccountId;
  const sid = store.statsId;
  const listed = (await readKindExact(store, "course")).filter((p) => p.course);
  if (!listed.length) return 0;
  const replies = exactReplies(await redisPipeline([["GET", anchorKey(sid)], ...listed.map((p) => ["SCARD", allKey(p.course!.id)])]), listed.length + 1, WHAT);
  const [anchorRaw, ...issued] = replies;
  const courses = new Map(listed.filter((_, i) => replyCount(issued[i], WHAT) > 0).map((p) => [p.id, p]));
  if (!courses.size) return 0;
  if (anchorRaw !== null && (typeof anchorRaw !== "string" || !/^\d{1,12}$/.test(anchorRaw))) throw new UnknownReply(WHAT);
  const now = Math.floor(Date.now() / 1000);
  const anchor = anchorRaw === null ? now - LOOKBACK_SECONDS : Number(anchorRaw);
  // A little overlap, so a refund made in the second the last pass read is not missed; the set read keeps it once.
  const since = Math.max(0, anchor - 300);

  const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
  query.append("expand[]", "data.charge");
  const refunds = await wholeList(account, "/refunds", query, refundRowKnown, REFUND_PAGES, deadline);
  // A dispute closed as lost takes the certificate as a full refund does (lib/refunds.ts, the owner's rule of
  // 4 November 2026): read from Stripe's closing events; a read that fails or does not end keeps the place.
  const lost = await lostDisputesOrRetry(account, since, deadline, lostCursorKey("cert", sid));
  let unsure = refunds === null || !lost.complete;
  let newest = anchor;
  // The time of the oldest refund read that has not ended yet (Infinity: none): the place waits at it.
  let waiting = Infinity;
  let lookups = LOOKUPS;
  let withdrawn = 0;

  for (const row of [...lost.rows, ...(refunds ?? [])]) {
    if (Date.now() >= deadline) {
      unsure = true;
      break;
    }
    const id = typeof row.id === "string" ? row.id : "";
    const created = whole(row.created) ? row.created : 0;
    const pi = idOf(row.payment_intent);
    newest = Math.max(newest, created);
    const dispute = row.object === "dispute";
    if (!id) continue;
    if (!dispute) {
      // DONO-18: only a refund that went through takes anything; one still under way is read again until it ends.
      if (row.status === "pending" || row.status === "requires_action") {
        waiting = Math.min(waiting, created);
        continue;
      }
      if (row.status !== "succeeded" || !refundedInFull(row.charge)) continue;
    }
    if (!PI_ID.test(pi)) continue;
    try {
      const [seen] = exactReplies(await redisPipeline([["SISMEMBER", seenKey(sid), id]]), 1, WHAT);
      const handled = replyCount(seen, WHAT);
      if (handled > 1) throw new UnknownReply(WHAT);
      if (handled === 1) continue;
      if (lookups <= 0) {
        unsure = true;
        continue;
      }
      lookups -= 1;
      if (!dispute) {
        const settled = await refundedForGood(account, row.charge as Record<string, unknown>, deadline);
        if (settled === "waiting") {
          waiting = Math.min(waiting, created);
          continue;
        }
        if (settled === "no") continue;
      }
      const sale = await saleOf(store, account, pi, courses, deadline);
      let left = false;
      for (const product of sale?.courses ?? []) {
        const standing = await courseStandingFor(store, sale!.email, product.id);
        if (standing === "unknown") {
          left = true;
          continue;
        }
        if (standing === "shut" && (await withdrawForRefund(product.course!.id, sale!.email))) withdrawn += 1;
      }
      if (left) {
        unsure = true;
        continue;
      }
      // Marked read once handled: a pass that stops halfway leaves it to the next, which does the same again.
      exactReplies(
        await redisPipeline([
          ["SADD", seenKey(sid), id],
          ["EXPIRE", seenKey(sid), LOOKBACK_SECONDS * 2 + 86_400],
        ]),
        2,
        WHAT,
      ).forEach((reply) => replyCount(reply, WHAT));
    } catch (error) {
      console.error("a refund for certificates was left for the next pass", id, error instanceof Error ? error.name : typeof error);
      unsure = true;
    }
  }
  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead).
  if (!(await confirmLostRead(lost, seenKey(sid)))) unsure = true;
  else if (lost.complete && lost.resumed) newest = Math.min(newest, Math.max(lost.newest, since));
  newest = Math.min(newest, Math.max(waiting, since));
  if (!unsure) exactReplies(await redisPipeline([["SET", anchorKey(sid), String(Math.max(newest, since)), "EX", LOOKBACK_SECONDS * 2]]), 1, WHAT);
  else if (anchorRaw === null) exactReplies(await redisPipeline([["SET", anchorKey(sid), String(anchor), "EX", LOOKBACK_SECONDS * 2]]), 1, WHAT);
  return withdrawn;
}
