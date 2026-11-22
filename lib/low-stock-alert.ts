/**
 * The creator told that a limited product is running low (623 [SZ7], unit 5a,
 * 11 November 2026), on the crossing lib/low-stock.ts keeps (noteUnitsLeft).
 *
 * When the units fall from above the creator's low-stock number to it or
 * under it, the creator gets one phone alert (lib/phone-alerts.ts, event
 * "alert", as the store's other alerts) and one email, so they can restock
 * before the product sells out. No buyer is named, nothing is shown to a
 * buyer, and there is no urgency: the email says the units left, the number
 * they chose and where to restock.
 *
 * Bounded: at most LOW_STOCK_EMAILS_A_DAY a day per product, whatever the
 * restocks and sales in between, claimed exactly (lib/claim-mark.ts) before
 * anything is sent, and at most LOW_STOCK_ALERTS_A_STORE_DAY a day for the
 * whole store, counted before anything is sent. The email is taken from the
 * store's own emails (meter "store", kind "email") before it goes, and
 * stops with the numbers emails (lib/stats-report.ts, weeklyOff). A count, a record or a claim that
 * cannot be read sends nothing (rule 24); a crossing whose day's claim could
 * not be read is not said, never said twice.
 *
 *   nl:alert:<statsId>:low:<product>:<day>   told about this product today
 *
 * Nothing calls this yet: unit 5b calls it where the units change.
 */
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { noteUnitsLeft, lowStockOf, unitsSeenRestore, wouldCrossLow, type LowStock } from "@/lib/low-stock";
import { alertCreator } from "@/lib/phone-alerts";
import { SITE_URL } from "@/lib/site-url";
import { weeklyOffState, weeklyToken } from "@/lib/stats-report";
import type { Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";

/** The most low-stock emails one product sends its creator in a day (UTC). */
export const LOW_STOCK_EMAILS_A_DAY = 1;
/**
 * The most low-stock alerts (phone and email) a whole store gets in a day,
 * however many products cross (Claude 1 and Claude 3 on #3725): a fixed
 * bound, not one that grows with the catalog.
 */
export const LOW_STOCK_ALERTS_A_STORE_DAY = 3;
/** How long a day's claim is kept: past the day it names. */
const TOLD_SECONDS = 2 * 86_400;

const toldKey = (statsId: string, productId: string, day: string) => `nl:alert:${statsId}:low:${productId}:${day}`;
const storeDayKey = (statsId: string, day: string) => `nl:alert:${statsId}:lowday:${day}`;

export type LowStockTold = "told" | "no" | "off" | "unknown";

/**
 * The units left of a product now (`left`, as lib/stock.ts reads them):
 * "told" when this fall crossed the creator's number and the day's claim was
 * ours (the phone alert and, unless the numbers emails are stopped, the
 * email go then), "no" otherwise, "off" when no number is set, "unknown"
 * when anything could not be read, and then nothing is sent.
 */
export async function tellLowStock(store: Store, product: { id: string; title: string }, left: unknown, now = Date.now()): Promise<LowStockTold> {
  if (!store.statsId) return "unknown";
  // Read first, written only once it can be said: past the store's daily bound, or with its count unknown,
  // nothing of the crossing is spent, so the next check (the job's, a day later at most) says it (Claude 3 and Revisor 1 on #3725).
  const peek = await wouldCrossLow(store, product.id, left);
  if (peek === "off" || peek === "unknown") return peek;
  if (peek === "no") {
    const noted = await noteUnitsLeft(store, product.id, left);
    return noted === "unknown" || noted === "off" ? noted : "no";
  }
  const day = new Date(now).toISOString().slice(0, 10);
  // The store's own daily bound, counted before anything is spent or sent; a count that cannot be read spends and sends nothing.
  let count: number | null = null;
  try {
    const replies = repliesFor(await redisPipeline([["INCR", storeDayKey(store.statsId, day)], ["EXPIRE", storeDayKey(store.statsId, day), TOLD_SECONDS]]), 2);
    count = replies && (replies[1] === 0 || replies[1] === 1) ? countOf(replies[0]) : null;
  } catch {
    count = null;
  }
  if (count === null || count < 1) return "unknown";
  if (count > LOW_STOCK_ALERTS_A_STORE_DAY) return "no";
  // A crossing that cannot send (a record gone or changed under it, a day's claim taken or unknown) gives its place
  // back, so crossings of a product already told today never use up the places of the store's other products (Codex
  // X6 on #3725). A give-back that fails leaves one place too few, never one too many.
  const placeBack = async <T>(answer: T): Promise<T> => {
    if (store.statsId) await redisPipeline([["DECR", storeDayKey(store.statsId, day)]]).catch(() => {});
    return answer;
  };
  // The record as it was, to put back if nothing reaches the creator.
  let before: LowStock | null = null;
  try {
    before = await lowStockOf(store, product.id);
  } catch {
    return placeBack("unknown" as const);
  }
  if (!before) return placeBack("off" as const);
  const low = before.low;
  const crossed = await noteUnitsLeft(store, product.id, left);
  if (crossed !== "crossed") return placeBack(crossed);
  const key = toldKey(store.statsId, product.id, day);
  const value = claimValue(now);
  const claimed = await claimMark(key, TOLD_SECONDS, value);
  // A claim not ours, or unknown, sends nothing: its place goes back; the crossing stays spent, never said twice.
  if (claimed === "unknown") return placeBack("unknown" as const);
  if (claimed !== "ours") return placeBack("no" as const);

  const units = left as number;
  const title = `${product.title.slice(0, 140)}: ${units} left`;
  const studio = `/studio${store.sid ? `?store=${store.sid}` : ""}#products`;
  const pushed = await alertCreator(store, "alert", { title, body: "Restock it before it sells out.", url: studio }, { seed: `${key}:${value}`, at: now, wait: true }).catch((error) => {
    console.error("a low-stock notification failed", error);
    return 0;
  });
  // Emails the creator stopped are their own choice: then the crossing is said by the phone alone, or not at all. Whether
  // they are stopped is read exactly (rule 24): an answer that is not known, or a read that fails, is not their choice,
  // so with no phone told nothing is spent and the next check says it (Claude 5 on #3725, MEDIUM 1).
  let stopped: boolean | null = false;
  if (isSenderConfigured()) {
    stopped = await weeklyOffState(store.handle).catch((error: unknown) => {
      console.error("low-stock: whether the creator stopped the emails could not be read", error);
      return null;
    });
  }
  if (stopped === null && pushed < 1) {
    // No email was tried, so the store's place for the day goes back too.
    await giveBack(store, product.id, left as number, before, key, value, day, true);
    return "unknown";
  }
  let emailTried = false;
  let emailed = false;
  if (isSenderConfigured() && stopped === false) {
    emailTried = true;
    const stopUrl = `${SITE_URL}/api/store/weekly?h=${encodeURIComponent(store.handle)}&t=${encodeURIComponent(weeklyToken(store.handle))}`;
    emailed = await sendEmail({
      // The store's own emails, taken before it goes (Claude 1 and Claude 3 on #3725): one that does not fit is not sent.
      meter: { by: "store", store, kind: "email" },
      from: NIMBUS_FROM,
      to: store.email,
      subject: title,
      text: [
        `${product.title} has ${units} ${units === 1 ? "unit" : "units"} left, at or under ${low === null ? "your low-stock number" : `your low-stock number (${low})`}.`,
        "",
        `Add units to it in your studio: ${SITE_URL}${studio}`,
        "",
        `This email comes at most once a day for each product. To stop these emails and the weekly one: ${stopUrl}`,
      ].join("\n"),
      headers: { "List-Unsubscribe": `<${stopUrl}>` },
    }).catch(() => false);
  }
  // Nothing reached the creator (the store's emails used up, or the send failed, and no phone told): the crossing is not
  // spent, so the next check says it (Revisor 1 and Claude 3 on #3725). The day's mark and the count seen go back; the
  // store's place for the day does not, since a send was tried: a send that keeps failing is tried at most
  // LOW_STOCK_ALERTS_A_STORE_DAY times a day for the store, each one a call to the provider (Claude 5 on #3725, MEDIUM 2).
  if (pushed < 1 && emailTried && !emailed) {
    await giveBack(store, product.id, left as number, before, key, value, day, false);
    return "unknown";
  }
  // Nobody was told (no phone answered, and the creator stopped the emails or sending is off): the crossing stays
  // spent, the creator's own choice, but it is never said as told (cloud J's LOW on #3725).
  if (pushed < 1 && !emailed) return "no";
  return "told";
}

/**
 * Puts back, in one step, what a crossing that reached nobody took: the day's mark (only while it is still this
 * crossing's) and the count seen (only while the record still holds what this crossing wrote), both or neither
 * (Codex X6 on #3725: two separate steps could release the mark and keep the crossing spent, so it was never said);
 * and, when asked, the store's place. A step that fails leaves everything spent, never half: the crossing waits
 * for the next day's mark.
 */
async function giveBack(
  store: Store,
  productId: string,
  left: number,
  before: LowStock,
  key: string,
  value: string,
  day: string,
  place: boolean,
): Promise<void> {
  const seen = unitsSeenRestore(store, productId, left, before);
  if (!seen || !store.statsId) return;
  await redisPipeline([[
    "EVAL", LOW_STOCK_GIVE_BACK, 3, key, seen.key, storeDayKey(store.statsId, day),
    value, seen.field, seen.wroteSha, seen.before, place ? "1" : "0",
  ]]).catch((error) => console.error("a low-stock crossing could not be given back; it stays spent", error));
}

/**
 * The give-back of a crossing that reached nobody, in one step (Codex X6 on #3725): KEYS[1] the day's mark, KEYS[2]
 * the low-stock record, KEYS[3] the store's day count; ARGV[1] the mark's value, ARGV[2] the product, ARGV[3] the
 * SHA-1 of what the crossing wrote, ARGV[4] the record as it was, ARGV[5] "1" to give the store's place back.
 * Nothing is changed unless the mark and the record still hold what this crossing left. 1 when given back, 0 when
 * not. lib/redis-memory.ts runs the same.
 */
const LOW_STOCK_GIVE_BACK = [
  "-- marktmorgen:low-stock-give-back:v1",
  'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end',
  'local cur = redis.call("HGET", KEYS[2], ARGV[2])',
  "if not cur or redis.sha1hex(cur) ~= ARGV[3] then return 0 end",
  'redis.call("HSET", KEYS[2], ARGV[2], ARGV[4])',
  'redis.call("DEL", KEYS[1])',
  'if ARGV[5] == "1" then redis.call("DECR", KEYS[3]) end',
  "return 1",
].join("\n");
