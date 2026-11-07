/**
 * The one email that asks a buyer for a review, some days after they bought.
 *
 * Off for every store until its creator switches it on in the studio and
 * picks when it goes: 3 to 30 days after buying. It is email from the
 * creator to people, so it goes through the same sender and the same rules
 * as their other email (lib/mail.ts): Pro, a postal address in the footer,
 * the store's monthly allowance counted before it is sent, and a one-click
 * way to stop it (an unsubscribe link and the header that lets a mail app
 * offer the same), which keeps that address from being asked again by that
 * store. An address that left the creator's list is not asked either.
 *
 * What it will not do: ask twice about one order, ask about an order that
 * was refunded or has been reviewed already, or offer anything in return
 * for a review. The one exception to "once" is the creator's choice of one
 * reminder (636 [GL4](a)), 3 to 14 days after it, sent only when the order
 * is still not refunded, the buyer still may be written to and something in
 * it is still not reviewed; the first email says it will come, and the
 * reminder says it is the last. It asks for an honest one and says the review will show as
 * a verified purchase under a name the buyer chooses.
 *
 * Orders are put on the list when their purchase is confirmed
 * (lib/review-ask.ts). The five-minute job takes what is due, at most fifty
 * a run, and reads each order from Stripe again before writing, so a refund
 * made in the meantime is honoured. The delay is read when the email is due:
 * a creator who makes it longer moves the orders still waiting; one who
 * makes it shorter sends those at the old time.
 *
 *   nl:rev:ask:sent:<reference>    that order was asked ("sent:<seconds>", the time the first went out;
 *                                  "sent" alone before that time was kept), and reminded ("again"), 120 days
 *   nl:rev:off:<statsId>:<hash>    that address pressed stop, kept for good
 *   nl:rev:stop:<token>            who a stop link belongs to, 400 days
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { deriveKey } from "@/lib/secret-box";
import { normaliseEmail } from "@/lib/auth";
import { type BatchMessage, sendBatch } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { canWrite, fromLine, release, render, reserve } from "@/lib/mail";
import { leadsKey, parseContact } from "@/lib/contacts";
import { storeBase } from "@/lib/purchase-email";
import { SITE_URL } from "@/lib/site-url";
import { ASK_DUE_KEY, type AskEntry, againDueAt, dueAt, readAskMember } from "@/lib/review-ask";
import { mintReviewLink, provePurchase } from "@/lib/review-proof";
import { readReview, reviewId } from "@/lib/reviews";
import { REVIEW_SITES, parseReviewElsewhere } from "@/lib/review-elsewhere";
import { type Store, storeForHandle } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import { noteForErasure } from "@/lib/erasure-index";
import { orderWrite } from "@/lib/order-data";
// Kept apart from the reply helpers imported above by other work, so the two never collide by name.
import * as exactReply from "@/lib/redis-reply";
import { suppressedCommand } from "@/lib/suppression";

/** Orders looked at in one run of the job. */
export const MAX_ASKS_PER_RUN = 50;
/** An email this late after it was due is not sent at all: it would read like a mistake. */
export const LATE_SECONDS = 14 * 86_400;
/** How long a waiting order waits before it is looked at again. */
const RETRY_SECONDS = { plan: 6 * 3600, stripe: 3600, sender: 1800 };
const SENT_MARK_SECONDS = 120 * 86_400;
const STOP_LINK_SECONDS = 400 * 86_400;
export const REVIEW_STOP = /^[0-9a-f]{40}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sentKey = (reference: string) => `nl:rev:ask:sent:${reference}`;
const offKey = (statsId: string, email: string) => `nl:rev:off:${statsId}:${sha(`nimbus-review-off:${normaliseEmail(email)}`).slice(0, 32)}`;
const stopKey = (token: string) => `nl:rev:stop:${token}`;

/**
 * One stop link for each address a store writes to (since 18 October 2026),
 * the same in every email: so what the links keep is one record a buyer,
 * counted in the store's room when it is first made (lib/order-data.ts),
 * not one an email. Signed with a key of our own, so nobody can make the
 * link of an address; where no key is set, a new one each time, as before.
 */
function stopToken(statsId: string, email: string): string {
  const key = deriveKey("review-stop");
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

type StopGrant = { s: string; e: string; n?: unknown; h?: unknown };

/**
 * A stop link's grant, read from its GET reply only in its exact shape
 * (CX-123 rule 24, as lib/checkout-recovery.ts reads a reminder's): one
 * reply, text or nothing. Nothing, or text that is not a grant, is a link we
 * do not know (null); any other reply is unknown and throws, never "no such
 * link".
 */
function stopGrantOf(replies: unknown): StopGrant | null {
  const reply = exactReply.repliesFor(replies, 1);
  if (!reply || (reply[0] !== null && typeof reply[0] !== "string")) throw new exactReply.UnknownReplyError("a review stop link");
  const raw = reply[0];
  if (!raw) return null;
  try {
    const grant = JSON.parse(raw) as unknown;
    if (!grant || typeof grant !== "object") return null;
    const { s, e, n, h } = grant as { s?: unknown; e?: unknown; n?: unknown; h?: unknown };
    return typeof s === "string" && typeof e === "string" && s && e ? { s, e, n, h } : null;
  } catch {
    return null;
  }
}

/** Who a stop link belongs to, without acting on it. Throws when Redis answers in an unknown shape. */
export async function readReviewStop(token: string): Promise<{ email: string; storeName: string; stopped: boolean; handle: string } | null> {
  if (!REVIEW_STOP.test(token) || !isRedisConfigured()) return null;
  const grant = stopGrantOf(await redisPipeline([["GET", stopKey(token)]]));
  if (!grant) return null;
  // The stop mark is there (1) or not (0); anything else is unknown, never "not stopped".
  const off = exactReply.repliesFor(await redisPipeline([["EXISTS", offKey(grant.s, grant.e)]]), 1);
  const count = off ? exactReply.countOf(off[0]) : null;
  if (count !== 0 && count !== 1) throw new exactReply.UnknownReplyError("a review stop mark");
  // The store's handle, so the page can speak the store's language.
  const handle = typeof grant.h === "string" ? grant.h : "";
  return { email: grant.e, storeName: typeof grant.n === "string" ? grant.n : "", stopped: count === 1, handle };
}

/**
 * Stops every review request from that store to that address, for good.
 * Safe to press twice. True only when the stop mark's write answered "OK";
 * a reply of any other shape, or a write that failed, throws, never
 * "stopped" and never "no such link" (CX-123 rule 24).
 */
export async function stopReviewRequests(token: string): Promise<boolean> {
  if (!REVIEW_STOP.test(token) || !isRedisConfigured()) return false;
  const grant = stopGrantOf(await redisPipeline([["GET", stopKey(token)]]));
  if (!grant) return false;
  // Kept for good, so counted in the store's room at what it adds (lib/order-data.ts).
  const store = typeof grant.h === "string" && grant.h ? await storeForHandle(grant.h).catch(() => null) : null;
  const written = exactReply.repliesFor(
    await orderWrite(store && store.statsId === grant.s ? store : { statsId: grant.s }, [["SET", offKey(grant.s, grant.e), new Date().toISOString()]]),
    1,
  );
  if (!written || written[0] !== "OK") throw new exactReply.UnknownReplyError("a review stop mark");
  return true;
}

/** The words of the email, for one order and the products in it not reviewed yet, in the store's language. `stage` "again" is the one reminder. */
export function requestText(store: Store, titles: string[], paidAt: number, link: string, stage: "first" | "again" = "first"): { subject: string; body: string } {
  const name = store.mail?.fromName || store.name;
  const g = givingWords(store.language);
  const what = titles.length === 1 ? titles[0] : g.listAnd(titles.slice(0, -1).join(", "), titles[titles.length - 1]);
  // The creator's public review page, the same in every request (lib/review-elsewhere.ts): read again here, never trusted as stored.
  const elsewhere = parseReviewElsewhere(store.reviewAsk.elsewhere?.url);
  return {
    subject: (stage === "again" ? g.againSubject(titles[0]) : g.askSubject(titles[0])).slice(0, 150),
    body: [
      (stage === "again" ? g.againLead : g.askLead)(what, name, speech(store).date(paidAt * 1000)),
      "",
      g.askHow,
      link,
      ...(elsewhere ? ["", g.askElsewhere(name, REVIEW_SITES[elsewhere.site].name), elsewhere.url] : []),
      "",
      g.askShows(name),
      "",
      stage === "again" ? g.againOnly : store.reviewAsk.again ? g.askOneMore(store.reviewAsk.again) : g.askOnly,
    ].join("\n"),
  };
}

export type AskCounts = { sent: number; dropped: number; waiting: number };

/**
 * Which email an order is due for, from its mark: the first when it has none,
 * the one reminder when the first was sent and the creator chose a reminder,
 * and nothing otherwise (being sent, reminded already, or no reminder).
 */
export function askStage(mark: unknown, again: number | undefined): "first" | "again" | null {
  if (mark === null || mark === undefined) return "first";
  return (mark === "sent" || firstSentAt(mark) > 0) && again ? "again" : null;
}

/**
 * When the first email of an order went out, from its mark ("sent:<seconds>");
 * 0 for a mark kept before that time was (plain "sent") or anything else.
 */
export function firstSentAt(mark: unknown): number {
  const found = typeof mark === "string" ? /^sent:(\d{1,12})$/.exec(mark) : null;
  return found ? Number(found[1]) : 0;
}

/**
 * When an order's email is due. The first: its delay after the purchase. The
 * reminder: its days after the first actually went out, as the first email
 * promises ("If you have not reviewed it N days from now"), and never before
 * its days after the first's due day; a first held back (the plan, Stripe,
 * the allowance or the sender) therefore never brings the reminder closer.
 */
export function askDueAt(stage: "first" | "again", mark: unknown, paidAt: number, ask: { days: number; again?: number }): number {
  if (stage === "first") return dueAt(paidAt, ask.days);
  const again = ask.again ?? 0;
  return Math.max(againDueAt(paidAt, ask.days, again), firstSentAt(mark) + again * 86_400);
}

/**
 * What is written once a batch went out: each order's mark ("sent" after the
 * first, "again" after the reminder), and, after a first, the order back on
 * the list at its reminder's time when there is one, or off it when not.
 */
export function afterSent(
  items: { reference: string; member: string; paidAt: number; stage: "first" | "again" }[],
  ask: { days: number; again?: number },
  sentAt: number,
): (string | number)[][] {
  const again = ask.again ?? 0;
  const firsts = items.filter((item) => item.stage === "first");
  const mark = `sent:${Math.floor(sentAt)}`;
  return [
    ...items.map((item) => ["SET", sentKey(item.reference), item.stage === "again" ? "again" : mark, "EX", SENT_MARK_SECONDS]),
    ...(again ? firsts.map((item) => ["ZADD", ASK_DUE_KEY, "XX", askDueAt("again", mark, item.paidAt, ask), item.member]) : []),
    ...(!again && firsts.length ? [["ZREM", ASK_DUE_KEY, ...firsts.map((item) => item.member)]] : []),
  ];
}

type Ready = { entry: AskEntry; member: string; message: BatchMessage; stage: "first" | "again" };

/**
 * Sends the review requests that are due, until the deadline or fifty
 * orders, whichever comes first. Safe to run from two places: each order is
 * claimed before it is sent.
 */
export async function sendReviewRequests(
  load: (handle: string) => Promise<Store | null>,
  deadline: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AskCounts> {
  const counts: AskCounts = { sent: 0, dropped: 0, waiting: 0 };
  if (!isRedisConfigured()) return counts;
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", ASK_DUE_KEY, 0, nowSeconds, "LIMIT", 0, MAX_ASKS_PER_RUN]]);
  const members = Array.isArray(raw) ? (raw as string[]) : [];
  const stores = new Map<string, Store | null>();
  const groups = new Map<string, { store: Store; ready: Ready[] }>();
  const drop = async (member: string) => {
    counts.dropped += 1;
    await redisPipeline([["ZREM", ASK_DUE_KEY, member]]);
  };
  const later = async (member: string, at: number) => {
    counts.waiting += 1;
    await redisPipeline([["ZADD", ASK_DUE_KEY, "XX", at, member]]);
  };

  for (const member of members) {
    if (Date.now() >= deadline) break;
    const entry = readAskMember(member);
    if (!entry) {
      await drop(member);
      continue;
    }
    if (!stores.has(entry.handle)) stores.set(entry.handle, await load(entry.handle).catch(() => null));
    const store = stores.get(entry.handle) ?? null;
    if (!store || store.statsId !== entry.statsId || !store.reviewAsk.days) {
      await drop(member);
      continue;
    }
    // Asked already: only the one reminder may follow, when the creator chose it; anything else is done.
    const [mark] = await redisPipeline([["GET", sentKey(entry.reference)]]);
    const stage = askStage(mark, store.reviewAsk.again);
    if (!stage) {
      await drop(member);
      continue;
    }
    const due = askDueAt(stage, mark, entry.paidAt, store.reviewAsk);
    if (due > nowSeconds) {
      await later(member, due);
      continue;
    }
    if (nowSeconds - due > LATE_SECONDS) {
      await drop(member);
      continue;
    }
    if (!canWrite(store)) {
      await later(member, nowSeconds + RETRY_SECONDS.plan);
      continue;
    }
    const proof = await provePurchase(store, entry.reference);
    if (proof.state === "error") {
      await later(member, nowSeconds + RETRY_SECONDS.stripe);
      continue;
    }
    if (proof.state !== "ok" || proof.proof.refunded) {
      await drop(member);
      continue;
    }
    const email = proof.proof.email;
    const checks = await redisPipeline([
      ["EXISTS", offKey(entry.statsId, email)],
      store.listId ? ["HGET", leadsKey(store.listId), normaliseEmail(email)] : ["EXISTS", "nl:none"],
      suppressedCommand(store.listId, email),
    ]).catch(() => null);
    const recipient = reviewRecipientState(checks, Boolean(store.listId));
    if (recipient === "unknown") {
      await later(member, nowSeconds + RETRY_SECONDS.stripe);
      continue;
    }
    // Nobody who pressed stop, left the list, or was deleted from the store (lib/suppression.ts).
    if (recipient === "stopped") {
      await drop(member);
      continue;
    }
    const open = [];
    for (const product of proof.proof.products) {
      if (!(await readReview(entry.statsId, product.id, reviewId(entry.statsId, product.id, email)))) open.push(product);
    }
    if (open.length === 0) {
      await drop(member);
      continue;
    }
    // Claimed before anything is sent, so two runs never send one email twice: the first by its mark,
    // the reminder by taking the order off the list (only one run takes it).
    if (stage === "first") {
      const [claimed] = await redisPipeline([["SET", sentKey(entry.reference), "sending", "NX", "EX", SENT_MARK_SECONDS]]);
      if (claimed === null) {
        await drop(member);
        continue;
      }
    } else {
      const [taken] = await redisPipeline([["ZREM", ASK_DUE_KEY, member]]);
      if (Number(taken) !== 1) continue;
    }
    const token = await mintReviewLink(store, entry.reference, email);
    const stop = await stopLink(store, email);
    const fromName = store.mail?.fromName || store.name;
    const words = requestText(store, open.map((p) => p.title), entry.paidAt, `${storeBase(store)}/review?ask=${token}`, stage);
    const g = givingWords(store.language);
    const page = `${SITE_URL}/unsubscribe?v=${stop}`;
    const r = render(store, words.subject, words.body, null, {
      page,
      oneClick: `${SITE_URL}/api/mail/unsubscribe?v=${stop}`,
      why: g.askWhy(fromName),
      label: g.askStopLabel,
      after: g.askStopAfter(fromName),
      line: g.askStopLine(page),
      sent: g.sentWith,
      lang: speech(store).lang.locale,
    });
    const group = groups.get(entry.handle) ?? { store, ready: [] };
    group.ready.push({
      entry,
      member,
      stage,
      message: { from: fromLine(store), to: email, subject: r.subject, text: r.text, html: r.html, replyTo: store.email, headers: r.headers },
    });
    groups.set(entry.handle, group);
  }

  for (const { store, ready } of groups.values()) {
    // Undone when nothing was sent: the first's mark goes, the reminder goes back on the list.
    const unclaim = async (at: number | null) => {
      const firsts = ready.filter((item) => item.stage === "first");
      const agains = ready.filter((item) => item.stage === "again");
      await redisPipeline([
        ...firsts.map((item) => ["DEL", sentKey(item.entry.reference)]),
        ...(at === null ? [] : agains.map((item) => ["ZADD", ASK_DUE_KEY, at, item.member])),
      ]);
      if (at !== null) for (const item of firsts) await later(item.member, at);
      counts.waiting += at === null ? 0 : agains.length;
    };
    const reserved = await reserve(store, ready.length);
    if (reserved !== "ok") {
      await unclaim(nowSeconds + RETRY_SECONDS.plan);
      continue;
    }
    const outcome = await sendBatch(
      ready.map((item) => item.message),
      `review-ask:${sha(ready.map((item) => item.entry.reference).join(","))}`, { by: "monthly" },
    );
    if (outcome !== "sent") {
      await release(store, ready.length);
      if (outcome === "refused") {
        await unclaim(null);
        for (const item of ready) await drop(item.member);
      } else {
        await unclaim(nowSeconds + RETRY_SECONDS.sender);
      }
      continue;
    }
    // After the first, the order waits on the list for its one reminder, when the creator chose one.
    await redisPipeline(afterSent(ready.map((item) => ({ reference: item.entry.reference, member: item.member, paidAt: item.entry.paidAt, stage: item.stage })), store.reviewAsk, nowSeconds));
    counts.sent += ready.length;
  }
  return counts;
}

/** A missing/malformed opt-out or erasure response never grants permission to send. */
function reviewRecipientState(checks: unknown, hasList: boolean): "unknown" | "stopped" | "open" {
  if (!Array.isArray(checks) || checks.length !== 3) return "unknown";
  for (let i = 0; i < 3; i++) if (!Object.hasOwn(checks, i)) return "unknown";
  const [off, raw, erased] = checks;
  if ((off !== 0 && off !== 1) || (erased !== 0 && erased !== 1)) return "unknown";
  let unsubscribed = false;
  if (hasList) {
    if (raw !== null) {
      if (typeof raw !== "string") return "unknown";
      try {
        const value: unknown = JSON.parse(raw);
        // Legacy contacts can omit unsub; a present value must be boolean.
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            ("unsub" in value && typeof value.unsub !== "boolean")) return "unknown";
      } catch { return "unknown"; }
      const contact = parseContact(raw);
      if (!contact) return "unknown";
      unsubscribed = contact.unsub;
    }
  } else if (raw !== 0 && raw !== 1) return "unknown";
  return off === 1 || unsubscribed || erased === 1 ? "stopped" : "open";
}

