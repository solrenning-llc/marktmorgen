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
const seenKey = (sid: string) => `nl:gift:${sid}:seen`;
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
  const { store, session, product } = input;
  const id = session.metadata?.gift ?? "";
  const gift = await readGiftExactly(id);
  if (!gift || gift.s !== store.statsId || gift.p !== product.id) return "skip";
  // Given already. Its emails come after the write that marks it given, so a run whose reply to that write came back
  // in another shape threw before sending them (#2872 review M1): a later run with no "sent" mark (the caller checked)
  // still tells, once (the emails' own idempotency keys), while that is recent. Taken back by a refund, or given
  // longer ago than a run is retried, there is nothing to tell.
  if (gift.given && (gift.revoked || now() - gift.given >= TELL_WITHIN_SECONDS)) return "already";
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
  // The mark is kept, not let go, once the gift is given: it runs out by itself, after the caller has kept its
  // "sent" mark, so a run that comes in meanwhile reads "taken" and given and says "already" instead of telling and
  // confirming a second time (#2872 review M1).
  if (gift.given) {
    await tellGift(input, gift, gift.session ?? (typeof session.id === "string" ? session.id : ""));
    return "given";
  }

  const sessionId = typeof session.id === "string" ? session.id : "";
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : "";
  const created = typeof session.created === "number" ? session.created : now();
  const grant = grantsOf(session, gift);
  await grantImported(gift.s, `gift:${gift.id}`, [grant], created, store.sid);
  // The doors that read what an address was given are opened for this store.
  if (!store.pastBuyers) await setPastBuyers(storeRef(store));
  // A course, or a course inside a bundle, is dated from the day it was paid.
  for (const id of [gift.p, ...(grant.items ?? [])]) await input.recordStart(gift.to, id, created);

  // What a refund looks up (the payment's gift, and that this store sold one) is written first and the gift marked
  // given last, each answered exactly "OK" (sweep A3; CX-123 rules 24 and 30): a write left unknown lets go of the
  // mark and throws, so confirmGift keeps no "sent" mark and the next run does it again, never "already" on a gift
  // whose payment a refund could not find.
  const kept: (string | number)[][] = [...(pi ? [["SET", piKey(pi), gift.id, "EX", GIFT_KEPT_SECONDS]] : []), ["SET", anyKey(gift.s), "1"]];
  const keptReplies = repliesFor(await redisPipeline(kept), kept.length);
  if (!keptReplies || !keptReplies.every((reply) => reply === "OK")) {
    await releaseMark(mark, value);
    throw new UnknownReplyError("a given gift's payment record");
  }
  const given: Gift = { ...gift, session: sessionId, pi, given: now() };
  if (!(await saveGift(given, GIFT_KEPT_SECONDS))) {
    await releaseMark(mark, value);
    throw new UnknownReplyError("a given gift's record");
  }
  await tellGift(input, gift, sessionId);
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
    const amount = typeof session.amount_total === "number" ? session.amount_total : product.priceCents;
    const currency = typeof session.currency === "string" && session.currency ? session.currency : store.currency;
    await sendEmail({ meter: { by: "order" },
      from: input.from,
      to: buyer,
      subject: g.giftReceiptSubject(title).slice(0, 200),
      text: [
        g.thanksReceipt(store.name),
        "",
        g.aGift(title),
        g.giftFor(gift.to),
        g.paidLine(formatMoney(amount, currency, speech(store).lang.locale)),
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
  const [any, anchorRaw] = await redisPipeline([["GET", anyKey(sid)], ["GET", anchorKey(sid)]]);
  if (!any) return 0;
  const since = Math.max(0, (Number(anchorRaw) || now() - 7 * 86_400) - 300);
  let newest = Number(anchorRaw) || since;
  let revoked = 0;
  const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
  query.append("expand[]", "data.charge");
  const listed = await onAccount("GET", store.stripeAccountId, `/refunds?${query}`);
  // The refunds in their exact shape (Codex Q on #2724; CX-123 rule 24): a list of rows each as refundRowKnown()
  // reads it, with every field that decides whether money went back. Anything else leaves the read unsure, so the
  // anchor does not move past refunds that could not be read.
  const refundsKnown = Array.isArray(listed.data) && (listed.data as unknown[]).every(refundRowKnown);
  const refunds = refundsKnown ? (listed.data as Record<string, unknown>[]) : [];
  // A dispute closed as lost takes a gift back as a full refund does, whatever its amount (lib/refunds.ts, the
  // owner's rule of 4 November 2026; queue 388 [TB14]): read from Stripe's closing events, as lib/call-meetings.ts
  // does. A read that fails or does not reach the end keeps the place, so it is read again next run.
  const lost = await lostDisputesOrRetry(store.stripeAccountId, since, deadline, lostCursorKey("gift", sid));
  let unsure = !lost.complete || !refundsKnown;
  for (const refund of [...lost.rows, ...refunds]) {
    if (Date.now() >= deadline) return revoked;
    const id = typeof refund.id === "string" ? refund.id : "";
    const created = typeof refund.created === "number" ? refund.created : 0;
    const pi = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
    const charge = refund.charge as { refunded?: unknown } | null;
    const dispute = refund.object === "dispute";
    newest = Math.max(newest, created);
    if (dispute && id && !pi) {
      // No payment to look up: nothing of this store can be told from it, so it is read, and never holds the place back.
      if (!(await markRead(sid, id))) unsure = true;
      continue;
    }
    if (!id || !pi || !(dispute ? rowGivesBack(refund) : refund.status === "succeeded" && charge?.refunded === true)) continue;
    // Read before anything is marked (Codex Z on #2724; CX-123 rule 24): whether this row was handled, the payment's
    // gift and the gift itself, each in its exact shape. Unknown leaves the row unread and the read unsure, and the
    // next run asks again; nothing is marked read until it was handled.
    const looked = repliesFor(await redisPipeline([["SISMEMBER", seenKey(sid), id], ["GET", piKey(pi)]]), 2);
    const handled = countOf(looked?.[0]);
    const giftId = looked?.[1];
    if (!looked || handled === null || handled > 1 || (giftId !== null && typeof giftId !== "string")) {
      unsure = true;
      continue;
    }
    if (handled === 1) continue;
    if (typeof giftId === "string") {
      const kept = GIFT_ID.test(giftId) ? repliesFor(await redisPipeline([["GET", giftKey(giftId)]]), 1)?.[0] : null;
      if (kept !== null && typeof kept !== "string") {
        unsure = true;
        continue;
      }
      const gift = typeof kept === "string" ? parseKeptGift(kept, giftId) : null;
      if (gift && !gift.revoked && gift.s === sid) {
        const given = repliesFor(await redisPipeline([["HGET", importedKey(sid, gift.to), gift.p]]), 1)?.[0];
        if (given !== null && typeof given !== "string") {
          unsure = true;
          continue;
        }
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
          if (!v || typeof v !== "object" || Array.isArray(v)) {
            unsure = true;
            continue;
          }
          const listed = (v as { items?: unknown }).items;
          items = Array.isArray(listed) ? listed.filter((item): item is string => typeof item === "string") : [];
        }
        // The course first, then the purchase (Codex G on #2781; rule 30): a course removal that fails keeps the
        // purchase, so the next run takes both away again; taking a course away twice is harmless.
        try {
          for (const productId of [gift.p, ...items]) await dropStart(gift.to, productId);
        } catch (error) {
          console.error("taking a refunded gift's course away failed; tried again next run", error);
          unsure = true;
          continue;
        }
        // Each write confirmed in its exact shape before the next (Codex Z, review 5794703899; CX-123 rule 24): a
        // write left unknown marks nothing taken back or read and keeps the anchor, so the next run does it again.
        const removed = repliesFor(await redisPipeline([["HDEL", importedKey(sid, gift.to), gift.p]]), 1);
        if (!oneWrite(removed?.[0])) {
          unsure = true;
          continue;
        }
        if (!(await saveGift({ ...gift, revoked: now() }, GIFT_KEPT_SECONDS))) {
          unsure = true;
          continue;
        }
        revoked += 1;
      }
    }
    // Marked read once handled: a run that stops halfway leaves it to the next, which does the same again.
    if (!(await markRead(sid, id))) unsure = true;
  }
  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead), and the
  // anchor with it: the closing events are read from the anchor, so it waits while they are not all read.
  if (!(await confirmLostRead(lost, seenKey(sid)))) unsure = true;
  else if (lost.complete && lost.resumed) newest = Math.min(newest, Math.max(lost.newest, since));
  if (!unsure) await redisPipeline([["SET", anchorKey(sid), String(newest)]]);
  return revoked;
}
