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
import { LOW_STOCK_DUE, noteUnitsLeft, lowStockOf, setLowStock, wouldCrossLow } from "@/lib/low-stock";
import { alertCreator } from "@/lib/phone-alerts";
import { SITE_URL } from "@/lib/site-url";
import { weeklyOff, weeklyToken } from "@/lib/stats-report";
import type { Listing, Store } from "@/lib/store";
import { type ExactStore } from "@/lib/store-exact";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";

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

/** Products the job checks a run, at most. */
export const LOW_STOCK_RUN_PRODUCTS = 50;
/**
 * How long a product waits before its next check when nothing sold: a sale
 * makes it due at once (lowStockTouched, from the cart's hold), so this is
 * only the safety recheck, a day (Revisor 1 on #3814: a fixed pace over the
 * whole platform would grow with it).
 */
export const LOW_STOCK_WAIT_MS = 86_400_000;

export type LowStockDeps = {
  /** The store by its own id, read exactly (lib/store-exact.ts). */
  load: (storeId: string) => Promise<ExactStore>;
  readProduct: (store: Store, id: string) => Promise<Listing | null>;
  /** Units left (lib/stock.ts); throws when they cannot be read. */
  left: (store: Store, product: Listing) => Promise<number | null>;
};

/** One product's turn: "told" when the creator was told, "done" when it leaves the set, "later" otherwise. */
async function checkOne(entry: string, now: number, deps: LowStockDeps): Promise<"told" | "done" | "later"> {
  const cut = entry.indexOf("|");
  const storeId = cut > 0 ? entry.slice(0, cut) : "";
  const productId = cut > 0 ? entry.slice(cut + 1) : "";
  if (!storeId || !/^[a-z0-9]{1,40}$/.test(productId)) return "done";
  const found = await deps.load(storeId);
  // The store is gone: its numbers went with it (lib/data-families.ts).
  if (found === "none") return "done";
  if (found === "unknown") return "later";
  const store = found;
  if (!store.statsId || store.suspended) return "later";
  const product = await deps.readProduct(store, productId);
  if (!product) {
    // Still listed but unreadable: it waits. Gone exactly: its number goes too.
    if (store.catalog.items.some((item) => item.id === productId)) return "later";
    return (await setLowStock(store, productId, 0, null, now)) === "off" ? "done" : "later";
  }
  const told = await tellLowStock(store, product, await deps.left(store, product), now);
  return told === "told" ? "told" : "later";
}

/**
 * Checks the products with a low-stock number, until `deadline`: at most
 * LOW_STOCK_RUN_PRODUCTS a run, each again after LOW_STOCK_WAIT_MS. Run by
 * the mail job only (never in the checkout), one run at a time, so a count
 * read late never rearms a crossing. Returns how many creators were told.
 */
export async function runLowStockChecks(deadline: number, deps: LowStockDeps): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const reply = repliesFor(await redisPipeline([["ZRANGEBYSCORE", LOW_STOCK_DUE, "-inf", Date.now(), "LIMIT", 0, LOW_STOCK_RUN_PRODUCTS]]), 1);
  const entries = reply ? stringList(reply[0]) : null;
  if (!entries) {
    console.error("checking low-stock numbers: the products due were read in an unknown shape, so they wait", new UnknownReplyError("the low-stock products due"));
    return 0;
  }
  let told = 0;
  for (const entry of entries) {
    if (Date.now() > deadline) break;
    let turn: "told" | "done" | "later";
    try {
      turn = await checkOne(entry, Date.now(), deps);
    } catch (error) {
      console.error("checking low-stock numbers: a product could not be read as asked, so it waits", error);
      turn = "later";
    }
    if (turn === "told") told += 1;
    if (turn === "done") await redisPipeline([["ZREM", LOW_STOCK_DUE, entry]]);
    else await redisPipeline([["ZADD", LOW_STOCK_DUE, "XX", Date.now() + LOW_STOCK_WAIT_MS, entry]]);
  }
  return told;
}
