/**
 * "Email me when it's back" (623 [SZ7], unit 3, 10 November 2026): its two
 * emails, and the job that sends the one email when a sold-out product is
 * back in stock. The list itself is kept in lib/stock-alerts.ts.
 *
 * Asking (askBackInStock). Only a store that can send these emails takes an
 * address: not switched off, with its own ids and its postal address set
 * (the creator's email settings, store.mail, which US law asks every email
 * offering something for sale to carry). The confirmation is taken from the
 * store's access emails before it goes, as a visitor-typed address
 * (lib/email.ts, EmailMeter "asked"): a figure that is spent or cannot be
 * read sends nothing and says so; a new place whose email did not go is
 * taken back at once, and an address that never confirmed is never emailed.
 *
 * Sending (runRestocks, from the email job, app/api/cron/mail). The
 * products with a confirmed address wait in STOCK_ALERT_DUE. Each run looks
 * at RESTOCK_RUN_PRODUCTS of those due and sends RESTOCK_RUN_EMAILS at most.
 * A product is back when its units left go from sold out to more than none,
 * or it is no longer limited (lib/stock-alert-rules.ts, restocked). Then its
 * confirmed addresses get one email each, RESTOCK_BATCH at a time, each
 * batch taken from the store's emails before it goes, and each address
 * goes with its leave link once its batch went; when nobody confirmed is
 * left, the list goes whole and the product leaves the job.
 *
 * Never twice: a batch is written down (its job, BATCH_SECONDS) before it is
 * sent, under a key made of when it was written (lib/email.ts, sendBatch). A
 * batch tried again, because the send or the clean-up after it did not come
 * back as asked, is the same batch under the same key, which the email
 * service sends to nobody twice. The service keeps a key a day, and so does
 * the batch: a send whose outcome stayed unknown (the service may have taken
 * it and the answer was lost) is written down with when it was first tried,
 * and UNKNOWN_SETTLED_MS after that, still within the day, the batch is taken
 * as sent and its addresses leave the list, never tried again under a new
 * key: an unknown never counts as "not sent". Never dropped: an address leaves the list
 * only after its batch was sent; a refusal, an answer out of shape or a
 * spent figure keeps everything where it is and the product is looked at
 * again RESTOCK_WAIT_MS later. Somebody who left meanwhile (an exact nil) is
 * skipped. Anything that cannot be read is unknown, never "nobody" (rule 24).
 */
import { readListing } from "@/lib/catalog";
import { speech } from "@/lib/buyer-words";
import { type StockAlertWords, stockAlertWords } from "@/lib/buyer-words/stock-alert";
import { type BatchMessage, sendBatch, sendEmail } from "@/lib/email";
import { type Door, fromLine, releaseDay, render, reserveDay } from "@/lib/mail";
import { productSegment } from "@/lib/product-slug";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { SITE_URL } from "@/lib/site-url";
import { stockLeft } from "@/lib/stock";
import { restocked } from "@/lib/stock-alert-rules";
import {
  STOCK_ALERT_DUE,
  askStockAlert,
  clearStockAlerts,
  dueMember,
  leaveStockAlert,
  stillWaiting,
  stockAlertAddresses,
} from "@/lib/stock-alerts";
import { type ExactStore, storeForIdExactly } from "@/lib/store-exact";
import type { Listing, Store } from "@/lib/store";

/** The most products one run of the email job looks at. */
export const RESTOCK_RUN_PRODUCTS = 10;
/** The most back-in-stock emails one run sends, all products together. */
export const RESTOCK_RUN_EMAILS = 300;
/** The most addresses in one batch: the waitlist's. */
export const RESTOCK_BATCH = 100;
/** How long a product that is still sold out, or could not be read, waits before it is looked at again. */
export const RESTOCK_WAIT_MS = 15 * 60_000;
/** How long a batch written down before its send is kept: within the day the email service keeps a batch's key. */
const BATCH_SECONDS = 86_400;
/**
 * How long after its first unknown outcome a batch is taken as sent: well
 * inside BATCH_SECONDS (written again at that first unknown), so the runs
 * every RESTOCK_WAIT_MS settle it before it could end and a new batch start.
 */
export const UNKNOWN_SETTLED_MS = 20 * 3_600_000;

const jobKey = (sid: string, pid: string) => `nl:sa:${sid}:${pid}:job`;

/** Whether a store can keep a back-in-stock list at all: not switched off, with its ids and the postal address its emails carry. */
export function stockAlertsOpen(store: Store): boolean {
  return !store.suspended && Boolean(store.sid && store.statsId && store.mail?.address);
}

const pagePath = (store: Store) => `/@${store.handle}/back-in-stock`;

/**
 * The way out at the foot of both emails: the page with its button, and the
 * one-click address a mail app uses (always this site's own). The one-click
 * address names the store by its own id, which a change of handle or a
 * handle let go never changes, so it works for as long as the link does.
 */
function door(store: Store, w: StockAlertWords, origin: string, leave: string, why: string): Door {
  const page = `${origin}${pagePath(store)}?leave=${leave}`;
  return {
    page,
    oneClick: `${SITE_URL}/api/store/stock-alert/leave?i=${encodeURIComponent(store.sid)}&t=${leave}`,
    why,
    label: w.doorLabel,
    after: w.doorAfter,
    line: w.doorLine(page),
    lang: speech(store).lang.locale,
  };
}

/** The confirmation email: HTML and text, the creator's postal address, a way out; no tracked link, no picture. */
export function confirmEmail(store: Store, product: Listing, links: { confirm: string; leave: string }, origin: string) {
  const w = stockAlertWords(store.language);
  const body = [w.askLead(store.name, product.title), "", w.askOpen, `${origin}${pagePath(store)}?token=${links.confirm}`, "", w.askWorks, "", w.askIgnore].join("\n");
  return render(store, w.askSubject(product.title), body, null, door(store, w, origin, links.leave, w.askWhy(store.name, product.title)));
}

/** The one email when it is back, with the product's link and its price as the page shows it. */
export function backEmail(store: Store, product: Listing, leave: string) {
  const w = stockAlertWords(store.language);
  const price = product.priceCents > 0 ? speech(store).money(product.priceCents) : "";
  const body = [w.backLead(store.name, product.title, price), "", `${SITE_URL}/@${store.handle}/p/${productSegment(product)}`, "", w.backAfter].join("\n");
  return render(store, w.backSubject(product.title), body, null, door(store, w, SITE_URL, leave, w.backWhy(product.title)));
}

export type StockAlertAsked = "sent" | "email" | "full" | "closed" | "unsent" | "error";

/**
 * An address typed in "Email me when it's back": kept (lib/stock-alerts.ts)
 * and sent its confirmation. `left` is the product's units left as
 * lib/stock.ts reads them.
 */
export async function askBackInStock(input: { store: Store; product: Listing; email: string; left: unknown; origin: string; now?: number }): Promise<StockAlertAsked> {
  const { store, product } = input;
  if (!stockAlertsOpen(store) || product.hidden) return "closed";
  const asked = await askStockAlert({ store, productId: product.id, email: input.email, left: input.left, now: input.now }).catch((error) => {
    console.error("keeping a back-in-stock address failed", error);
    return { ok: false as const, reason: "unknown" as const };
  });
  if (!asked.ok) return asked.reason === "unknown" ? "error" : asked.reason;
  const mail = confirmEmail(store, product, asked, input.origin);
  const sent = await sendEmail({
    meter: { by: "store", store, kind: "transactional", asked: true },
    from: fromLine(store),
    to: input.email.trim(),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    headers: mail.headers,
  }).catch((error) => {
    console.error("sending a back-in-stock confirmation failed", error);
    return false;
  });
  if (sent) return "sent";
  // Its email did not go: a new place is taken back at once (one asked before keeps its own).
  if (!asked.again) await leaveStockAlert(asked.leave, store).catch((error) => console.error("taking back an unconfirmed back-in-stock place failed", error));
  return "unsent";
}

// ------------------------------------------------------------------ the restock job

/** A batch: when it was written, its addresses and, once a send's outcome was unknown, when that was first. */
type Job = { at: number; emails: string[]; unknownSince?: number };

function parseJob(raw: unknown): Job | null {
  if (typeof raw !== "string" || raw.length > 64_000) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { at, emails, unknownSince } = value;
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return null;
    if (unknownSince !== undefined && (typeof unknownSince !== "number" || !Number.isSafeInteger(unknownSince) || unknownSince < at)) return null;
    if (!Array.isArray(emails) || !emails.length || emails.length > RESTOCK_BATCH || emails.some((e) => typeof e !== "string" || !e)) return null;
    return unknownSince === undefined ? { at, emails: emails as string[] } : { at, emails: emails as string[], unknownSince };
  } catch {
    return null;
  }
}

export type RestockDeps = {
  /** The store by its own id, read exactly (lib/store-exact.ts). */
  load: (storeId: string) => Promise<ExactStore>;
  readProduct: (store: Store, id: string) => Promise<Listing | null>;
  /** Units left (lib/stock.ts); throws when they cannot be read. */
  left: (store: Store, product: Listing) => Promise<number | null>;
  send: typeof sendBatch;
};

const DEFAULTS: RestockDeps = { load: storeForIdExactly, readProduct: readListing, left: (store, product) => stockLeft(store, product), send: sendBatch };

/** What became of one product this run: "done" leaves the job, "later" waits RESTOCK_WAIT_MS, "again" is due again at once. */
type Turn = { sent: number; next: "done" | "later" | "again" };

/** The batch written down before it is sent; "unknown" when the write did not come back exactly. */
async function writeJob(sid: string, pid: string, job: Job): Promise<boolean> {
  const reply = repliesFor(await redisPipeline([["SET", jobKey(sid, pid), JSON.stringify(job), "EX", BATCH_SECONDS]]), 1);
  return reply !== null && reply[0] === "OK";
}

async function readJob(sid: string, pid: string): Promise<Job | null> {
  const reply = repliesFor(await redisPipeline([["GET", jobKey(sid, pid)]]), 1);
  if (!reply) throw new UnknownReplyError("a back-in-stock batch");
  if (reply[0] === null) return null;
  const job = parseJob(reply[0]);
  if (!job) throw new UnknownReplyError("a back-in-stock batch");
  return job;
}

/** One batch: its addresses still confirmed get the email, then leave the list. */
async function sendJob(store: Store, product: Listing, job: Job, deps: RestockDeps): Promise<Turn> {
  const sid = store.statsId!;
  const leaves = await stillWaiting(store, product.id, job.emails);
  const going = job.emails.flatMap((email, i) => {
    const leave = leaves[i];
    return leave ? [{ email, leave }] : [];
  });
  // An outcome unknown long enough is taken as sent: the service may have written to them, so nobody is written to again.
  const settled = job.unknownSince !== undefined && Date.now() - job.unknownSince >= UNKNOWN_SETTLED_MS;
  if (going.length && !settled) {
    if (!(await reserveDay(going.length))) return { sent: 0, next: "later" };
    const messages: BatchMessage[] = going.map(({ email, leave }) => {
      const mail = backEmail(store, product, leave);
      return { from: fromLine(store), to: email, subject: mail.subject, text: mail.text, html: mail.html, replyTo: store.email, headers: mail.headers };
    });
    const outcome = await deps.send(messages, `stock-alert:${sid}:${product.id}:${job.at}`, { by: "store", store, kind: "email" });
    if (outcome !== "sent") {
      await releaseDay(going.length);
      // A refusal sent nothing. "retry" may mean taken with the answer lost: written down once, with when.
      if (outcome === "retry" && job.unknownSince === undefined) await writeJob(sid, product.id, { ...job, unknownSince: Date.now() });
      return { sent: 0, next: "later" };
    }
  }
  // Sent (or nobody left in it): its addresses go, then the batch. A failure here keeps the batch, tried again under its key.
  await clearStockAlerts(store, product.id, job.emails);
  const gone = repliesFor(await redisPipeline([["DEL", jobKey(sid, product.id)]]), 1);
  if (!gone || countOf(gone[0]) === null) throw new UnknownReplyError("a back-in-stock batch sent");
  return { sent: settled ? 0 : going.length, next: "again" };
}

async function restockOne(member: string, budget: number, deps: RestockDeps): Promise<Turn> {
  const cut = member.indexOf("|");
  const storeId = cut > 0 ? member.slice(0, cut) : "";
  const productId = cut > 0 ? member.slice(cut + 1) : "";
  if (!storeId || !/^[a-z0-9]{1,40}$/.test(productId)) return { sent: 0, next: "done" };
  const found = await deps.load(storeId);
  // The store is gone: its lists went with it (lib/data-families.ts).
  if (found === "none") return { sent: 0, next: "done" };
  if (found === "unknown") return { sent: 0, next: "later" };
  const store = found;
  if (!store.statsId || store.suspended || !store.mail?.address) return { sent: 0, next: "later" };
  const product = await deps.readProduct(store, productId);
  // A product that left the store, exactly: its list goes whole, nobody emailed.
  if (!product) {
    if (store.catalog.items.some((item) => item.id === productId)) return { sent: 0, next: "later" };
    const everyone = await stockAlertAddresses(store, productId);
    await clearStockAlerts(store, productId, everyone.map((a) => a.email));
    return { sent: 0, next: "done" };
  }
  if (product.hidden) return { sent: 0, next: "later" };

  const pending = await readJob(store.statsId, productId);
  // A batch left waiting goes only when what is left of this run holds it whole (its key is its batch, so it is never
  // cut): otherwise it waits for the next run, and the run's ceiling holds (Claude 3 on #3620).
  // One taken as sent (UNKNOWN_SETTLED_MS) sends nothing, so it is settled whatever is left.
  if (pending) {
    const settling = pending.unknownSince !== undefined && Date.now() - pending.unknownSince >= UNKNOWN_SETTLED_MS;
    return pending.emails.length > budget && !settling ? { sent: 0, next: "later" } : sendJob(store, product, pending, deps);
  }
  // The list ended by itself (a year after its latest write) or was erased: nothing left to send for.
  const size = repliesFor(await redisPipeline([["HLEN", `nl:sa:${store.statsId}:${productId}`]]), 1);
  const count = size ? countOf(size[0]) : null;
  if (count === null) throw new UnknownReplyError("a back-in-stock list");
  if (count === 0) return { sent: 0, next: "done" };

  if (restocked(0, await deps.left(store, product)) !== "yes") return { sent: 0, next: "later" };
  const everyone = await stockAlertAddresses(store, productId);
  const confirmed = everyone.filter((a) => a.confirmed).map((a) => a.email).sort();
  if (!confirmed.length) {
    // Back, and nobody confirmed is left: the list has done its one job and goes whole.
    await clearStockAlerts(store, productId, everyone.map((a) => a.email));
    return { sent: 0, next: "done" };
  }
  const job: Job = { at: Date.now(), emails: confirmed.slice(0, Math.min(RESTOCK_BATCH, budget)) };
  if (!job.emails.length) return { sent: 0, next: "again" };
  if (!(await writeJob(store.statsId, productId, job))) return { sent: 0, next: "later" };
  return sendJob(store, product, job, deps);
}

/**
 * Sends what back-in-stock lists owe, until `deadline`: at most
 * RESTOCK_RUN_PRODUCTS products and RESTOCK_RUN_EMAILS emails a run.
 * Returns how many emails went.
 */
export async function runRestocks(deadline: number, deps: RestockDeps = DEFAULTS): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const reply = repliesFor(await redisPipeline([["ZRANGEBYSCORE", STOCK_ALERT_DUE, "-inf", Date.now(), "LIMIT", 0, RESTOCK_RUN_PRODUCTS]]), 1);
  const members = reply ? stringList(reply[0]) : null;
  if (!members) {
    console.error("sending back-in-stock emails: the products due were read in an unknown shape, so they wait", new UnknownReplyError("the back-in-stock products due"));
    return 0;
  }
  let sent = 0;
  for (const member of members) {
    if (Date.now() > deadline || sent >= RESTOCK_RUN_EMAILS) break;
    let turn: Turn;
    try {
      turn = await restockOne(member, RESTOCK_RUN_EMAILS - sent, deps);
    } catch (error) {
      console.error("sending back-in-stock emails: a product could not be read as asked, so it waits", error);
      turn = { sent: 0, next: "later" };
    }
    sent += turn.sent;
    if (turn.next === "done") await redisPipeline([["ZREM", STOCK_ALERT_DUE, member]]);
    else if (turn.next === "later") await redisPipeline([["ZADD", STOCK_ALERT_DUE, "XX", Date.now() + RESTOCK_WAIT_MS, member]]);
  }
  return sent;
}

export { dueMember };
