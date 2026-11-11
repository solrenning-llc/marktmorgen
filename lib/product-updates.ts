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
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { type BatchMessage, sendBatch } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { BATCH_SIZE, SENDER_WAIT_NOTE, canWrite, fromLine, monthlyAllowance, release, render, reserve } from "@/lib/mail";
import { leadsKey, parseContact } from "@/lib/contacts";
import { storeBase } from "@/lib/purchase-email";
import { SITE_URL } from "@/lib/site-url";
import { ALL_TIME_PAGES, readPaidSales, readsSales } from "@/lib/stats";
import { bumpsFromMeta } from "@/lib/bundle-rules";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import { updatesWords } from "@/lib/buyer-words/updates";
import { type Listing, type Store, saleHandles, storeForHandle } from "@/lib/store";
import { MAX_UPDATE_NOTE, MAX_UPDATE_RECIPIENTS, UPDATE_GAP_SECONDS, canTellBuyers } from "@/lib/product-updates-rules";
import { noteForErasure } from "@/lib/erasure-index";
import { orderWrite } from "@/lib/order-data";
import { suppressedCommand } from "@/lib/suppression";
import { BUYER_LEDGER_UNITS, ledgerReadBytes, ledgerUnits } from "@/lib/segments";
import { paypalKept } from "@/lib/paypal-sales";
import { countUnits } from "@/lib/person-agenda-read";

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
  | { ok: false; reason: "studio_used"; message: string; until?: undefined };

/**
 * Studio requests reading every paid sale of the store costs, before it is
 * read (lib/stats.ts, readPaidSales): when Stripe is read (a Stripe account),
 * as much as a reading of its buyers from Stripe (lib/segments.ts,
 * BUYER_LEDGER_UNITS, which reads these pages and more); and the PayPal sales
 * kept (`paypalSales`), read whenever the store reads sales, by their weight.
 * Nothing when it reads no sales.
 */
export function updateReadUnits(store: Pick<Store, "stripeAccountId" | "paypalSeller">, paypalSales: number): number {
  if (!readsSales(store)) return 0;
  return (store.stripeAccountId ? BUYER_LEDGER_UNITS : 0) + ledgerUnits(ledgerReadBytes({ imported: 0, paypalSales, paypalRefunds: 0 }));
}

/**
 * The time written by a claim: a whole number of seconds, then a point and the
 * nine random digits that make the claim this press's own (claimValue); or the
 * whole seconds alone, as claims written before that still read.
 */
const SECONDS_TEXT = /^(0|[1-9][0-9]*)(?:\.[0-9]{9})?$/;

/**
 * When this product's buyers may next be told, in seconds; 0 when they may now.
 * Only a confirmed absent key means "now" (CX-123 rule 24): any other reply
 * than the seconds a claim wrote throws UnknownReplyError, so nothing is read
 * or sent on it.
 */
export async function nextUpdateAt(store: Store, productId: string): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const reply = repliesFor(await redisPipeline([["GET", lastKey(store.statsId, productId)]]), 1);
  if (!reply) throw new UnknownReplyError("the last product update time");
  const last = reply[0];
  if (last === null) return 0;
  const seconds = typeof last === "string" ? SECONDS_TEXT.exec(last)?.[1] : undefined;
  const at = seconds === undefined ? NaN : Number(seconds);
  if (!Number.isSafeInteger(at)) throw new UnknownReplyError("the last product update time");
  return at ? at + UPDATE_GAP_SECONDS : 0;
}

/** Writes down an update to go to every buyer of the product now. */
export async function startUpdate(store: Store, product: Listing, rawNote: unknown, nowSeconds = Math.floor(Date.now() / 1000)): Promise<StartResult> {
  if (!canWrite(store) || !store.statsId || !store.stripeAccountId) return { ok: false, reason: "plan" };
  if (!canTellBuyers(product)) return { ok: false, reason: "kind" };
  const next = await nextUpdateAt(store, product.id);
  if (next > nowSeconds) return { ok: false, reason: "soon", until: next };
  // Every paid sale, read again from Stripe each time: counted in the studio's requests first, nothing read when not.
  const kept = await paypalKept(store.statsId, false).catch(() => null);
  if (!kept) return { ok: false, reason: "stripe" };
  const counted = await countUnits(store, updateReadUnits(store, kept.sales)).catch(() => null);
  if (!counted?.ok) return { ok: false, reason: "studio_used", message: counted && !counted.ok ? counted.message : "" };
  let rows: Record<string, unknown>[];
  try {
    rows = (await readPaidSales(store, 0, ALL_TIME_PAGES)).sales.filter((s) => !s.upsell).map((s) => s.row);
  } catch {
    return { ok: false, reason: "stripe" };
  }
  const buyers = buyersFrom(rows, saleHandles(store), product.id).slice(0, MAX_UPDATE_RECIPIENTS);
  if (buyers.length === 0) return { ok: false, reason: "none" };
  // Taken before anything is written, so two presses make one send, with a
  // value only this press writes (lib/claim-mark.ts): a reply in no known shape
  // is read back, and a claim still unknown writes no job and is let go, only
  // if it holds this press's value, so a claim that landed never holds the gap
  // for 7 days with nothing sent (rule 24; Claude 2 on #3235).
  const claimKey = lastKey(store.statsId, product.id);
  const mine = claimValue(nowSeconds);
  const claim = await claimMark(claimKey, UPDATE_GAP_SECONDS, mine);
  if (claim === "unknown") {
    await releaseMark(claimKey, mine);
    throw new UnknownReplyError("the product update claim");
  }
  if (claim === "taken") return { ok: false, reason: "soon", until: (await nextUpdateAt(store, product.id)) || nowSeconds + UPDATE_GAP_SECONDS };
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
  const written = await redisPipeline(commands).catch(() => null);
  if (!jobWritten(written, commands)) {
    // Some of it may have landed: the job is taken back before the claim is let go, so a retry never sends twice;
    // while a send of it may be under way, the claim is kept (Claude 2 on #3235, LOW 1).
    if (await takeBack(job.id)) {
      await releaseMark(latestKey(store.statsId, product.id), job.id);
      await releaseMark(claimKey, mine);
    }
    throw new UnknownReplyError("the product update job");
  }
  return { ok: true, job };
}

/**
 * The job's pipeline answered exactly as it was written (rule 24): DEL 0 or 1, each RPUSH the list's length so far,
 * EXPIRE 1, both SETs "OK", SADD 1 (a new random id).
 */
function jobWritten(reply: unknown, commands: (string | number)[][]): boolean {
  let replies: unknown[] | null;
  try {
    replies = repliesFor(reply, commands.length);
  } catch {
    return false;
  }
  if (!replies) return false;
  let length = 0;
  return commands.every((command, i) => {
    const got = replies[i];
    switch (command[0]) {
      case "DEL": return got === 0 || got === 1;
      case "RPUSH": length += command.length - 2; return got === length;
      case "EXPIRE": return got === 1;
      case "SET": return got === "OK";
      case "SADD": return got === 1;
      default: return false;
    }
  });
}

/**
 * Takes back a job whose writes could not be confirmed: under its own send lock, so no send of it is under way, it
 * leaves the queue and its record and addresses are deleted. True only when each step answered exactly; then nothing
 * of it can go out. The lock is left to run out (90 s), so a run still holding the id finds no job and sends nothing.
 */
async function takeBack(id: string): Promise<boolean> {
  try {
    const lock = repliesFor(await redisPipeline([["SET", lockKey(id), "1", "NX", "EX", 90]]), 1);
    if (!lock || lock[0] !== "OK") return false;
    const gone = repliesFor(await redisPipeline([["SREM", QUEUE, id], ["DEL", jobKey(id), toKey(id)]]), 2);
    return !!gone && (gone[0] === 0 || gone[0] === 1) && (gone[1] === 0 || gone[1] === 1 || gone[1] === 2);
  } catch {
    return false;
  }
}

export async function readUpdateJob(id: string): Promise<UpdateJob | null> {
  if (!JOB_ID.test(id) || !isRedisConfigured()) return null;
  const reply = await redisPipeline([["GET", jobKey(id)]]);
  const unknown = () => new Error("This update could not be checked. Try again.");
  if (!Array.isArray(reply) || reply.length !== 1 || !Object.hasOwn(reply, 0)) throw unknown();
  const raw = reply[0];
  if (raw === null) return null;
  if (typeof raw !== "string") throw unknown();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw unknown();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unknown();
  const job = value as Record<string, unknown>;
  for (const field of ["id", "handle", "statsId", "product", "title", "words", "status", "note"]) {
    if (!Object.hasOwn(job, field) || typeof job[field] !== "string") throw unknown();
  }
  for (const field of ["total", "done", "sent", "failures", "createdAt"]) {
    if (!Object.hasOwn(job, field) || typeof job[field] !== "number" ||
        !Number.isSafeInteger(job[field]) || job[field] < 0) throw unknown();
  }
  if (job.id !== id || !job.handle || !job.statsId || !job.product ||
      !["sending", "waiting", "sent", "failed"].includes(job.status as string) ||
      (job.total as number) === 0 || (job.total as number) > MAX_UPDATE_RECIPIENTS ||
      (job.done as number) > (job.total as number) || (job.sent as number) > (job.done as number)) throw unknown();
  return value as UpdateJob;
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
  // Held only on an exact "OK" (rule 24): any other reply leaves the send for
  // the next run and lets go of nothing, since the lock may not be ours.
  const got = repliesFor(await redisPipeline([["SET", lockKey(id), "1", "NX", "EX", 90]]), 1);
  if (!got || got[0] !== "OK") return null;
  try {
    // Unknown evidence must not dequeue a real job or overwrite its payload.
    // Keep it for the next automatic read; only a confirmed null is absent.
    let job: UpdateJob | null;
    try { job = await readUpdateJob(id); } catch { return null; }
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
      const reply = await redisPipeline([["LRANGE", toKey(id), job.done, job.done + BATCH_SIZE - 1]]).catch(() => null);
      const emails = checkedUpdateChunk(reply, Math.min(BATCH_SIZE, job.total - job.done));
      if (emails === null) {
        // An empty LRANGE is also what Redis returns after the bounded
        // recipient list expires. Only exact, separate proof that the key is
        // absent makes that terminal; malformed or unavailable evidence
        // remains retryable and never permits mail.
        const exists = checkedUpdateListPresence(
          await redisPipeline([["EXISTS", toKey(id)]]).catch(() => null),
        );
        job = exists === false
          ? { ...job, status: "failed", note: "The recipient list expired. Nothing more was sent." }
          : { ...job, status: "waiting", note: "The recipients could not be checked just now. Nothing more was sent. We will try again." };
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
      ).catch(() => null);
      const recipients = checkedUpdateRecipients(emails, checks, Boolean(store.listId));
      if (recipients === null) {
        job = { ...job, status: "waiting", note: "The recipients could not be checked just now. Nothing more was sent. We will try again." };
        break;
      }
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

/** Exact evidence that the bounded recipient list still exists. */
function checkedUpdateListPresence(reply: unknown): boolean | null {
  if (!Array.isArray(reply) || reply.length !== 1 || !Object.hasOwn(reply, 0)) return null;
  if (reply[0] === 1) return true;
  if (reply[0] === 0) return false;
  return null;
}

/** An unfinished job has exactly this many recipients in its next bounded page. */
function checkedUpdateChunk(reply: unknown, expected: number): string[] | null {
  if (!Array.isArray(reply) || reply.length !== 1 || !Object.hasOwn(reply, 0) ||
      !Number.isSafeInteger(expected) || expected <= 0 || !Array.isArray(reply[0]) || reply[0].length !== expected) return null;
  const chunk: unknown[] = reply[0];
  for (let i = 0; i < expected; i++) {
    const email = chunk[i];
    if (!Object.hasOwn(chunk, i) || typeof email !== "string" || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  }
  return chunk as string[];
}

/** Every opt-out and erasure slot must be confirmed before any recipient is admitted. */
function checkedUpdateRecipients(emails: string[], checks: unknown, hasList: boolean): string[] | null {
  if (!Array.isArray(checks) || checks.length !== emails.length * 3) return null;
  const recipients: string[] = [];
  for (let i = 0; i < emails.length; i++) {
    for (let j = 0; j < 3; j++) if (!Object.hasOwn(checks, i * 3 + j)) return null;
    const [off, raw, erased] = checks.slice(i * 3, i * 3 + 3);
    if ((off !== 0 && off !== 1) || (erased !== 0 && erased !== 1)) return null;
    let unsubscribed = false;
    if (hasList) {
      if (raw !== null) {
        if (typeof raw !== "string") return null;
        try {
          const value: unknown = JSON.parse(raw);
          // Older contacts may lack unsub; any present value must be boolean.
          if (!value || typeof value !== "object" || Array.isArray(value) ||
              ("unsub" in value && typeof value.unsub !== "boolean")) return null;
        } catch { return null; }
        const contact = parseContact(raw);
        if (!contact) return null;
        unsubscribed = contact.unsub;
      }
    } else if (raw !== 0 && raw !== 1) return null;
    if (off === 0 && !unsubscribed && erased === 0) recipients.push(emails[i]);
  }
  return recipients;
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

/**
 * Who a stop link belongs to, without acting on it. Null only when the link is confirmed not there (an exact nil) or
 * its record is not a stop link's; a reply cut short or of another shape throws (CX-123 rule 24), and the unsubscribe
 * page says it could not open the link just now, never that the link is unknown.
 */
export async function readUpdateStop(token: string): Promise<{ email: string; storeName: string; stopped: boolean; handle: string } | null> {
  if (!UPDATE_STOP.test(token) || !isRedisConfigured()) return null;
  const read = repliesFor(await redisPipeline([["GET", stopKey(token)]]), 1);
  if (!read || (read[0] !== null && typeof read[0] !== "string")) throw new UnknownReplyError("an update stop link");
  const raw = read[0];
  if (raw === null || !raw) return null;
  let grant: { s?: unknown; e?: unknown; h?: unknown; n?: unknown };
  try {
    grant = JSON.parse(raw) as typeof grant;
  } catch {
    return null;
  }
  if (!grant || typeof grant.s !== "string" || typeof grant.e !== "string") return null;
  const off = repliesFor(await redisPipeline([["EXISTS", offKey(grant.s, grant.e)]]), 1)?.[0];
  if (off !== 0 && off !== 1) throw new UnknownReplyError("whether an address stopped a store's update emails");
  return { email: grant.e, storeName: typeof grant.n === "string" ? grant.n : "", stopped: off === 1, handle: typeof grant.h === "string" ? grant.h : "" };
}

/**
 * Stops every update email from that store to that address, for good. Safe to press twice. False only when the link is
 * confirmed not there (an exact nil) or its record is not a stop link's; a reply cut short or of another shape, or a
 * stop whose write is not confirmed, throws (CX-123 rule 24), and the unsubscribe route answers "try again", never
 * "Not found.".
 */
export async function stopUpdates(token: string): Promise<boolean> {
  if (!UPDATE_STOP.test(token) || !isRedisConfigured()) return false;
  const read = repliesFor(await redisPipeline([["GET", stopKey(token)]]), 1);
  if (!read || (read[0] !== null && typeof read[0] !== "string")) throw new UnknownReplyError("an update stop link");
  const raw = read[0];
  if (raw === null || !raw) return false;
  let grant: { s?: unknown; e?: unknown; h?: unknown };
  try {
    grant = JSON.parse(raw) as typeof grant;
  } catch {
    return false;
  }
  if (!grant || typeof grant.s !== "string" || typeof grant.e !== "string") return false;
  // Kept for good, so counted in the store's room at what it adds (lib/order-data.ts).
  const store = typeof grant.h === "string" && grant.h ? await storeForHandle(grant.h).catch(() => null) : null;
  const written = repliesFor(await orderWrite(store && store.statsId === grant.s ? store : { statsId: grant.s }, [["SET", offKey(grant.s, grant.e), new Date().toISOString()]]), 1);
  if (!written || written[0] !== "OK") throw new UnknownReplyError("an update stop's write");
  return true;
}
