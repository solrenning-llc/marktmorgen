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
import { UnknownReplyError } from "@/lib/redis-reply";
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
const now = () => Math.floor(Date.now() / 1000);

export function newGiftId(): string {
  return `gft_${randomBytes(12).toString("hex")}`;
}

export async function readGift(id: string): Promise<Gift | null> {
  if (!GIFT_ID.test(id) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", giftKey(id)]]);
  if (typeof raw !== "string") return null;
  try {
    const g = JSON.parse(raw) as Gift;
    return g && g.id === id ? g : null;
  } catch {
    return null;
  }
}

async function saveGift(gift: Gift, seconds: number): Promise<void> {
  await redisPipeline([["SET", giftKey(gift.id), JSON.stringify(gift), "EX", seconds]]);
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
    if ((await readGift(id))?.given) return "already";
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
  const [any, anchorRaw] = await redisPipeline([["GET", anyKey(sid)], ["GET", anchorKey(sid)]]);
  if (!any) return 0;
  const since = Math.max(0, (Number(anchorRaw) || now() - 7 * 86_400) - 300);
  let newest = Number(anchorRaw) || since;
  let revoked = 0;
  const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
  query.append("expand[]", "data.charge");
  const listed = await onAccount("GET", store.stripeAccountId, `/refunds?${query}`);
  const rows = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
  for (const refund of rows) {
    if (Date.now() >= deadline) return revoked;
    const id = typeof refund.id === "string" ? refund.id : "";
    const created = typeof refund.created === "number" ? refund.created : 0;
    const pi = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
    const charge = refund.charge as { refunded?: unknown } | null;
    newest = Math.max(newest, created);
    if (!id || !pi || refund.status !== "succeeded" || charge?.refunded !== true) continue;
    const [fresh, giftId] = await redisPipeline([["SADD", seenKey(sid), id], ["GET", piKey(pi)]]);
    if (Number(fresh) !== 1 || typeof giftId !== "string") continue;
    const gift = await readGift(giftId);
    if (!gift || gift.revoked || gift.s !== sid) continue;
    const [rawGiven] = await redisPipeline([["HGET", importedKey(sid, gift.to), gift.p]]);
    const items = (() => {
      try {
        const v = JSON.parse(String(rawGiven)) as { items?: unknown };
        return Array.isArray(v.items) ? (v.items as string[]) : [];
      } catch {
        return [];
      }
    })();
    await redisPipeline([["HDEL", importedKey(sid, gift.to), gift.p]]);
    for (const id of [gift.p, ...items]) await dropStart(gift.to, id);
    await saveGift({ ...gift, revoked: now() }, GIFT_KEPT_SECONDS);
    revoked += 1;
  }
  await redisPipeline([["SET", anchorKey(sid), String(newest)]]);
  return revoked;
}
