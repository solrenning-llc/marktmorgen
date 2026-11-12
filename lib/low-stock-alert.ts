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
import { claimMark } from "@/lib/claim-mark";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { noteUnitsLeft, lowStockOf, wouldCrossLow } from "@/lib/low-stock";
import { alertCreator } from "@/lib/phone-alerts";
import { SITE_URL } from "@/lib/site-url";
import { weeklyOff, weeklyToken } from "@/lib/stats-report";
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
  const crossed = await noteUnitsLeft(store, product.id, left);
  if (crossed !== "crossed") return crossed;
  const key = toldKey(store.statsId, product.id, day);
  const claimed = await claimMark(key, TOLD_SECONDS);
  if (claimed === "unknown") return "unknown";
  if (claimed !== "ours") return "no";

  let low: number | null = null;
  try {
    low = (await lowStockOf(store, product.id))?.low ?? null;
  } catch {
    low = null;
  }
  const units = left as number;
  const title = `${product.title.slice(0, 140)}: ${units} left`;
  const studio = `/studio${store.sid ? `?store=${store.sid}` : ""}#products`;
  await alertCreator(store, "alert", { title, body: "Restock it before it sells out.", url: studio }, { seed: key, at: now }).catch((error) =>
    console.error("a low-stock notification failed", error),
  );
  if (isSenderConfigured() && !(await weeklyOff(store.handle))) {
    const stopUrl = `${SITE_URL}/api/store/weekly?h=${encodeURIComponent(store.handle)}&t=${encodeURIComponent(weeklyToken(store.handle))}`;
    await sendEmail({
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
  return "told";
}
