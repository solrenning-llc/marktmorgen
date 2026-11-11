/**
 * Gifts, kept and delivered (the rules are in lib/gift-rules.ts).
 *
 *   nl:gift:<id>                string  the gift: store, product, to, from, message; and once paid, the payment
 *   nl:gift:pi:<payment>        string  the gift a payment paid for, so a refund finds it
 *   nl:gift:<store>:any         string  present once the store has sold a gift
 *   nl:gift:<store>:refunds     string  how far the refunds were read for gifts
 *   nl:gift:<store>:seen        set     refunds already handled
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
import { confirmLostRead, lostCursorKey, lostDisputesOrRetry, refundRowKnown, rowGivesBack } from "@/lib/refunds";
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
const markRead = async (sid: string, id: string): Promise<boolean> => oneWrite(repliesFor(await redisPipeline([["SADD", seenKey(sid), id]]), 1)?.[0]);
const now = () => Math.floor(Date.now() / 1000);

export function newGiftId(): string {
  return `gft_${randomBytes(12).toString("hex")}`;
}

export async function readGift(id: string): Promise<Gift | null> {
  if (!GIFT_ID.test(id) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", giftKey(id)]]);
  return typeof raw === "string" ? parseKeptGift(raw, id) : null;
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

/**
 * Whether a gift is given, read exactly, for a run that found another run's
 * giving mark (Codex CX1 on #2726; CX-123 rule 24): one reply, the record as
 * text, JSON of this gift, and `given` a positive whole number of seconds
 * (true) or absent (false). Anything else is unknown and throws, so nothing
 * is said as given that is not.
 */
async function givenExactly(id: string): Promise<boolean> {
  const raw = repliesFor(await redisPipeline([["GET", giftKey(id)]]), 1)?.[0];
  let record: unknown = null;
  try {
    record = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    record = null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record) || (record as { id?: unknown }).id !== id) throw new UnknownReplyError("a gift's record");
  const given = (record as { given?: unknown }).given;
  if (given === undefined) return false;
  if (typeof given === "number" && Number.isSafeInteger(given) && given > 0) return true;
  throw new UnknownReplyError("a gift's record");
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
  await saveGift(gift, GIFT_PENDING_SECONDS);
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
  ordersLink: (email: string) => Promise<string | null>;
}): Promise<GiftOutcome> {
  const { store, session, product, base } = input;
  const id = session.metadata?.gift ?? "";
  const gift = await readGift(id);
  if (!gift || gift.s !== store.statsId || gift.p !== product.id) return "skip";
  if (gift.given) return "already";
  // The mark read exactly (lib/claim-mark.ts; CX-123 rules 24 and 25): somebody else's is "already"; an unknown one
  // gives nothing and says so, as when Redis does not answer, so no "sent" mark is kept and the next run tries again.
  const mark = `${giftKey(id)}:giving`;
  const value = claimValue();
  const claimed = await claimMark(mark, 300, value);
  if (claimed === "taken") {
    // Another run holds the mark. "already" only once the gift is given (Claude 4 on #2726): confirmGift
    // (lib/purchase-email.ts) keeps its "sent" mark on "already", so said while the other run may still fail, the
    // paid gift would never be given. Thrown, no "sent" mark is kept and the next run tries again.
    if (await givenExactly(id)) return "already";
    throw new Error("another run is giving this gift right now");
  }
  if (claimed === "unknown") throw new UnknownReplyError("a gift's giving mark");

  const sessionId = typeof session.id === "string" ? session.id : "";
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : "";
  const created = typeof session.created === "number" ? session.created : now();
  const grant = grantsOf(session, gift);
  await grantImported(gift.s, `gift:${gift.id}`, [grant], created, store.sid);
  // The doors that read what an address was given are opened for this store.
  if (!store.pastBuyers) await setPastBuyers(storeRef(store));
  // A course, or a course inside a bundle, is dated from the day it was paid.
  for (const id of [gift.p, ...(grant.items ?? [])]) await input.recordStart(gift.to, id, created);

  const given: Gift = { ...gift, session: sessionId, pi, given: now() };
  await saveGift(given, GIFT_KEPT_SECONDS);
  await redisPipeline([
    ...(pi ? [["SET", piKey(pi), gift.id, "EX", GIFT_KEPT_SECONDS] as (string | number)[]] : []),
    ["SET", anyKey(gift.s), "1"],
  ]);
  // Let go only while it still holds this run's value: one whose time ran out may be another run's now.
  await releaseMark(mark, value);

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
        g.weEmailed(gift.to, Boolean(gift.message)),
        "",
        g.chargedBy(store.name),
      ].join("\n"),
      replyTo: store.email,
      idempotencyKey: `nimbus-gift-receipt:${gift.id}`,
    }).catch((error) => console.error("a gift receipt failed", error));
  }
  return "given";
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
        if (typeof given === "string") {
          let v: unknown;
          try {
            v = JSON.parse(given);
          } catch {
            v = undefined;
          }
          if (!v || typeof v !== "object" || Array.isArray(v)) return false;
          const listed = (v as { items?: unknown }).items;
          items = Array.isArray(listed) ? listed.filter((item): item is string => typeof item === "string") : [];
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
      return readStripePage(await onAccount("GET", account, `/refunds?${query}`), refundRowKnown);
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
