/**
 * Keeping each person's welcome offer (lib/welcome-offer.ts): when it began
 * for them, the checkout it opens while it lasts, and the one reminder.
 *
 * The start is the moment the person asked for the free product (the claim's
 * own time, lib/free.ts), written once per store and address with SET NX, so
 * nothing — a second free product, the page opened again, a mail scanner —
 * ever starts it again. It is kept 400 days after it ends, so somebody who
 * asks again a month later is told theirs ended, not offered a new one.
 *
 *   nl:wo:start:<statsId>:<hash>   when a person's offer began, in seconds
 *   nl:wo:due                      reminders to send: score = when, member = what, with the address;
 *                                  a person's is taken out when they are erased (forgetWelcomePerson)
 *   nl:wo:r:<statsId>:<hash>       that person's reminder is set, once; holds its time, so an erasure
 *                                  reads only that second of the queue ("1" in a mark written before)
 *   nl:wo:n:<statsId>              how many people have been offered it, for the studio
 */
import { type DigitalConsent, DigitalConsentMissing } from "@/lib/digital-consent";
import { OrdersPausedError } from "@/lib/order-admission";
import { createHash } from "node:crypto";
import { isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type Store, storeForId } from "@/lib/store";
import { type Listing, readListing, readProduct } from "@/lib/catalog";
import { canSellProduct, createCheckout } from "@/lib/store-checkout";
import { withStockHold } from "@/lib/stock";
import { fromLine, render } from "@/lib/mail";
import { tokensFor } from "@/lib/contacts";
import { type Claim, readClaimFull } from "@/lib/free";
import { SITE_URL } from "@/lib/site-url";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { endsAt, remindAt, welcomeOn } from "@/lib/welcome-offer";
import { welcomeWords } from "@/lib/buyer-words/welcome";

const KEEP_AFTER_SECONDS = 400 * 86_400;
const DUE_KEY = "nl:wo:due";
const hash = (email: string) => createHash("sha256").update(`welcome:${email.toLowerCase()}`).digest("hex").slice(0, 32);
const startKey = (statsId: string, email: string) => `nl:wo:start:${statsId}:${hash(email)}`;
const countKey = (statsId: string) => `nl:wo:n:${statsId}`;
const remindedKey = (statsId: string, email: string) => `nl:wo:r:${statsId}:${hash(email)}`;

/** A product the offer may be on: paid, sold here, one price, the buyer not naming it. */
export function canOfferWelcome(store: Store, product: Listing | null): product is Listing {
  return Boolean(product && product.priceCents > 0 && !product.options?.length && !product.pwyw && canSellProduct(store, product));
}

export type WelcomeHere = { product: Listing; percent: number; until: number; ended: boolean };

/**
 * The offer for the person a free copy's link was sent to: begun at the
 * moment they asked, once, and read back from then on. Null when the store
 * has none, or the free product is the one offered.
 */
export async function welcomeFor(store: Store, claim: Pick<Claim, "e" | "p" | "at">, nowSeconds = Math.floor(Date.now() / 1000)): Promise<WelcomeHere | null> {
  if (!welcomeOn(store) || !store.statsId || !isRedisConfigured() || claim.p === store.welcomeOffer.product) return null;
  const product = await readListing(store, store.welcomeOffer.product).catch(() => null);
  if (!canOfferWelcome(store, product ?? null)) return null;
  const asked = Math.floor(Date.parse(claim.at) / 1000);
  const start = Number.isFinite(asked) && asked > 0 && asked <= nowSeconds ? asked : nowSeconds;
  const key = startKey(store.statsId, claim.e);
  const ttl = endsAt(start, store.welcomeOffer.hours) - nowSeconds + KEEP_AFTER_SECONDS;
  const [made, kept] = await redisPipeline([
    ["SET", key, String(start), "NX", "EX", Math.max(60, ttl)],
    ["GET", key],
  ]);
  if (made !== null) await redisPipeline([["INCR", countKey(store.statsId)]]).catch(() => undefined);
  const began = Number(kept) || start;
  const until = endsAt(began, store.welcomeOffer.hours);
  return { product: product as Listing, percent: store.welcomeOffer.percent, until, ended: nowSeconds >= until };
}

/**
 * The one reminder, set when the person confirms their address by opening
 * their free copy: only if they agreed to hear from the creator, the
 * creator asked for it, and there is still time before it would go.
 */
export async function scheduleReminder(store: Store, claim: Claim, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!claim.c || !store.welcomeOffer.remind || !store.welcomeOffer.address || !store.statsId || !store.sid) return false;
  const offer = await welcomeFor(store, claim, nowSeconds);
  if (!offer || offer.ended) return false;
  const began = offer.until - store.welcomeOffer.hours * 3600;
  const when = remindAt(began, store.welcomeOffer.hours);
  if (when <= nowSeconds) return false;
  // One reminder per person and store, whatever else they ask for.
  const [first] = await redisPipeline([["SET", remindedKey(store.statsId, claim.e), String(when), "NX", "EX", Math.max(60, offer.until - nowSeconds + 86_400)]]);
  if (first === null) return false;
  const member = JSON.stringify({ s: store.sid, i: store.statsId, h: hash(claim.e), e: claim.e, t: token });
  await redisPipeline([["ZADD", DUE_KEY, String(when), member]]);
  return true;
}

/** "October 14, 2026, 3:00 PM UTC", in the store's language. */
function moment(seconds: number, language: unknown): string {
  return new Date(seconds * 1000).toLocaleString(LANGUAGES[parseLanguage(language)].locale, {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

/** The reminders now due, a few at a time, from the five-minute job. */
export async function sendWelcomeReminders(deadline: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ sent: number; dropped: number }> {
  const counts = { sent: 0, dropped: 0 };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;
  const [due] = await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, "0", String(nowSeconds), "LIMIT", "0", "25"]]);
  for (const member of Array.isArray(due) ? (due as unknown[]).map(String) : []) {
    if (Date.now() >= deadline) break;
    // Taken off first: a reminder is tried once, never twice.
    const [removed] = await redisPipeline([["ZREM", DUE_KEY, member]]);
    if (!Number(removed)) continue;
    try {
      const v = JSON.parse(member) as { s?: string; i?: string; h?: string; e?: string; t?: string };
      const store = v.s ? await storeForId(v.s) : null;
      if (!store || store.statsId !== v.i || !v.e || !v.t || !welcomeOn(store) || !store.listId || !store.welcomeOffer.remind || !store.welcomeOffer.address) {
        counts.dropped += 1;
        continue;
      }
      const claim = await readClaimFull(v.t);
      const offer = claim && claim.e === v.e ? await welcomeFor(store, claim, nowSeconds) : null;
      if (!offer || offer.ended) {
        counts.dropped += 1;
        continue;
      }
      // Still on the list, and still agreeing: the list's own token is what the unsubscribe link carries.
      const unsub = (await tokensFor(store.listId, [v.e], store.handle)).get(v.e);
      if (!unsub) {
        counts.dropped += 1;
        continue;
      }
      const w = welcomeWords(store.language);
      const hoursLeft = Math.max(1, Math.round((offer.until - nowSeconds) / 3600));
      const subject = w.remindSubject(offer.percent, offer.product.title, hoursLeft).slice(0, 200);
      const body = [
        w.remindIntro(store.name, offer.percent, offer.product.title, moment(offer.until, store.language)),
        "",
        w.remindLink,
        `${SITE_URL}/@${store.handle}/free?token=${v.t}`,
        "",
        w.remindAfter,
        "",
        `— ${store.name}`,
      ].join("\n");
      const withAddress = { ...store, mail: { fromName: store.mail?.fromName || store.name, address: store.welcomeOffer.address } };
      const rendered = render(withAddress, subject, body, unsub);
      const ok = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
        from: fromLine(withAddress),
        to: v.e,
        subject: rendered.subject,
        text: rendered.text,
        replyTo: store.email,
        headers: rendered.headers,
        idempotencyKey: `nimbus-wo:${store.statsId}:${v.h}`,
      });
      if (ok) counts.sent += 1;
      else counts.dropped += 1;
    } catch (error) {
      console.error("sending a welcome offer reminder failed", error);
      counts.dropped += 1;
    }
  }
  return counts;
}

/** How many people have been offered it, for the studio. */
export async function welcomesOffered(store: Store): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["GET", countKey(store.statsId)]]);
  return Number(n) || 0;
}

export type OpenResult = { ok: true; url: string } | { ok: false; reason: "expired" | "unavailable" | "refused" | "consent" };

/**
 * The checkout the offer's button opens: the offered product, the address
 * the free copy went to, the discount applied by Stripe, only while the
 * person's own time lasts.
 */
export async function openWelcome(
  store: Store,
  token: string,
  origin: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  /** The box to start access at once, checked on the button's page (lib/digital-consent.ts). */
  consent: DigitalConsent | null = null,
): Promise<OpenResult> {
  const claim = await readClaimFull(token);
  if (!claim || claim.h !== store.handle) return { ok: false, reason: "expired" };
  const offer = await welcomeFor(store, claim, nowSeconds);
  if (!offer) return { ok: false, reason: "unavailable" };
  if (offer.ended) return { ok: false, reason: "expired" };
  const product = await readProduct(store, offer.product.id);
  if (!product || !canOfferWelcome(store, offer.product)) return { ok: false, reason: "unavailable" };
  try {
    const held = await withStockHold(store, product, (holding) =>
      createCheckout(store, product, origin, undefined, { coupon: store.welcomeOffer.coupon, email: claim.e, welcome: true, held: holding, digitalConsent: consent }),
    );
    if (!held.ok) return { ok: false, reason: "unavailable" };
    return { ok: true, url: held.value.url };
  } catch (error) {
    // A coupon the creator deleted in their own dashboard, most likely.
    // The store's orders for the month are reached (lib/order-admission.ts): not open right now, nothing charged.
    if (error instanceof OrdersPausedError) return { ok: false, reason: "unavailable" };
    // The box to start access at once was not checked: said beside it, nothing opened.
    if (error instanceof DigitalConsentMissing) return { ok: false, reason: "consent" };
    console.error("opening a welcome offer checkout failed", store.handle, error);
    return { ok: false, reason: "refused" };
  }
}

/** The most rounds a scan of the reminder queue may take before the erasure says this part did not finish. */
const DUE_SCAN_ROUNDS = 10_000;
/** The reminders of one second read at a time, and the most pages of that second before the erasure says this part did not finish. */
const DUE_SECOND_PAGE = 100;
const DUE_SECOND_ROUNDS = 50;
/** What a reminder mark holds: its time in seconds; "1" in a mark written before it held the time. */
const MARK_TIME = /^[1-9]\d{0,11}$/;
const LEGACY_MARK = "1";

/**
 * Whether a queue member is this person's reminder in this store. A member
 * that holds their address hash but does not read as a reminder may still hold
 * their address: it throws (review L1 on #2998, rule 24), never "not theirs".
 */
function namesPerson(member: string, statsId: string, h: string): boolean {
  if (!member.includes(h)) return false;
  let v: unknown;
  try {
    v = JSON.parse(member);
  } catch {
    v = null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof (v as { i?: unknown }).i !== "string" || typeof (v as { h?: unknown }).h !== "string") {
    throw new UnknownReplyError("a welcome reminder waiting for its hour that names the person");
  }
  const { i, h: own } = v as { i: string; h: string };
  return i === statsId && own === h;
}

/**
 * The reminders waiting for their hour that name one person in one store,
 * read from the queue with ZSCAN: only for a mark written before it held the
 * reminder's time, which ends within a day after its offer. Every reply is
 * read in its exact shape; any other shape, or a scan that does not end, throws.
 */
async function dueFor(statsId: string, email: string): Promise<string[]> {
  const h = hash(email);
  const found: string[] = [];
  let cursor = "0";
  for (let round = 0; round < DUE_SCAN_ROUNDS; round += 1) {
    const pair = repliesFor(repliesFor(await redisPipeline([["ZSCAN", DUE_KEY, cursor, "MATCH", `*${h}*`, "COUNT", 1000]]), 1)?.[0], 2);
    const flat = pair ? stringList(pair[1]) : null;
    if (!pair || typeof pair[0] !== "string" || !/^\d+$/.test(pair[0]) || !flat || flat.length % 2 !== 0) {
      throw new UnknownReplyError("the scan of the welcome reminders waiting for their hour");
    }
    for (let i = 0; i < flat.length; i += 2) {
      if (namesPerson(flat[i], statsId, h) && !found.includes(flat[i])) found.push(flat[i]);
    }
    cursor = pair[0];
    if (cursor === "0") return found;
  }
  throw new UnknownReplyError("the scan of the welcome reminders waiting for their hour, which did not end");
}

/**
 * The reminders of one second that name one person in one store (review L2 on
 * #2998): the mark holds that second, so the erasure never walks the queue of
 * every store. Read a page at a time within a fixed number of rounds; any
 * other shape, or a second that does not end within them, throws.
 */
async function dueAtSecond(statsId: string, email: string, when: string): Promise<string[]> {
  const h = hash(email);
  const found: string[] = [];
  for (let round = 0; round < DUE_SECOND_ROUNDS; round += 1) {
    const page = stringList(
      repliesFor(await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, when, when, "LIMIT", String(round * DUE_SECOND_PAGE), String(DUE_SECOND_PAGE)]]), 1)?.[0],
    );
    if (page === null || page.length > DUE_SECOND_PAGE) throw new UnknownReplyError("the welcome reminders of one second");
    for (const member of page) if (namesPerson(member, statsId, h) && !found.includes(member)) found.push(member);
    if (page.length < DUE_SECOND_PAGE) return found;
  }
  throw new UnknownReplyError("the welcome reminders of one second, which did not end");
}

/**
 * Forgets when one person's welcome offer began, that their reminder was set,
 * and the reminder itself if it still waits for its hour, which holds their
 * address (lib/person-erasure.ts).
 */
export async function forgetWelcomePerson(statsId: string | null, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  // The mark is read before it goes, in the same round trip: it says which second of the queue holds the reminder.
  const replies = repliesFor(await redisPipeline([["GET", remindedKey(statsId, email)], ["DEL", startKey(statsId, email), remindedKey(statsId, email)]]), 2);
  const gone = replies ? countOf(replies[1]) : null;
  // Never 0 removed on a reply of another shape (CX-123 rule 24): thrown, so the erasure says this part did not finish (lib/person-erasure.ts).
  if (!replies || gone === null || gone > 2) throw new UnknownReplyError("the deletion of a person's welcome offer start and reminder mark");
  const mark = replies[0];
  // No mark: no reminder was set for this person here (the mark outlives its reminder by a day).
  if (mark === null) return gone;
  if (typeof mark !== "string" || !MARK_TIME.test(mark)) throw new UnknownReplyError("a person's welcome reminder mark");
  const waiting = mark === LEGACY_MARK ? await dueFor(statsId, email) : await dueAtSecond(statsId, email, mark);
  if (!waiting.length) return gone;
  const taken = countOf(repliesFor(await redisPipeline([["ZREM", DUE_KEY, ...waiting]]), 1)?.[0]);
  if (taken === null || taken > waiting.length) throw new UnknownReplyError("the removal of a person's welcome reminder from the queue");
  return gone + taken;
}
