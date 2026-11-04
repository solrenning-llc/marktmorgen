/**
 * Telling the buyers of a product that it was updated (added 11 October
 * 2026): a new edition of the guide, more templates in the pack, new lessons
 * in the course. Gumroad has it; Stan, Kajabi and Teachable leave the creator
 * to copy addresses out by hand.
 *
 * It is an email about something the reader bought, not one selling them
 * anything, so it goes to every buyer of the product, not only to those who
 * joined the creator's list. What keeps it that kind of email, and fair:
 *
 *   - It says what changed in the creator's own words, and where to get the
 *     new version: the store's orders page, where the buyer gets what is
 *     theirs with the address they paid with. Nothing else is linked.
 *   - Once a week at most per product, so it cannot become a newsletter.
 *   - It still carries a one-click way to stop these emails from the store,
 *     and nobody who left the creator's list or pressed that stop is written
 *     to. Buying is never undone by it: the buyer keeps what they bought.
 *   - Pro, and counted in the store's monthly emails, with the same sender,
 *     footer and postal address as the creator's other email (lib/mail.ts).
 *
 * The buyers are read from the creator's own Stripe account when it starts:
 * paid checkouts of this store that sold the product, on its own or added at
 * checkout, as far back as one all-time reading goes. A gift's buyer is not
 * its owner and is left out. It goes out a hundred at a time from the
 * five-minute mail job, each batch under its own key so a retry never sends
 * twice.
 *
 *   nl:upd:job:<id>             the send (JSON)
 *   nl:upd:job:<id>:to          addresses, in order (a list)
 *   nl:updq                     sends waiting or under way
 *   nl:upd:last:<statsId>:<p>   when that product's buyers were last written to
 *   nl:upd:off:<statsId>:<hash> that address pressed stop, kept for good
 *   nl:upd:stop:<token>         who a stop link belongs to
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { deriveKey } from "@/lib/secret-box";
import { normaliseEmail } from "@/lib/auth";
import { type BatchMessage, sendBatch } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { BATCH_SIZE, SENDER_WAIT_NOTE, canWrite, fromLine, monthlyAllowance, release, render, reserve } from "@/lib/mail";
import { leadsKey, parseContact } from "@/lib/contacts";
import { storeBase } from "@/lib/purchase-email";
import { SITE_URL } from "@/lib/site-url";
import { ALL_TIME_PAGES, readPaidSales } from "@/lib/stats";
import { bumpsFromMeta } from "@/lib/bundle-rules";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import { updatesWords } from "@/lib/buyer-words/updates";
import { type Listing, type Store, saleHandles, storeForHandle } from "@/lib/store";
import { MAX_UPDATE_NOTE, MAX_UPDATE_RECIPIENTS, UPDATE_GAP_SECONDS, canTellBuyers } from "@/lib/product-updates-rules";
import { noteForErasure } from "@/lib/erasure-index";
import { takeStoreReading } from "@/lib/store-readings";
import { orderWrite } from "@/lib/order-data";
import { suppressedCommand, wasSuppressed } from "@/lib/suppression";

export { MAX_UPDATE_NOTE, MAX_UPDATE_RECIPIENTS, UPDATE_GAP_SECONDS, canTellBuyers };

export const UPDATE_STOP = /^[0-9a-f]{40}$/;
const JOB_ID = /^[0-9a-f]{24}$/;
const QUEUE = "nl:updq";
const KEEP_SECONDS = 60 * 86_400;
const STOP_LINK_SECONDS = 400 * 86_400;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const jobKey = (id: string) => `nl:upd:job:${id}`;
const toKey = (id: string) => `nl:upd:job:${id}:to`;
const lockKey = (id: string) => `nl:upd:job:${id}:lock`;
const lastKey = (statsId: string, product: string) => `nl:upd:last:${statsId}:${product}`;
const latestKey = (statsId: string, product: string) => `nl:upd:latest:${statsId}:${product}`;
const offKey = (statsId: string, email: string) => `nl:upd:off:${statsId}:${sha(`nimbus-update-off:${normaliseEmail(email)}`).slice(0, 32)}`;
const stopKey = (token: string) => `nl:upd:stop:${token}`;

export type UpdateJob = {
  id: string;
  handle: string;
  statsId: string;
  product: string;
  title: string;
  /** The creator's own words about what changed. */
  words: string;
  total: number;
  done: number;
  sent: number;
  status: "sending" | "waiting" | "sent" | "failed";
  /** Why it is waiting or failed, in words for the studio. */
  note: string;
  failures: number;
  createdAt: number;
};


/** The creator's words, made safe: plain text, runs of blank lines closed, at most MAX_UPDATE_NOTE. */
export function cleanNote(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_UPDATE_NOTE);
}

/** The email's subject and body, in the store's language: the creator's words, then where to get it. */
export function updateText(store: Store, title: string, note: string): { subject: string; body: string } {
  const u = updatesWords(store.language);
  const name = store.mail?.fromName || store.name;
  return {
    subject: u.subject(title).slice(0, 150),
    body: [u.lead(title, name), ...(note ? ["", note] : []), "", u.here, `${storeBase(store)}/orders`].join("\n"),
  };
}

/**
 * Every address that paid this store for the product, once each, lowercased:
 * on its own, in a cart or added at checkout. A gift's buyer is not its owner.
 */
export function buyersFrom(rows: Record<string, unknown>[], handles: ReadonlySet<string>, productId: string): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Record<string, string>;
    if (!handles.has(meta.store ?? "") || meta.gift || meta.group) continue;
    if (row.status !== "complete" || row.payment_status !== "paid") continue;
    const ids = [meta.product, ...bumpsFromMeta(meta).map((b) => b.id)];
    if (!ids.includes(productId)) continue;
    const typed = (row.customer_details as { email?: unknown } | null | undefined)?.email;
    if (typeof typed === "string" && typed.includes("@")) seen.add(normaliseEmail(typed));
  }
  return [...seen];
}

export type StartResult =
  | { ok: true; job: UpdateJob }
  | { ok: false; reason: "plan" | "kind" | "soon" | "none" | "stripe"; until?: number }
  | { ok: false; reason: "used"; message: string; until?: undefined };

/** When this product's buyers may next be told, in seconds; 0 when they may now. */
export async function nextUpdateAt(store: Store, productId: string): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [last] = await redisPipeline([["GET", lastKey(store.statsId, productId)]]);
  const at = Number(last) || 0;
  return at ? at + UPDATE_GAP_SECONDS : 0;
}

/** Writes down an update to go to every buyer of the product now. */
export async function startUpdate(store: Store, product: Listing, rawNote: unknown, nowSeconds = Math.floor(Date.now() / 1000)): Promise<StartResult> {
  if (!canWrite(store) || !store.statsId || !store.stripeAccountId) return { ok: false, reason: "plan" };
  if (!canTellBuyers(product)) return { ok: false, reason: "kind" };
  const next = await nextUpdateAt(store, product.id);
  if (next > nowSeconds) return { ok: false, reason: "soon", until: next };
  // Finding the buyers reads every paid sale the store has (both Stripe lists,
  // ALL_TIME_PAGES pages each, and its PayPal sales), and a press that finds
  // none claims nothing, so it can be pressed again: each reading is one of
  // the store's own readings of the day, taken before it starts
  // (lib/store-readings.ts; owner's rule MR and decision of 4 November 2026,
  // inbox C4-18). The studio's requests count only the press itself.
  if (!(await takeStoreReading(store, Date.now(), true))) {
    return { ok: false, reason: "used", message: "Your store has read its sales from Stripe as many times as it can today. Try again tomorrow." };
  }
  let rows: Record<string, unknown>[];
  try {
    rows = (await readPaidSales(store, 0, ALL_TIME_PAGES)).sales.filter((s) => !s.upsell).map((s) => s.row);
  } catch {
    return { ok: false, reason: "stripe" };
  }
  const buyers = buyersFrom(rows, saleHandles(store), product.id).slice(0, MAX_UPDATE_RECIPIENTS);
  if (buyers.length === 0) return { ok: false, reason: "none" };
  // Taken before anything is written, so two presses make one send.
  const [claimed] = await redisPipeline([["SET", lastKey(store.statsId, product.id), String(nowSeconds), "NX", "EX", UPDATE_GAP_SECONDS]]);
  if (claimed === null) return { ok: false, reason: "soon", until: (await nextUpdateAt(store, product.id)) || nowSeconds + UPDATE_GAP_SECONDS };
  const job: UpdateJob = {
    id: randomBytes(12).toString("hex"),
    handle: store.handle,
    statsId: store.statsId,
    product: product.id,
    title: product.title,
    words: cleanNote(rawNote),
    total: buyers.length,
    done: 0,
    sent: 0,
    status: "sending",
    note: "",
    failures: 0,
    createdAt: nowSeconds,
  };
  const commands: (string | number)[][] = [["DEL", toKey(job.id)]];
  for (let i = 0; i < buyers.length; i += 500) commands.push(["RPUSH", toKey(job.id), ...buyers.slice(i, i + 500)]);
  commands.push(
    ["EXPIRE", toKey(job.id), KEEP_SECONDS],
    ["SET", jobKey(job.id), JSON.stringify(job), "EX", KEEP_SECONDS],
    ["SET", latestKey(store.statsId, product.id), job.id, "EX", KEEP_SECONDS],
    ["SADD", QUEUE, job.id],
  );
  await redisPipeline(commands);
  return { ok: true, job };
}

export async function readUpdateJob(id: string): Promise<UpdateJob | null> {
  if (!JOB_ID.test(id) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", jobKey(id)]]);
  if (typeof raw !== "string") return null;
  try {
    const job = JSON.parse(raw) as UpdateJob;
    return JOB_ID.test(job.id) ? job : null;
  } catch {
    return null;
  }
}

/** The last update sent about this product in the past two months, for the studio to show; null when none. */
export async function latestUpdate(store: Store, productId: string): Promise<UpdateJob | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const [id] = await redisPipeline([["GET", latestKey(store.statsId, productId)]]);
  return typeof id === "string" ? readUpdateJob(id) : null;
}

async function save(job: UpdateJob): Promise<void> {
  await redisPipeline([["SET", jobKey(job.id), JSON.stringify(job), "EX", KEEP_SECONDS]]);
}

/**
 * One stop link for each address a store writes to (since 18 October 2026),
 * the same in every email: so what the links keep is one record a buyer,
 * counted in the store's room when it is first made (lib/order-data.ts),
 * not one an email. Signed with a key of our own, so nobody can make the
 * link of an address; where no key is set, a new one each time, as before.
 */
function stopToken(statsId: string, email: string): string {
  const key = deriveKey("update-stop");
  return key ? createHmac("sha256", key).update(`${statsId}|${normaliseEmail(email)}`).digest("hex").slice(0, 40) : randomBytes(20).toString("hex");
}

async function stopLink(store: Store, email: string): Promise<string> {
  const token = stopToken(store.statsId ?? "", email);
  const grant = { s: store.statsId, e: normaliseEmail(email), h: store.handle, n: store.mail?.fromName || store.name };
  // The link itself is counted in the store's room at what it really adds,
  // once an address (lib/order-data.ts); the note that finds it again for an
  // erasure is bounded on its own (lib/erasure-index.ts).
  await orderWrite(store, [["SET", stopKey(token), JSON.stringify(grant), "EX", STOP_LINK_SECONDS]]);
  const notes = noteForErasure(store.statsId, email, stopKey(token));
  if (notes.length) await redisPipeline(notes);
  return token;
}

/**
 * Moves one send on for as long as `deadline` allows. Safe to call from two
 * places at once: only one holds the send at a time.
 */
export async function advanceUpdate(id: string, load: (handle: string) => Promise<Store | null>, deadline: number): Promise<UpdateJob | null> {
  const [got] = await redisPipeline([["SET", lockKey(id), "1", "NX", "EX", 90]]);
  if (got === null) return null;
  try {
    let job = await readUpdateJob(id);
    if (!job || job.status === "sent" || job.status === "failed") {
      await redisPipeline([["SREM", QUEUE, id]]);
      return job;
    }
    const store = await load(job.handle);
    if (!store || store.statsId !== job.statsId) {
      job = { ...job, status: "failed", note: "The store is not here anymore." };
      await save(job);
      await redisPipeline([["SREM", QUEUE, id]]);
      return job;
    }
    if (monthlyAllowance(store) === 0 || !store.mail) {
      job = { ...job, status: "waiting", note: "Your plan does not include email right now. It goes out once Pro is on again." };
      await save(job);
      return job;
    }
    job = { ...job, status: "sending", note: "" };
    const u = updatesWords(store.language);
    const g = givingWords(store.language);
    const text = updateText(store, job.title, job.words);
    const fromName = store.mail?.fromName || store.name;
    while (job.done < job.total && Date.now() < deadline) {
      const [chunk] = await redisPipeline([["LRANGE", toKey(id), job.done, job.done + BATCH_SIZE - 1]]);
      const emails = Array.isArray(chunk) ? (chunk as string[]) : [];
      if (!emails.length) {
        job = { ...job, done: job.total };
        break;
      }
      // Nobody who pressed stop here, or left the creator's list.
      // Nor anybody deleted from the store (lib/suppression.ts).
      const checks = await redisPipeline(
        emails.flatMap((email) => [
          ["EXISTS", offKey(job!.statsId, email)],
          store.listId ? ["HGET", leadsKey(store.listId), email] : ["EXISTS", "nl:none"],
          suppressedCommand(store.listId, email),
        ]),
      );
      const recipients = emails.filter((_, i) => Number(checks[i * 3]) !== 1 && !(store.listId && parseContact(checks[i * 3 + 1])?.unsub) && !wasSuppressed(checks[i * 3 + 2]));
      if (recipients.length) {
        const reserved = await reserve(store, recipients.length);
        if (reserved !== "ok") {
          job = {
            ...job,
            status: "waiting",
            note:
              reserved === "month"
                ? "This month's emails ran out. The rest go out when the month turns."
                : reserved === "sender"
                  ? SENDER_WAIT_NOTE
                  : "Going out in daily portions: the rest continue tomorrow, by themselves.",
          };
          break;
        }
        const messages: BatchMessage[] = [];
        for (const email of recipients) {
          const stop = await stopLink(store, email);
          const page = `${SITE_URL}/unsubscribe?u=${stop}`;
          const r = render(store, text.subject, text.body, null, {
            page,
            oneClick: `${SITE_URL}/api/mail/unsubscribe?u=${stop}`,
            why: u.why(job.title, fromName),
            label: u.stopLabel,
            after: u.stopAfter(fromName),
            line: u.stopLine(page),
            sent: g.sentWith,
            lang: speech(store).lang.locale,
          });
          messages.push({ from: fromLine(store), to: email, subject: r.subject, text: r.text, html: r.html, replyTo: store.email, headers: r.headers });
        }
        const outcome = await sendBatch(messages, `upd:${id}:${job.done}:${emails.length}`, { by: "monthly" });
        if (outcome !== "sent") {
          await release(store, recipients.length);
          const failures = job.failures + 1;
          job =
            failures >= 5 || outcome === "refused"
              ? { ...job, status: "failed", failures, note: "The email service would not take it. Nothing more was sent." }
              : { ...job, failures, note: "Paused for a moment: the email service asked us to slow down." };
          break;
        }
      }
      job = { ...job, done: job.done + emails.length, sent: job.sent + recipients.length, failures: 0 };
      await save(job);
    }
    if (job.status === "sending" && job.done >= job.total) {
      job = { ...job, status: "sent" };
      await redisPipeline([["DEL", toKey(id)]]);
    }
    await save(job);
    if (job.status === "sent" || job.status === "failed") await redisPipeline([["SREM", QUEUE, id]]);
    return job;
  } finally {
    await redisPipeline([["DEL", lockKey(id)]]).catch(() => {});
  }
}

/** Moves every waiting update on. For the mail job. */
export async function advanceUpdates(load: (handle: string) => Promise<Store | null>, deadline: number): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [raw] = await redisPipeline([["SMEMBERS", QUEUE]]);
  const ids = Array.isArray(raw) ? (raw as string[]) : [];
  let touched = 0;
  for (const id of ids) {
    if (Date.now() > deadline) break;
    if (await advanceUpdate(id, load, deadline)) touched += 1;
  }
  return touched;
}

/** Who a stop link belongs to, without acting on it. */
export async function readUpdateStop(token: string): Promise<{ email: string; storeName: string; stopped: boolean; handle: string } | null> {
  if (!UPDATE_STOP.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", stopKey(token)]]);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const grant = JSON.parse(raw) as { s?: unknown; e?: unknown; h?: unknown; n?: unknown };
    if (typeof grant.s !== "string" || typeof grant.e !== "string") return null;
    const [off] = await redisPipeline([["EXISTS", offKey(grant.s, grant.e)]]);
    return { email: grant.e, storeName: typeof grant.n === "string" ? grant.n : "", stopped: Number(off) === 1, handle: typeof grant.h === "string" ? grant.h : "" };
  } catch {
    return null;
  }
}

/** Stops every update email from that store to that address, for good. Safe to press twice. */
export async function stopUpdates(token: string): Promise<boolean> {
  if (!UPDATE_STOP.test(token) || !isRedisConfigured()) return false;
  const [raw] = await redisPipeline([["GET", stopKey(token)]]);
  if (typeof raw !== "string" || !raw) return false;
  try {
    const grant = JSON.parse(raw) as { s?: unknown; e?: unknown; h?: unknown };
    if (typeof grant.s !== "string" || typeof grant.e !== "string") return false;
    // Kept for good, so counted in the store's room at what it adds (lib/order-data.ts).
    const store = typeof grant.h === "string" && grant.h ? await storeForHandle(grant.h).catch(() => null) : null;
    await orderWrite(store && store.statsId === grant.s ? store : { statsId: grant.s }, [["SET", offKey(grant.s, grant.e), new Date().toISOString()]]);
    return true;
  } catch {
    return false;
  }
}
