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
 *                                  a person's is taken out when they are erased (forgetWelcomePerson);
 *                                  one put back after a failed send keeps its score and counts its tries ("a")
 *   nl:wo:r:<statsId>:<hash>       that person's reminder is set, once: "due:<hour>:<claim>", the hour
 *                                  its score in nl:wo:due, so an erasure finds it without walking the queue
 *   nl:wo:n:<statsId>              how many people have been offered it, for the studio
 */
import { type DigitalConsent, DigitalConsentMissing } from "@/lib/digital-consent";
import { claimMark, claimValue } from "@/lib/claim-mark";
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
import { REMINDER_RETRIES, retriesOf } from "@/lib/reminder-retry";
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
 * has none, or the free product is the one offered. Throws UnknownReplyError
 * when the start answers in no known shape (rule 24): never a live offer.
 */
export async function welcomeFor(store: Store, claim: Pick<Claim, "e" | "p" | "at">, nowSeconds = Math.floor(Date.now() / 1000)): Promise<WelcomeHere | null> {
  if (!welcomeOn(store) || !store.statsId || !isRedisConfigured() || claim.p === store.welcomeOffer.product) return null;
  const product = await readListing(store, store.welcomeOffer.product).catch(() => null);
  if (!canOfferWelcome(store, product ?? null)) return null;
  const asked = Math.floor(Date.parse(claim.at) / 1000);
  const start = Number.isFinite(asked) && asked > 0 && asked <= nowSeconds ? asked : nowSeconds;
  const key = startKey(store.statsId, claim.e);
  const ttl = endsAt(start, store.welcomeOffer.hours) - nowSeconds + KEEP_AFTER_SECONDS;
  const replies = repliesFor(
    await redisPipeline([
      ["SET", key, String(start), "NX", "EX", Math.max(60, ttl)],
      ["GET", key],
    ]),
    2,
  );
  const made = replies ? replies[0] : undefined;
  const kept = replies ? replies[1] : undefined;
  // Counted only on an exact "OK" (CX-123 rule 24): nil is a person whose offer already began; any other answer is
  // unknown, so nobody is counted on it, and it is said.
  if (made === "OK") await redisPipeline([["INCR", countKey(store.statsId)]]).catch(() => undefined);
  else if (made !== null) console.error("starting a welcome offer answered in no known shape; not counted");
  // The start decides whether the offer ended (rule 24): known only on "OK" or nil and a start read back as a string
  // of digits. Anything else is unknown, never "it began now": no offer is shown on it, no checkout, no reminder.
  if (!replies || (made !== "OK" && made !== null) || typeof kept !== "string" || !/^[1-9][0-9]*$/.test(kept)) {
    throw new UnknownReplyError("the start of a person's welcome offer");
  }
  const began = Number(kept);
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
  // Ours only on OK or our own value read back (CX-123 rule 24, L9): anything else schedules nothing.
  // The mark keeps the reminder's hour, its score in the queue: forgetWelcomePerson reads the queue at that second only.
  if ((await claimMark(remindedKey(store.statsId, claim.e), Math.max(60, offer.until - nowSeconds + 86_400), `due:${when}:${claimValue()}`)) !== "ours") return false;
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

type DueReminder = { s?: string; i?: string; h?: string; e?: string; t?: string; a?: unknown };

/**
 * Puts a reminder that failed before its email was asked for back in the queue (lib/reminder-retry.ts),
 * a few times at the most, at the score it had: the hour its person's mark
 * keeps, so an erasure still finds it there (forgetWelcomePerson, dueAt), and
 * the next run tries it again. Every rule is read again before that try (the
 * offer still on, the person still on the list), and the email keeps its
 * name (nimbus-wo:), so it is never a second one. Whether it went back.
 */
async function again(v: DueReminder, score: string): Promise<boolean> {
  const tries = retriesOf(v.a);
  if (tries >= REMINDER_RETRIES) return false;
  // Whose it is: without the store's and the person's ids there is no mark to keep it by, so it is not put back.
  if (typeof v.i !== "string" || !v.i || typeof v.e !== "string" || !v.e) return false;
  const member = JSON.stringify({ ...v, a: tries + 1 });
  try {
    // Put back, then whether the person's mark is still there, in that order. An erasure deletes the mark before it
    // looks for the reminder at its hour (forgetWelcomePerson), and the reminder is off the queue while its send is in
    // flight. So the mark gone means the person was erased meanwhile, and the reminder, which holds their address,
    // is taken out again; the mark still there means an erasure after this finds it at its hour (Claude 3 on #3214).
    const replies = repliesFor(await redisPipeline([["ZADD", DUE_KEY, score, member], ["EXISTS", remindedKey(v.i, v.e)]]), 2);
    const added = replies?.[0];
    const kept = replies ? countOf(replies[1]) : null;
    // 1 put back; 0 one just like it already waits. Anything else is unknown: not counted as put back.
    if ((added === 1 || added === 0) && kept === 1) return true;
    if (kept !== 0) console.error("putting a welcome offer reminder back answered in no known shape");
  } catch (error) {
    console.error("putting a welcome offer reminder back failed", error);
  }
  // Not kept: the person was erased, or whether it went back (or whether they were) is unknown. Never left waiting
  // with their address on a guess: taken out, and said when even that does not answer.
  try {
    const taken = countOf(repliesFor(await redisPipeline([["ZREM", DUE_KEY, member]]), 1)?.[0]);
    if (taken === null || taken > 1) console.error("taking a welcome offer reminder back out answered in no known shape");
  } catch (error) {
    console.error("taking a welcome offer reminder back out failed", error);
  }
  return false;
}

/** The reminders now due, a few at a time, from the five-minute job. */
export async function sendWelcomeReminders(deadline: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ sent: number; dropped: number; retried: number }> {
  const counts = { sent: 0, dropped: 0, retried: 0 };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;
  // With each one's score, the hour it is put back at after a failed send. Read only in its exact shape
  // (CX-123 rule 24): members and scores (seconds) in pairs, or nothing; anything else is unknown and sends nothing.
  const due = stringList(repliesFor(await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, "0", String(nowSeconds), "WITHSCORES", "LIMIT", "0", "25"]]), 1)?.[0]);
  if (!due || due.length % 2 !== 0 || due.length > 50) throw new UnknownReplyError("the read of the welcome reminders now due");
  for (let at = 0; at < due.length; at += 2) {
    if (!/^\d{1,12}(\.\d{1,17})?$/.test(due[at + 1])) throw new UnknownReplyError("the hour of a welcome reminder now due");
  }
  for (let at = 0; at < due.length; at += 2) {
    const member = due[at];
    const score = due[at + 1];
    if (Date.now() >= deadline) break;
    // Taken off first, so two runs never send the same one; put back only after a try that failed before its email
    // was asked for (again).
    const [removed] = await redisPipeline([["ZREM", DUE_KEY, member]]);
    if (!Number(removed)) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(member);
    } catch {
      // A member of no known shape is dropped below.
    }
    const v: DueReminder = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as DueReminder) : {};
    let failed = false;
    // Whether the email service was asked: once it was, never again (lib/reminder-retry.ts). Its answer cannot tell a
    // refusal from a failure that may pass, and each ask takes the store's email room again (Claude 2 on #3214).
    let asked = false;
    try {
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
      asked = true;
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
      else failed = true;
    } catch (error) {
      console.error("sending a welcome offer reminder failed", error);
      failed = true;
    }
    if (!failed) continue;
    if (!asked && (await again(v, score))) counts.retried += 1;
    else counts.dropped += 1;
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
  let offer: WelcomeHere | null;
  try {
    offer = await welcomeFor(store, claim, nowSeconds);
  } catch (error) {
    // An unknown start (rule 24) or a failed read: nothing opened, said as unavailable.
    console.error("reading a welcome offer for its checkout failed", store.handle, error);
    return { ok: false, reason: "unavailable" };
  }
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

/** The most rounds a read of the reminder queue may take before the erasure says this part did not finish. */
const DUE_SCAN_ROUNDS = 10_000;
/** Members read from the queue at a time. */
const DUE_PAGE = 1000;

/**
 * Whether a queue member is the reminder of one person (hash `h`) in one
 * store. A member that names the hash but is not a reminder this module
 * wrote is unknown, never "not theirs" (CX-123 rule 24): it throws, so the
 * erasure says this part did not finish.
 */
function names(member: string, statsId: string, h: string): boolean {
  let v: unknown = null;
  try {
    v = JSON.parse(member);
  } catch {
    v = null;
  }
  const r = v && typeof v === "object" && !Array.isArray(v) ? (v as { i?: unknown; h?: unknown }) : null;
  if (!r || typeof r.i !== "string" || typeof r.h !== "string") {
    if (member.includes(h)) throw new UnknownReplyError("a welcome reminder waiting for its hour that names the person");
    return false;
  }
  return r.i === statsId && r.h === h;
}

/**
 * The reminders of one person in one store waiting at one second, the hour
 * their mark keeps: a page of the queue at that score at a time, never the
 * queue of every store. Every reply is read in its exact shape.
 */
async function dueAt(statsId: string, h: string, when: string): Promise<string[]> {
  const found: string[] = [];
  for (let round = 0; round < DUE_SCAN_ROUNDS; round += 1) {
    const page = stringList(repliesFor(await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, when, when, "LIMIT", round * DUE_PAGE, DUE_PAGE]]), 1)?.[0]);
    if (!page || page.length > DUE_PAGE) throw new UnknownReplyError("the read of the welcome reminders waiting at one hour");
    for (const member of page) if (names(member, statsId, h) && !found.includes(member)) found.push(member);
    if (page.length < DUE_PAGE) return found;
  }
  throw new UnknownReplyError("the read of the welcome reminders waiting at one hour, which did not end");
}

/**
 * The reminders waiting for their hour that name one person in one store,
 * read from the whole queue with ZSCAN: only for a mark written before marks
 * kept the hour ("1", or a bare claim value), which lasts a day past its offer's end. Every reply is
 * read in its exact shape; any other shape, or a scan that does not end, throws.
 */
async function dueScan(statsId: string, h: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  for (let round = 0; round < DUE_SCAN_ROUNDS; round += 1) {
    const pair = repliesFor(repliesFor(await redisPipeline([["ZSCAN", DUE_KEY, cursor, "MATCH", `*${h}*`, "COUNT", DUE_PAGE]]), 1)?.[0], 2);
    const flat = pair ? stringList(pair[1]) : null;
    if (!pair || typeof pair[0] !== "string" || !/^\d+$/.test(pair[0]) || !flat || flat.length % 2 !== 0) {
      throw new UnknownReplyError("the scan of the welcome reminders waiting for their hour");
    }
    for (let i = 0; i < flat.length; i += 2) if (names(flat[i], statsId, h) && !found.includes(flat[i])) found.push(flat[i]);
    cursor = pair[0];
    if (cursor === "0") return found;
  }
  throw new UnknownReplyError("the scan of the welcome reminders waiting for their hour, which did not end");
}

/**
 * Forgets when one person's welcome offer began, that their reminder was set,
 * and the reminder itself if it still waits for its hour, which holds their
 * address (lib/person-erasure.ts).
 */
export async function forgetWelcomePerson(statsId: string | null, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  // Read before the marks go: "due:<hour>:<claim>", or a mark from before marks kept the hour ("1", or a bare claim
  // value), or nothing when no reminder was set. Any other shape is unknown, never "none" (CX-123 rule 24).
  const mark = repliesFor(await redisPipeline([["GET", remindedKey(statsId, email)]]), 1)?.[0];
  const hour = typeof mark === "string" ? (/^due:(\d{1,12}):\d+\.\d{9}$/.exec(mark)?.[1] ?? null) : null;
  const older = typeof mark === "string" && (mark === "1" || /^\d+\.\d{9}$/.test(mark));
  if (mark !== null && !hour && !older) throw new UnknownReplyError("the read of a person's welcome reminder mark");
  const gone = countOf(repliesFor(await redisPipeline([["DEL", startKey(statsId, email), remindedKey(statsId, email)]]), 1)?.[0]);
  // Never 0 removed on a reply of another shape (CX-123 rule 24): thrown, so the erasure says this part did not finish (lib/person-erasure.ts).
  if (gone === null || gone > 2) throw new UnknownReplyError("the deletion of a person's welcome offer start and reminder mark");
  const h = hash(email);
  const waiting = hour ? await dueAt(statsId, h, hour) : older ? await dueScan(statsId, h) : [];
  if (!waiting.length) return gone;
  const taken = countOf(repliesFor(await redisPipeline([["ZREM", DUE_KEY, ...waiting]]), 1)?.[0]);
  if (taken === null || taken > waiting.length) throw new UnknownReplyError("the removal of a person's welcome reminder from the queue");
  return gone + taken;
}
