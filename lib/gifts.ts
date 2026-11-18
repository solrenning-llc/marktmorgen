/**
 * Gifts, kept and delivered (the rules are in lib/gift-rules.ts).
 *
 *   nl:gift:<id>                string  the gift: store, product, to, from, message; and once paid, the payment
 *   nl:gift:pi:<payment>        string  the gift a payment paid for, so a refund finds it
 *   nl:gift:<store>:any         string  present once the store has sold a gift
 *   nl:gift:<store>:refunds     string  how far the refunds were read for gifts
 *   nl:gift:<store>:seen        set     refunds already handled, thirty days from the last
 *
 * A paid gift is handed over the way a purchase brought over from another
 * platform is (lib/imported-purchases.ts): written down under the
 * recipient's address, so every door that opens a purchase for an address —
 * the list of purchases, the course, the community — opens it for them, and
 * the buyer's own checkout opens nothing (lib/bundle-rules.ts deliveredIds).
 */
import { consentEmailLines } from "@/lib/digital-consent-email";
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { cleanLine, cleanText } from "@/lib/community-text";
import { grantImported, importedKey } from "@/lib/imported-purchases";
import { bundleFromMeta } from "@/lib/bundle-rules";
import { onAccount } from "@/lib/stripe-account";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { confirmLostRead, givenBack, lostCursorKey, lostDisputesOrRetry, refundRowKnown, rowGivesBack } from "@/lib/refunds";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { formatMoney } from "@/lib/money";
import { type Listing, type Store, setPastBuyers, storeRef } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import { GIFT_ID, GIFT_KEPT_SECONDS, GIFT_PENDING_SECONDS, MAX_GIFT_FROM, MAX_GIFT_MESSAGE, canGift, givenOption } from "@/lib/gift-rules";
// On its own line, so open pull requests that change the imports above still merge cleanly.
import { type StripePage, StripeListUnreadable, readStripePage } from "@/lib/stripe-list";

export type Gift = {
  id: string;
  /** The store's statsId. */
  s: string;
  /** The product. */
  p: string;
  /** For a product with price options: the one that was chosen. */
  o?: string;
  /** The recipient's address. */
  to: string;
  /** The name the buyer gave, shown to the recipient; may be empty. */
  from: string;
  message: string;
  at: number;
  /** Once paid: the checkout and its payment. */
  session?: string;
  pi?: string;
  /** Once handed over, in seconds. */
  given?: number;
  /** Once taken back by a refund, in seconds. */
  revoked?: number;
};

const giftKey = (id: string) => `nl:gift:${id}`;
const piKey = (pi: string) => `nl:gift:pi:${pi}`;
/** What one gift keeps, by its id and its payment: for a closed store (lib/closed-store-data.ts). */
export const giftKeys = (id: string, pi: string): string[] => [...(id ? [giftKey(id), `${giftKey(id)}:giving`] : []), ...(pi ? [piKey(pi)] : [])];
const anyKey = (sid: string) => `nl:gift:${sid}:any`;
const anchorKey = (sid: string) => `nl:gift:${sid}:refunds`;

/**
 * Pages of the creator's refunds (GET /refunds, up to 100 each) the checkout sweep reads for gifts per store per run,
 * only for a store that ever sold one (CX-123 rule 24; r24 money inventory, item 1). Stripe lists the newest first: a
 * run that stops here with pages left keeps the anchor, so no refund behind them is passed over, and the next
 * run goes on from where it stopped (passKey). With the pre-orders (lib/preorders.ts, PREORDER_REFUND_PAGES_PER_STORE),
 * at most twice this many calls a store every five minutes; priced in tests/plan-cost-registry.ts (NOT_A_COST).
 */
export const GIFT_REFUND_PAGES_PER_STORE = 3;
const seenKey = (sid: string) => `nl:gift:${sid}:seen`;
/** The refunds already handled are kept thirty days from the last one marked (tests/store-data-registry.ts): each mark
 * gives the set its expiry again. Past it a row is only read again, and handling it again changes nothing (the record
 * it took back is marked revoked and kept on its own). */
const SEEN_KEEP_SECONDS = 30 * 86_400;
/** Where a pass over the refunds stands between runs (revokeRefundedGifts), in the store's nl:gift: keys (erased with it). */
const passKey = (sid: string) => `nl:gift:${sid}:refunds:pass`;
/** How long a pass is kept: well past the runs it takes, and short enough that one left behind is started again. */
const REFUND_PASS_SECONDS = 7 * 86_400;
/**
 * A pass: the window it reads (created since), the last refund it read, the newest refund it read, the connected
 * account it reads (a pass kept from the store's earlier account is started over: its cursor names a refund the
 * account it has now does not have; review of #3301, Claude 2 M2), the time the anchor waits at when the pass ends
 * (absent: nothing to wait for), that of the oldest refund it read that Stripe had not finished (heldAt) or that could
 * not be handled, and whether it read a row that is not readable (then the anchor stays where it was when the pass
 * ends), so the next pass reads each of those rows again.
 */
type RefundPass = { since: number; after: string; newest: number; account: string; waiting?: number; unread?: true };
/** A kept pass in its exact shape; null when there is none or it is in any other shape (then the pass starts over). */
function readRefundPass(raw: unknown): RefundPass | null {
  if (typeof raw !== "string") return null;
  let pass: unknown;
  try {
    pass = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!pass || typeof pass !== "object" || Array.isArray(pass)) return null;
  const { since, after, newest, account, waiting, unread } = pass as Record<string, unknown>;
  if (!Number.isSafeInteger(since) || (since as number) < 0 || !Number.isSafeInteger(newest) || (newest as number) < 0) return null;
  if (typeof after !== "string" || !/^[A-Za-z0-9_]{3,255}$/.test(after)) return null;
  if (typeof account !== "string" || !/^acct_[A-Za-z0-9]{1,255}$/.test(account)) return null;
  if (waiting !== undefined && (!Number.isSafeInteger(waiting) || (waiting as number) < 0)) return null;
  if (unread !== undefined && unread !== true) return null;
  // Figures a pass never keeps, each of which would move the anchor wrongly (review of #3301, Claude 2 L1): its newest
  // refund and the time it waits at lie within its window, from its start to now (with the anchor's 300 s margin).
  const latest = now() + 300;
  if ((newest as number) < (since as number) || (newest as number) > latest) return null;
  if (waiting !== undefined && ((waiting as number) < (since as number) || (waiting as number) > latest)) return null;
  return {
    since: since as number,
    after,
    newest: newest as number,
    account,
    ...(waiting === undefined ? {} : { waiting: waiting as number }),
    ...(unread === true ? { unread } : {}),
  };
}
/**
 * Whether a row gives back what it paid for, by the one shared rule (lib/refunds.ts rowGivesBack), as the other jobs
 * that take things back read it: a full refund going through (succeeded or pending), or a dispute lost; and, as
 * before, a refund that succeeded on a charge marked refunded, whatever else that charge says.
 */
function givesBack(refund: Record<string, unknown>): boolean {
  const charge = refund.charge as { refunded?: unknown } | null;
  return rowGivesBack(refund) || (refund.object !== "dispute" && refund.status === "succeeded" && charge?.refunded === true);
}
/**
 * The time of a refund Stripe has not finished (pending, or waiting on an action) whose charge is not refunded in full
 * yet; null for any other row. It holds the anchor at its time (review of #3188, Claude 3): a later refund never moves
 * the read past it, so it is listed again and taken back once it goes through. One that already gives everything back
 * is taken back now and holds nothing.
 */
function heldAt(refund: Record<string, unknown>): number | null {
  if (refund.object === "dispute" || (refund.status !== "pending" && refund.status !== "requires_action") || givesBack(refund)) return null;
  return typeof refund.created === "number" ? refund.created : 0;
}
/** A write of one item (HDEL, HSET, EXPIRE or SADD of one field, member or key) answers 0 or 1; anything else is unknown (Codex Z). */
const oneWrite = (reply: unknown): boolean => reply === 0 || reply === 1;
/** Marks a row of the refunds job read; true only when Redis answered the SADD of one member with 0 or 1. */
const markRead = async (sid: string, id: string): Promise<boolean> => {
  const marked = repliesFor(await redisPipeline([["SADD", seenKey(sid), id], ["EXPIRE", seenKey(sid), SEEN_KEEP_SECONDS]]), 2);
  return !!marked && oneWrite(marked[0]) && marked[1] === 1;
};
const now = () => Math.floor(Date.now() / 1000);

export function newGiftId(): string {
  return `gft_${randomBytes(12).toString("hex")}`;
}

export async function readGift(id: string): Promise<Gift | null> {
  if (!GIFT_ID.test(id) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", giftKey(id)]]);
  return typeof raw === "string" ? parseKeptGift(raw, id) : null;
}

/**
 * A gift's record for handing it over, read exactly (sweep A3; CX-123 rules 24 and 30): no record is null, and an
 * answer that is not one reply of text or nothing is unknown and throws, never "no gift", so a paid checkout is
 * never said as having nothing to hand over because Redis answered in another shape.
 */
async function readGiftExactly(id: string): Promise<Gift | null> {
  if (!GIFT_ID.test(id) || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", giftKey(id)]]), 1);
  if (!replies || (replies[0] !== null && typeof replies[0] !== "string")) throw new UnknownReplyError("a gift's record");
  return typeof replies[0] === "string" ? parseKeptGift(replies[0], id) : null;
}

/** A kept gift's record, when it is one and is this id's. */
function parseKeptGift(raw: string, id: string): Gift | null {
  try {
    const g = JSON.parse(raw) as Gift;
    return g && g.id === id ? g : null;
  } catch {
    return null;
  }
}

/** Writes a gift down; true only when Redis answered the write in its exact shape ("OK"). */
async function saveGift(gift: Gift, seconds: number): Promise<boolean> {
  return repliesFor(await redisPipeline([["SET", giftKey(gift.id), JSON.stringify(gift), "EX", seconds]]), 1)?.[0] === "OK";
}

export type GiftInput = { to: unknown; from: unknown; message: unknown };
export type NewGift = { ok: true; gift: Gift } | { ok: false; reason: "email" | "product" | "option" | "unavailable" };

/**
 * Writes down who a gift is for, before its checkout opens. For a product
 * with price options, `optionId` names the one being given.
 */
export async function startGift(store: Store, product: Listing, input: GiftInput, optionId: unknown = ""): Promise<NewGift> {
  if (!store.statsId || !isRedisConfigured()) return { ok: false, reason: "unavailable" };
  if (!canGift(product)) return { ok: false, reason: "product" };
  const chosen = givenOption(product, optionId);
  if (!chosen.ok) return { ok: false, reason: "option" };
  const raw = typeof input.to === "string" ? input.to.trim() : "";
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return { ok: false, reason: "email" };
  const gift: Gift = {
    id: newGiftId(),
    s: store.statsId,
    p: product.id,
    ...(chosen.option ? { o: chosen.option.id } : {}),
    to: normaliseEmail(raw),
    from: cleanLine(input.from, MAX_GIFT_FROM),
    message: cleanText(input.message, MAX_GIFT_MESSAGE),
    at: now(),
  };
  // Written down exactly before any checkout opens (sweep A3; CX-123 rules 24 and 30): a write answered in another
  // shape may not have landed, and a gift paid for with no record is never handed over. Refused instead, as
  // "unavailable" (the page says nothing was charged), and no checkout is made.
  if (!(await saveGift(gift, GIFT_PENDING_SECONDS))) return { ok: false, reason: "unavailable" };
  return { ok: true, gift };
}

type Session = {
  id?: unknown;
  created?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  payment_intent?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: unknown } | null;
};

/** What a paid gift checkout gives, and to whom: the product, and a bundle's products. */
function grantsOf(session: Session, gift: Gift): { email: string; productId: string; items: string[] | null; option: string | null } {
  const items = bundleFromMeta(session.metadata ?? null, "bundle");
  return { email: gift.to, productId: gift.p, items: items.length ? items : null, option: gift.o ?? null };
}

export type GiftOutcome = "given" | "already" | "skip";

/**
 * Takes back what this gift itself granted, as the refund pass does: its course first, then its purchase record, each
 * write confirmed. Only a record this gift wrote (`job` gift:<id>): a purchase the recipient holds another way (a
 * PayPal sale, another gift, a place) is never taken by this gift's refund. No record is nothing to take back; a
 * record or a reply that does not read, or no way to take a course back, throws (CX-123 rule 24).
 */
async function takeBackOwnGrant(gift: Gift, items: string[] | null, dropStart?: (email: string, courseProductId: string) => Promise<void>): Promise<void> {
  const held = repliesFor(await redisPipeline([["HGET", importedKey(gift.s, gift.to), gift.p]]), 1);
  if (!held) throw new UnknownReplyError("a given-back gift's purchase record");
  const raw = held[0];
  if (raw === null) {
    // No record: the purchase is gone; a course this gift dated may still be there, and taking it back is harmless.
    if (dropStart) for (const productId of [gift.p, ...(items ?? [])]) await dropStart(gift.to, productId);
    return;
  }
  if (typeof raw !== "string") throw new UnknownReplyError("a given-back gift's purchase record");
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new UnknownReplyError("a given-back gift's purchase record");
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new UnknownReplyError("a given-back gift's purchase record");
  const job = (record as { job?: unknown }).job;
  if (typeof job !== "string") throw new UnknownReplyError("a given-back gift's purchase record");
  if (job !== `gift:${gift.id}`) return;
  if (!dropStart) throw new UnknownReplyError("a given-back gift's course: nothing to take it back with");
  const listed = (record as { items?: unknown }).items;
  const recorded = Array.isArray(listed) ? listed.filter((item): item is string => typeof item === "string") : [];
  for (const productId of [gift.p, ...new Set([...(items ?? []), ...recorded])]) await dropStart(gift.to, productId);
  const removed = repliesFor(await redisPipeline([["HDEL", importedKey(gift.s, gift.to), gift.p]]), 1);
  if (!oneWrite(removed?.[0])) throw new UnknownReplyError("taking a given-back gift's purchase away");
}


/**
 * Hands a paid gift over, once: writes it down under the recipient's address
 * (and a course's start date, so its modules open on time for them), emails
 * them, and emails the buyer their receipt. The caller has checked the
 * checkout is settled and this store's.
 */
export async function deliverGift(input: {
  store: Store;
  session: Session;
  product: Listing;
  /** Where the store lives, for the links in both emails (lib/purchase-email.ts storeBase). */
  base: string;
  from: string;
  recordStart: (email: string, courseProductId: string, startSeconds: number) => Promise<void>;
  /**
   * Takes a course back (lib/learn.ts dropEnrollment): for a gift given back before it was confirmed, whose earlier
   * run may have granted it already. Without it, such a gift throws, so nothing is marked and the next run tries again.
   */
  dropStart?: (email: string, courseProductId: string) => Promise<void>;
  ordersLink: (email: string) => Promise<string | null>;
}): Promise<GiftOutcome> {
  const { store, session, product } = input;
  const id = session.metadata?.gift ?? "";
  const seen = await readGiftExactly(id);
  if (!seen || seen.s !== store.statsId || seen.p !== product.id) return "skip";
  // Given already. Its emails come after the write that marks it given, so a run whose reply to that write came back
  // in another shape threw before sending them (#2872 review M1): a later run with no "sent" mark (the caller checked)
  // still tells, once (the emails' own idempotency keys), while that is recent. Taken back by a refund, or given
  // longer ago than a run is retried, there is nothing to tell.
  if (seen.given && (seen.revoked || now() - seen.given >= TELL_WITHIN_SECONDS)) return "already";
  // The mark read exactly (lib/claim-mark.ts; CX-123 rules 24 and 25): somebody else's is "already"; an unknown one
  // gives nothing and says so, as when Redis does not answer, so no "sent" mark is kept and the next run tries again.
  const mark = `${giftKey(id)}:giving`;
  const value = claimValue();
  const claimed = await claimMark(mark, 300, value);
  if (claimed === "taken") {
    // Another run holds the mark: thrown, even once the gift is given (Claude 2 K and Claude 6 on #2872).
    // confirmGift (lib/purchase-email.ts) keeps its "sent" mark on "already", and the run holding the mark may have
    // written the gift given and died before its emails: "already" here would certify an email never sent, and
    // nothing would tell it again. Thrown, no "sent" mark is kept; the run holding the mark keeps its own once it has
    // told, and if it died, the next run takes the mark once it runs out and tells from the given record (M1's path).
    throw new Error("another run is giving this gift right now");
  }
  if (claimed === "unknown") throw new UnknownReplyError("a gift's giving mark");
  // Read again now that the mark is ours, as handOverPreorder does (Claude 7's race hunt): a run that read the gift
  // before another run gave it, and took the mark once that run let it go, must not give it again from its old copy.
  // A refund taken back in between would be undone: the purchase granted again, {...gift, given} written over the
  // revoked mark, and the refund, already read, never read again. Read exactly (CX-123 rule 24): unknown throws.
  let kept: Gift | null;
  try {
    const reply = repliesFor(await redisPipeline([["GET", giftKey(id)]]), 1)?.[0];
    if (reply === undefined || (reply !== null && typeof reply !== "string")) throw new UnknownReplyError("a gift");
    kept = typeof reply === "string" ? parseKeptGift(reply, id) : null;
  } catch (error) {
    await releaseMark(mark, value);
    throw error;
  }
  if (!kept || kept.s !== store.statsId || kept.p !== product.id) {
    await releaseMark(mark, value);
    return "skip";
  }
  // Taken back by a refund, or given longer ago than a run is retried: nothing to give or tell.
  if (kept.revoked || (kept.given && now() - kept.given >= TELL_WITHIN_SECONDS)) {
    await releaseMark(mark, value);
    return "already";
  }
  // The mark is kept, not let go, once the gift is given: it runs out by itself, after the caller has kept its
  // "sent" mark, so a run that comes in meanwhile reads "taken" and throws instead of telling and confirming a second
  // time (#2872 review M1), and never certifies an email this run may not have sent (Claude 6 on #2872).
  if (kept.given) {
    await tellGift(input, kept, kept.session ?? (typeof session.id === "string" ? session.id : ""));
    return "given";
  }
  const gift = kept;

  const sessionId = typeof session.id === "string" ? session.id : "";
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : "";
  const created = typeof session.created === "number" ? session.created : now();
  const grant = grantsOf(session, gift);
  // The payment's index first, before the payment is read, as a pre-order writes nl:pre:pi: before its read (review
  // 6862531714 on #4408): a refund the pass meets from now on finds this gift, whether or not this run gets to the end.
  // Each write answered exactly "OK", or nothing is read or given and the next run tries again.
  // Whatever throws from here to the gift's record lets go of this run's giving mark first (merge of main into #4408):
  // the mark is kept only once the gift is given, so a run that stopped on an unknown answer never makes the next one
  // wait out the mark ("another run is giving this gift right now") for a gift nobody is giving.
  try {
    if (pi) {
      const indexed = repliesFor(await redisPipeline([["SET", piKey(pi), gift.id, "EX", GIFT_KEPT_SECONDS], ["SET", anyKey(gift.s), "1"]]), 2);
      if (!indexed || indexed[0] !== "OK" || indexed[1] !== "OK") throw new UnknownReplyError("a gift's payment index");
    }
    // Refunded in full or lost to a dispute before it was first confirmed: read the payment itself (MM-E2E-RG-1); a
    // read that fails or answers for another payment throws, nothing is given, no "sent" mark is kept and the next run
    // reads it again. Given back, what an earlier run of this gift may have granted is taken back before it is marked
    // revoked.
    if (pi && store.stripeAccountId) {
      const payment = await onAccount("GET", store.stripeAccountId, `/payment_intents/${encodeURIComponent(pi)}?expand[]=latest_charge`);
      if (!payment || typeof payment !== "object" || (payment as { id?: unknown }).id !== pi) throw new UnknownReplyError("a gift's payment");
      if (await givenBack(store.stripeAccountId, payment)) {
        await takeBackOwnGrant(gift, grant.items, input.dropStart);
        if (!(await saveGift({ ...gift, session: sessionId, pi, revoked: now() }, GIFT_KEPT_SECONDS))) throw new UnknownReplyError("a gift given back");
        await releaseMark(mark, value);
        return "already";
      }
    }
    await grantImported(gift.s, `gift:${gift.id}`, [grant], created, store.sid);
    // The doors that read what an address was given are opened for this store.
    if (!store.pastBuyers) await setPastBuyers(storeRef(store));
    // A course, or a course inside a bundle, is dated from the day it was paid.
    for (const id of [gift.p, ...(grant.items ?? [])]) await input.recordStart(gift.to, id, created);
  } catch (error) {
    await releaseMark(mark, value);
    throw error;
  }

  // Read again before "given" is written (this PR): the refund pass may have taken this gift back meanwhile (it finds
  // it through the payment's index written above), and "given" saved over its "revoked" would never be taken back
  // again. Read exactly: unknown lets go of the mark and throws, nothing is marked and the next run reads it again.
  let latest: Gift | null;
  try {
    latest = await readGiftExactly(id);
  } catch (error) {
    await releaseMark(mark, value);
    throw error;
  }
  if (!latest) {
    await releaseMark(mark, value);
    throw new UnknownReplyError("a gift read again before it is marked given");
  }
  if (latest.revoked) {
    // Taken back while this run was giving: a course this run dated after the pass dropped it goes too (harmless twice).
    await takeBackOwnGrant(latest, grant.items, input.dropStart);
    await releaseMark(mark, value);
    return "already";
  }
  // What a refund looks up (the payment's gift, and that this store sold one) is written before the gift is marked
  // given, each answered exactly "OK" (sweep A3; CX-123 rules 24 and 30): with a payment, both were written above,
  // before the payment was read; without one, the store's mark is written here. A write left unknown lets go of the
  // mark and throws, so confirmGift keeps no "sent" mark and the next run does it again.
  const records: (string | number)[][] = pi ? [] : [["SET", anyKey(gift.s), "1"]];
  const keptReplies = records.length ? repliesFor(await redisPipeline(records), records.length) : [];
  if (!keptReplies || !keptReplies.every((reply) => reply === "OK")) {
    await releaseMark(mark, value);
    throw new UnknownReplyError("a given gift's payment record");
  }
  const given: Gift = { ...latest, session: sessionId, pi, given: now() };
  if (!(await saveGift(given, GIFT_KEPT_SECONDS))) {
    await releaseMark(mark, value);
    throw new UnknownReplyError("a given gift's record");
  }
  await tellGift(input, given, sessionId);
  return "given";
}

/**
 * How long after a gift was given a run still tells about it when the caller kept no "sent" mark: the window the
 * checkout sweep confirms in (lib/purchase-email.ts CONFIRM_WITHIN_SECONDS, one day), inside the emails' own
 * idempotency, so a late run never sends them a second time.
 */
const TELL_WITHIN_SECONDS = 24 * 60 * 60;

/** Emails the recipient that a gift is theirs, and the buyer their receipt, each under its own idempotency key. */
async function tellGift(input: Parameters<typeof deliverGift>[0], gift: Gift, sessionId: string): Promise<void> {
  const { store, session, product, base } = input;
  const g = givingWords(store.language);
  const who = gift.from || g.someone;
  // Given at one of the product's prices: named with it, as on the receipt.
  const label = gift.o ? product.options.find((o) => o.id === gift.o)?.label ?? "" : "";
  const title = label ? `${product.title} (${label})` : product.title;
  const link = (await input.ordersLink(gift.to)) ?? `${base}/orders`;
  await sendEmail({ meter: { by: "order" },
    from: input.from,
    to: gift.to,
    subject: g.giftSubject(who, title).slice(0, 200),
    text: [
      g.giftLead(who, title, store.name),
      ...(gift.message ? ["", g.theirMessage, gift.message] : []),
      "",
      g.giftYours,
      link,
      "",
      g.link24(`${base}/orders`),
      "",
      g.sentByNothing(store.name),
    ].join("\n"),
    idempotencyKey: `nimbus-gift:${gift.id}`,
  }).catch((error) => console.error("a gift email failed", error));

  const buyer = typeof session.customer_details?.email === "string" ? session.customer_details.email : "";
  if (buyer) {
    // What Stripe charged, read exactly (CX-123 rule 24; audit R48): a whole number of cents, never below zero, in a
    // three-letter currency. Anything else leaves the line out, never the catalog's current price or the store's own
    // currency.
    const amount = session.amount_total;
    const currency = session.currency;
    const paid = Number.isSafeInteger(amount) && Number(amount) >= 0 && typeof currency === "string" && /^[a-z]{3}$/.test(currency)
      ? formatMoney(Number(amount), currency, speech(store).lang.locale)
      : null;
    await sendEmail({ meter: { by: "order" },
      from: input.from,
      to: buyer,
      subject: g.giftReceiptSubject(title).slice(0, 200),
      text: [
        g.thanksReceipt(store.name),
        "",
        g.aGift(title),
        g.giftFor(gift.to),
        ...(paid ? [g.paidLine(paid)] : []),
        g.orderRef(sessionId),
        ...consentEmailLines(store, session.metadata),
        "",
        g.weEmailed(gift.to, Boolean(gift.from), Boolean(gift.message)),
        "",
        g.chargedBy(store.name),
      ].join("\n"),
      replyTo: store.email,
      idempotencyKey: `nimbus-gift-receipt:${gift.id}`,
    }).catch((error) => console.error("a gift receipt failed", error));
  }
}

/** The buyer's name on a gift, for the recipient's list of purchases. */
export async function giftFrom(job: string): Promise<string | null> {
  if (!job.startsWith("gift:")) return null;
  const gift = await readGift(job.slice(5));
  return gift ? gift.from || "someone" : "someone";
}

/**
 * Takes back gifts whose payment was refunded in full: reads the store's
 * refunds since it last looked, finds the gift each paid for, and removes it
 * from the recipient's purchases and course. Returns how many went.
 */
export async function revokeRefundedGifts(
  store: Store,
  deadline: number,
  dropStart: (email: string, courseProductId: string) => Promise<void>,
): Promise<number> {
  if (!store.statsId || !store.stripeAccountId || !isRedisConfigured()) return 0;
  const sid = store.statsId;
  const account = store.stripeAccountId;
  // The first reads in their exact shape (CX-123 rule 24): a reply cut short or in another shape does nothing this
  // run, and asks nothing of Stripe; the next run reads them again.
  const begun = repliesFor(await redisPipeline([["GET", anyKey(sid)], ["GET", anchorKey(sid)], ["GET", passKey(sid)]]), 3);
  if (!begun) return 0;
  const [any, anchorRaw, passRaw] = begun;
  if (!any) return 0;
  // The place is a time or nothing yet (rule 24): anything else does nothing this run, never a newer window written
  // over the real place at the end of the pass.
  if (anchorRaw !== null && !(typeof anchorRaw === "string" && /^\d{1,12}$/.test(anchorRaw))) {
    console.error("reading refunds for gifts: the kept place is not a time; the run does nothing");
    return 0;
  }
  const fresh = Math.max(0, (Number(anchorRaw) || now() - 7 * 86_400) - 300);
  // A pass over the refunds longer than one run goes on where the last run stopped (r24 money inventory, item 1, the
  // gap left by #3188), as lib/group-buy.ts does: without it a store with more refunds since the anchor than one run
  // reads read the same newest pages every run and never reached the older ones. A pass kept in an unknown shape (not
  // text, not the pass's JSON, a cursor that is not an id), or of another anchor's window, is started over from the
  // anchor, which never moved past it: read again, never skipped.
  const keptPass = readRefundPass(passRaw);
  const pass = keptPass && keptPass.account === account && (anchorRaw === null || keptPass.since === fresh) ? keptPass : null;
  const since = pass ? pass.since : fresh;
  let newest = pass ? pass.newest : Number(anchorRaw) || since;
  let after = pass ? pass.after : "";
  // The oldest refund the pass read that Stripe had not finished (heldAt; Infinity: none), kept with the pass.
  let waiting = pass?.waiting ?? Infinity;
  /** The pass as it is kept between runs. */
  // Whether the pass read a row that is not readable: the anchor then stays where it was when the pass ends.
  let unread = pass?.unread === true;
  const passNow = (): RefundPass => ({ since, after, newest, account, ...(Number.isFinite(waiting) ? { waiting } : {}), ...(unread ? { unread } : {}) });
  let revoked = 0;

  /** One row read whole and handled: false when something it needed was left unknown, and then it is not marked read. */
  const handle = async (refund: Record<string, unknown>): Promise<boolean> => {
    const id = typeof refund.id === "string" ? refund.id : "";
    const pi = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
    const dispute = refund.object === "dispute";
    if (dispute && id && !pi) {
      // No payment to look up: nothing of this store can be told from it, so it is read, and never holds the place back.
      return markRead(sid, id);
    }
    if (!id || !pi || !givesBack(refund)) return true;
    // Read before anything is marked (Codex Z on #2724; CX-123 rule 24): whether this row was handled, the payment's
    // gift and the gift itself, each in its exact shape. Unknown leaves the row unread and the read unsure, and the
    // next run asks again; nothing is marked read until it was handled.
    const looked = repliesFor(await redisPipeline([["SISMEMBER", seenKey(sid), id], ["GET", piKey(pi)]]), 2);
    const handled = countOf(looked?.[0]);
    const giftId = looked?.[1];
    if (!looked || handled === null || handled > 1 || (giftId !== null && typeof giftId !== "string")) return false;
    if (handled === 1) return true;
    if (typeof giftId === "string") {
      const kept = GIFT_ID.test(giftId) ? repliesFor(await redisPipeline([["GET", giftKey(giftId)]]), 1)?.[0] : null;
      if (kept !== null && typeof kept !== "string") return false;
      const gift = typeof kept === "string" ? parseKeptGift(kept, giftId) : null;
      if (gift && !gift.revoked && gift.s === sid) {
        const given = repliesFor(await redisPipeline([["HGET", importedKey(sid, gift.to), gift.p]]), 1)?.[0];
        if (given !== null && typeof given !== "string") return false;
        // No record: nothing of this gift is held as a purchase any more (null). A record that does not read is
        // unknown, never "no items" (rule 30, Claude 4 on #2781).
        let items: string[] = [];
        // Only what this gift gave (as lib/group-buy.ts and lib/preorders.ts): grantImported writes with HSETNX, so a
        // gift to an address that already held the product another way (a PayPal purchase, a place, a pre-order, an
        // import, an earlier gift) wrote nothing, and its refund must leave that other purchase and its course alone.
        let ours = false;
        if (typeof given === "string") {
          let v: unknown;
          try {
            v = JSON.parse(given);
          } catch {
            v = undefined;
          }
          if (!v || typeof v !== "object" || Array.isArray(v)) return false;
          const job = (v as { job?: unknown }).job;
          // A job that is not text is unknown, never "came another way": the row waits to be tried again.
          if (typeof job !== "string") return false;
          ours = job === `gift:${gift.id}`;
          const listed = (v as { items?: unknown }).items;
          items = Array.isArray(listed) ? listed.filter((item): item is string => typeof item === "string") : [];
        }
        if (typeof given === "string" && !ours) {
          // Nothing of this gift is held: it is marked taken back, and what came another way stays.
          if (!(await saveGift({ ...gift, revoked: now() }, GIFT_KEPT_SECONDS))) return false;
          return markRead(sid, id);
        }
        // The course first, then the purchase (Codex G on #2781; rule 30): a course removal that fails keeps the
        // purchase, so the next run takes both away again; taking a course away twice is harmless.
        try {
          for (const productId of [gift.p, ...items]) await dropStart(gift.to, productId);
        } catch (error) {
          console.error("taking a refunded gift's course away failed; tried again next run", error);
          return false;
        }
        // Each write confirmed in its exact shape before the next (Codex Z, review 5794703899; CX-123 rule 24): a
        // write left unknown marks nothing taken back or read and keeps the anchor, so the next run does it again.
        const removed = repliesFor(await redisPipeline([["HDEL", importedKey(sid, gift.to), gift.p]]), 1);
        if (!oneWrite(removed?.[0])) return false;
        if (!(await saveGift({ ...gift, revoked: now() }, GIFT_KEPT_SECONDS))) return false;
        revoked += 1;
      }
    }
    // Marked read once handled: a run that stops halfway leaves it to the next, which does the same again.
    return markRead(sid, id);
  };

  /** One page of refunds in its exact shape (lib/stripe-list.ts), each row as refundRowKnown() reads it; null when the page itself could not be read. */
  const readPage = async (from: string): Promise<StripePage | null> => {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (from) query.set("starting_after", from);
    try {
      const raw = await onAccount("GET", account, `/refunds?${query}`);
      const latest = now() + 300;
      return readStripePage(raw, row => refundRowKnown(row) && (row.created as number) <= latest);
    } catch (error) {
      if (!(error instanceof StripeListUnreadable)) throw error;
      console.error("reading refunds for gifts: a page in another shape", error);
      return null;
    }
  };

  // A dispute closed as lost takes a gift back as a full refund does, whatever its amount (lib/refunds.ts, the
  // owner's rule of 4 November 2026; queue 388 [TB14]): read from Stripe's closing events, as lib/call-meetings.ts
  // does. A read that fails or does not reach the end keeps the place, so it is read again next run.
  const lost = await lostDisputesOrRetry(account, since, deadline, lostCursorKey("gift", sid));
  let unsure = !lost.complete;
  let lostNewest = 0;
  for (const row of lost.rows) {
    if (Date.now() >= deadline) return revoked;
    lostNewest = Math.max(lostNewest, typeof row.created === "number" ? row.created : 0);
    if (!(await handle(row))) unsure = true;
  }

  // Every page of the refunds since the anchor (CX-123 rule 24; r24 money inventory, item 1), newest first, read in
  // its exact shape. The pass moves past a page once every row on it was read and handled as far as it can be (kept in
  // passKey, a week); a row not readable or not handled holds the anchor, never the pass, and a page in another shape
  // or a run out of time leaves the pass on that page, read again next run. A run that resumes a pass
  // first reads the newest page, so a refund made meanwhile does not wait for the pass: what it reads there never
  // moves the pass or the anchor, and the next pass reads it again (each handled one stays handled).
  let pages = GIFT_REFUND_PAGES_PER_STORE;
  if (after) {
    pages -= 1;
    const top = await readPage("");
    for (const refund of top?.rows ?? []) {
      if (Date.now() >= deadline) return revoked;
      await handle(refund);
    }
  }
  let ended = false;
  for (let page = 0; page < pages; page += 1) {
    if (Date.now() >= deadline) return revoked;
    const read = await readPage(after);
    if (!read) break;
    // One row that cannot be handled, or that is not readable at all, never holds the pages behind it (reviews of
    // #3301, Claude 2 M1 and Claude 5): the pass goes on, the row is never marked read, and the anchor waits for it.
    // A row not handled holds the anchor at its time, as a refund Stripe had not finished does; a row not readable,
    // whose time is not known, keeps the anchor where it was. The next pass reads it again either way:
    // never taken as refunded, never as not refunded, never passed over.
    let unhandled = Infinity;
    for (const refund of read.rows) {
      if (Date.now() >= deadline) return revoked;
      if (!(await handle(refund))) unhandled = Math.min(unhandled, typeof refund.created === "number" ? refund.created : since);
    }
    // The page read and handled as far as it can be moves the pass, and what it read moves with it: its newest refund,
    // and the time the anchor waits at, however far the pass goes on (the pass skips no page; the anchor waits on it).
    waiting = Math.min(waiting, unhandled);
    if (read.unreadable > 0) unread = true;
    for (const refund of read.rows) {
      newest = Math.max(newest, typeof refund.created === "number" ? refund.created : 0);
      const held = heldAt(refund);
      if (held !== null) waiting = Math.min(waiting, held);
    }
    if (!read.hasMore) {
      ended = true;
      break;
    }
    // The next page is read from the last row, or, when that row is not readable, from the last readable one, which
    // reads the rows after it again (never skipped). A page with no readable row at all has nothing to go on from:
    // the pass stays on it and the anchor where it was, so nothing behind it is passed over.
    const from = read.lastId ?? read.rows.at(-1)?.id ?? null;
    if (!from) {
      console.error("reading refunds for gifts: a page with no readable row; the pass stays on it");
      break;
    }
    after = from;
    // Either reply leaves a place that skips nothing: this page's last row, or the one kept before it (read again).
    await redisPipeline([["SET", passKey(sid), JSON.stringify(passNow()), "EX", REFUND_PASS_SECONDS]]);
  }
  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead), and the
  // anchor with it: the closing events are read from the anchor, so it waits while they are not all read.
  if (!(await confirmLostRead(lost, seenKey(sid)))) unsure = true;
  else if (lost.complete && lost.resumed) newest = Math.min(newest, Math.max(lost.newest, since));
  // The anchor moves, and the pass is let go, only once the list was read to its end and every lost dispute handled.
  // A closing read in this run counts toward it only when this run began the pass: one that resumed it may have
  // passed refunds made since the pass began, which the next pass reads from the anchor.
  if (ended && !unsure) {
    // Never past a refund the pass read that Stripe had not finished, or that could not be handled: the next pass reads
    // it again from there. A pass that read a row not readable lets the pass go and keeps the anchor where it was.
    const anchor = Math.min(pass || (lost.complete && lost.resumed) ? newest : Math.max(newest, lostNewest), Math.max(waiting, since));
    const closed = repliesFor(await redisPipeline([...(unread ? [] : [["SET", anchorKey(sid), String(anchor)]]), ["DEL", passKey(sid)]]), unread ? 1 : 2);
    if (!closed) console.error("ending a pass over refunds for gifts was left unknown");
  }
  return revoked;
}
