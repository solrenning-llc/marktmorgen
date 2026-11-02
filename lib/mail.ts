/**
 * Email from a creator to their list: how it looks, who it is from, what it
 * must carry, and how much a store may send.
 *
 * Every email carries, whatever the creator writes:
 *   - who it is from, by the creator's own name, with replies going to them;
 *   - why the reader is getting it;
 *   - an unsubscribe link that works in one press, and the header that lets
 *     a mail app offer the same thing;
 *   - the creator's postal address, which the law in the United States asks
 *     of every commercial email.
 *
 * Only people who agreed are ever written to (lib/contacts.ts), and a month
 * has a published number of emails, counted before each batch goes out.
 */
import { bodyHtml, bodyText } from "@/lib/mail-body";
import { lookColours } from "@/lib/store-look";
import { NIMBUS_FROM, type BatchMessage, hasResend, sendListBatch, sendEmail, sentThisMonth } from "@/lib/email";
import { isSesConfigured, sesBulkRoom, sesReady } from "@/lib/ses";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { TRIAL_MONTHLY_EMAILS, canUse, monthlyEmails } from "@/lib/plan";
import { tokensFor } from "@/lib/contacts";
import { SITE_URL } from "@/lib/site-url";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { calendarWindow, windowId } from "@/lib/allowance-window";
import { reservePaidResourceWindow } from '@/lib/contract-resource-window';
import { admitNonPaying } from "@/lib/free-pool";
import type { Store } from "@/lib/store";
import { creatorAddress } from "@/lib/mail-from";
import { type MailTag, taggedLink } from "@/lib/mail-links";
import { rememberLinkKeys } from "@/lib/mail-clicks";
import { type Pause, healthId, healthTags, noteSent, pauseForSending, rampBack, rampRoom } from "@/lib/mail-health";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";

export const MAX_SUBJECT = 150;
export const MAX_MAIL_BODY = 20_000;
/** How many go in one request to the sender. */
export const BATCH_SIZE = 100;
/**
 * How many go in one request when each person is first checked against the
 * creator's Stripe account (community announcements, live events'
 * reminders): a checked batch is the five-minute job's unit of work, and it
 * starts none after its mark (app/api/cron/mail), so a smaller one keeps a
 * run inside its sixty seconds — 25 checks, five at a time, is a few
 * seconds even when none is cached. The batch boundaries stay fixed, so a
 * batch tried again carries the same key and is never sent twice.
 */
export const CHECKED_BATCH_SIZE = 25;

/** The address marketing email is sent from; the name in front is the creator's. */
function marketingAddress(): string {
  const configured = process.env.MARKETING_FROM_EMAIL?.trim() || NIMBUS_FROM;
  const match = configured.match(/<([^>]+)>/);
  return (match ? match[1] : configured).trim();
}

function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A creator";
}

export function monthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
/**
 * A store's monthly emails, counted in its window: its billing month when it
 * pays us, the calendar month otherwise (lib/allowance-window.ts). A store
 * that pays and whose period is not known sends nothing that counts here.
 */
const usedKey = (listId: string, window: string) => `nl:mail:used:${listId}:${window}`;
const windowOf = (store: Store) => windowId(store);

/** Whether a store's pages may ask visitors to hear from the creator: Pro, and set up. */
export function canWrite(store: Store): boolean {
  return monthlyAllowance(store) > 0 && store.mail !== null && store.listId !== null;
}

/** What this store may send this month: 0 when it is not on Pro or above it. */
export function monthlyAllowance(store: Store, nowSeconds = Date.now() / 1000): number {
  if (!canUse(store, "email")) return 0;
  return store.trialEnds > nowSeconds ? TRIAL_MONTHLY_EMAILS : monthlyEmails(store.tier);
}

/** Whether the store is still in its free trial, when the smaller allowance applies. */
export function inTrial(store: Store, nowSeconds = Date.now() / 1000): boolean {
  return store.trialEnds > nowSeconds;
}

export async function usedThisMonth(listId: string | null, window: string | null = calendarWindow().id): Promise<number> {
  if (!listId || !window || !isRedisConfigured()) return 0;
  const [raw] = await redisPipeline([["GET", usedKey(listId, window)]]);
  return Number(raw) || 0;
}

/**
 * How many list emails the whole company may send in one UTC day.
 *
 * The sender is on its Pro plan (50,000 a month, no daily ceiling), so by
 * default there is no daily ceiling of ours either: 0 means none. If the
 * sender's plan ever has a daily ceiling again, shared with sign-in links and
 * receipts, MARKETING_DAILY_CAP keeps list email to a share of it, so those
 * always get through; a send that reaches it waits and continues the next day.
 */
const DEFAULT_DAILY_CAP = 0;
function dailyCap(): number {
  const raw = process.env.MARKETING_DAILY_CAP?.trim();
  if (!raw) return DEFAULT_DAILY_CAP;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_CAP;
}
const dayKey = (now = new Date()) => `nl:mail:day:${now.toISOString().slice(0, 10)}`;

/** How many more list emails the company may send today. */
async function dailyRoom(): Promise<number> {
  const cap = dailyCap();
  if (cap === 0) return Number.POSITIVE_INFINITY;
  try {
    const reply: unknown = await redisPipeline([["GET", dayKey()]]);
    if (!Array.isArray(reply)) return 0;
    const length = Object.getOwnPropertyDescriptor(reply, "length");
    const field = Object.getOwnPropertyDescriptor(reply, "0");
    if (!length || !("value" in length) || length.value !== 1 ||
        !field || !("value" in field)) return 0;
    // Only explicit absence means no emails used; unknown data grants no room.
    if (field.value === null) return cap;
    if (typeof field.value !== "string") return 0;
    const used = confirmedCount(field.value, 0);
    return used === null ? 0 : Math.max(0, cap - used);
  } catch { return 0; }
}

/**
 * The sender's own ceiling, and the part of it list email may use.
 *
 * The sender sells a number of emails a month and lets an account run over
 * it, charged by the thousand, up to five times that number. At five times
 * it pauses the whole account (resend.com/docs/knowledge-base/
 * account-quotas-and-limits, read October 6, 2026). The whole account is
 * every email this site sends: a creator's newsletter, and also the link
 * somebody logs in with and the email that hands a buyer their file. So a
 * few stores with large lists could, with nobody doing anything wrong, stop
 * every creator from logging in.
 *
 * List email is therefore held back at four fifths of that ceiling, counted
 * across every kind of email sent this month (lib/email.ts), and the last
 * fifth is left for the emails a store cannot run without. Held back, not
 * dropped: a send that meets the limit waits and goes on by itself when the
 * sender's plan is raised or the month turns.
 *
 * SENDER_MONTHLY_QUOTA is the number on the sender's plan, 50,000 on the one
 * this was written under; it is set on the host when that plan changes.
 */
const SENDER_PLAN_EMAILS = 50_000;
const SENDER_PAUSES_AT = 5;
const LIST_SHARE = 0.8;

export function senderQuota(): number {
  const n = Number(process.env.SENDER_MONTHLY_QUOTA?.trim());
  return Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : SENDER_PLAN_EMAILS;
}

/** How many emails of every kind may have gone this month before list email waits. */
export function listCeiling(): number {
  return Math.floor(senderQuota() * SENDER_PAUSES_AT * LIST_SHARE);
}

/**
 * How many more list emails there is room for, now, between the two senders
 * (lib/email.ts): what is left of Resend's month under the ceiling above,
 * and, when Amazon may be used, what is left of the share of Amazon's 24
 * hours that email sent many at a time may take (lib/ses.ts). Amazon's own
 * number is read from Amazon, and grows as the account proves itself.
 */
export async function senderRoom(listOnly = false): Promise<number> {
  if (listOnly) {
    const state = isSesConfigured() ? await sesReady() : null;
    return state ? (await sesBulkRoom(state)) ?? 0 : 0;
  }
  const resendUsed = hasResend() ? await sentThisMonth() : 0;
  // Zero admission when usage is unknown, not a claim of zero usage.
  if (resendUsed === null) return 0;
  const resend = hasResend() ? Math.max(0, listCeiling() - resendUsed) : 0;
  const amazon = isSesConfigured() ? await sesReady() : null;
  if (!amazon) return resend;
  const room = await sesBulkRoom(amazon);
  // Zero available admission is conservative, not a claim of zero usage.
  return room === null ? 0 : resend + room;
}

const toldKey = (now = new Date()) => `nl:sender:${now.toISOString().slice(0, 7)}:told`;

/**
 * Says so, once a month, to the site's own inbox: raising the sender's plan
 * is a payment, and nobody but the owner can make one. Everything else about
 * the limit looks after itself.
 */
async function tellSenderIsFull(): Promise<void> {
  try {
    const key = toldKey();
    const read: unknown = await redisPipeline([["GET", key]]);
    if (!Array.isArray(read)) return;
    const length = Object.getOwnPropertyDescriptor(read, "length");
    if (!length || !("value" in length) || length.value !== 1) return;
    const previous = Object.getOwnPropertyDescriptor(read, "0");
    if (!previous || !("value" in previous) || previous.value !== null) return;
    // One canonical payload for the period, including retries through a
    // different admission route. Changing usage must not change its receipt.
    const accepted = await sendEmail({ idempotencyKey: key, meter: { by: "company" },
      from: NIMBUS_FROM,
      to: SUPPORT_EMAIL,
      subject: "List email is waiting for Amazon SES",
      text: [
        "Creator list email sends only through Amazon SES.",
        "Sending waits until availability can be confirmed.",
        "Account settings, sending capacity or usage may need attention. This notice does not identify the current cause or confirm delivery.",
        "Service email can use Resend only while the account review, credential binding and paid fallback quota are confirmed. Missing proof blocks that route.",
        "Sign-in links, receipts and deliveries keep their existing sending route.",
        "Availability is checked again automatically. Check account status and sending usage in the providers' consoles before considering a plan change.",
      ].join("\n"),
    });
    // One additional command after acceptance; no mark for false/unknown.
    if (accepted === true) await redisPipeline([["SET", key, "1", "NX", "EX", 40 * 86_400]]);
  } catch (error) {
    console.error("telling the inbox the sender is nearly full failed", error);
  }
}

/** Whether `n` more list emails fit under the sender's ceiling; says so once when they do not. */
async function senderTakes(n: number, listOnly = false): Promise<boolean> {
  if ((await senderRoom(listOnly)) >= n) return true;
  await tellSenderIsFull();
  return false;
}

export type Reserved = "ok" | "month" | "day" | "sender" | "unavailable";

function confirmedCount(raw: unknown, minimum: number): number | null {
  if ((typeof raw !== "string" && typeof raw !== "number") || (typeof raw === "string" && !/^(0|[1-9][0-9]*)$/.test(raw))) return null;
  const value=Number(raw);
  return Number.isSafeInteger(value) && value>=minimum ? value : null;
}

/**
 * Takes `n` from the company's day only (MARKETING_DAILY_CAP), for a bulk
 * notice that is not a creator's list email but goes out from the same
 * sender — the one email to buyers brought over from another platform
 * (lib/imports.ts). False, and nothing taken, when it would pass the cap.
 */
export async function reserveDay(n: number): Promise<boolean> {
  if (!Number.isSafeInteger(n) || n<0) return false;
  if (n===0) return true;
  if (!isRedisConfigured()) return false;
  try {
    if (!(await senderTakes(n))) return false;
    const cap=dailyCap();
    if(cap===0)return true;
    const day=dayKey();
    const result=await redisPipeline([["INCRBY",day,n],["EXPIRE",day,3*86400]]);
    if(result.length!==2 || result[1]!==1)return false;
    const today=confirmedCount(result[0],n);
    if(today===null)return false;
    if(today<=cap)return true;
    await redisPipeline([["DECRBY",day,n]]);
    return false;
  } catch { return false; }
}

/** Gives back what reserveDay took, for a send that did not go out. */
export async function releaseDay(n: number): Promise<void> {
  if (dailyCap() === 0 || n <= 0) return;
  await redisPipeline([["DECRBY", dayKey(), n]]);
}

/** Takes `n` from the month (and the company's day), or nothing when that would pass either. */
export async function reserve(store: Store, n: number, listOnly = false): Promise<Reserved> {
  if (!Number.isSafeInteger(n) || n<0) return "month";
  if(n===0)return "ok";
  if(!store.listId)return "month";
  if(!isRedisConfigured())return "unavailable";
  const window=windowOf(store);
  if(!window)return "month";
  // A free trial's emails go out only while it holds one of the month's places (lib/free-pool-rules.ts).
  if(!(await admitNonPaying(store)))return "month";
  const allowance=monthlyAllowance(store);
  if(!Number.isSafeInteger(allowance) || allowance<0 || n>allowance)return "month";
  if(store.period?.funded===true && !(await reservePaidResourceWindow(store)))return "unavailable";
  try {
    const key=usedKey(store.listId,window),cap=dailyCap(),day=dayKey();
    if(!listOnly) {
      if(!(await senderTakes(n)))return "sender";
      const results=await redisPipeline([["INCRBY",key,n],["EXPIRE",key,70*86400],["INCRBY",day,n],["EXPIRE",day,3*86400]]);
      if(results.length!==4 || results[1]!==1 || results[3]!==1)return "unavailable";
      const total=confirmedCount(results[0],n),today=confirmedCount(results[2],n);
      if(total===null || today===null)return "unavailable";
      const overMonth=total>allowance,overDay=cap>0 && today>cap;
      if(!overMonth && !overDay)return "ok";
      await redisPipeline([["DECRBY",key,n],["DECRBY",day,n]]);
      return overMonth?"month":"day";
    }
    // No SES setup is a known sender wait and needs no temporary ledger work.
    if(!isSesConfigured()) {
      await senderTakes(n, true);
      return "sender";
    }
    // For list delivery, reserve the local limits before reading provider
    // capacity. A known month/day wait needs no SES 24-hour usage read.
    const results=await redisPipeline([["INCRBY",key,n],["EXPIRE",key,70*86400],["INCRBY",day,n],["EXPIRE",day,3*86400]]);
    // A missing acknowledgement may still have consumed capacity. Never
    // refund it or dispatch a provider call on an ambiguous response.
    if(results.length!==4 || results[1]!==1 || results[3]!==1)return "unavailable";
    const total=confirmedCount(results[0],n),today=confirmedCount(results[2],n);
    if(total===null || today===null)return "unavailable";
    const overMonth=total>allowance,overDay=cap>0 && today>cap;
    if(overMonth || overDay) {
      await redisPipeline([["DECRBY",key,n],["DECRBY",day,n]]);
      return overMonth?"month":"day";
    }
    if(!(await senderTakes(n, true))) {
      // No provider was attempted, so the confirmed reservation returns.
      await redisPipeline([["DECRBY",key,n],["DECRBY",day,n]]);
      return "sender";
    }
    return "ok";
  } catch { return "unavailable"; }
}

/**
 * Takes up to `n` from the store's monthly emails alone (the company's day is
 * the caller's to take): answers how many may go. For the emails that are
 * not to the list but still cost one email each and come from a plan with an
 * allowance: the one email to each buyer or member brought over from another
 * platform (lib/imports.ts) and a workflow's notice to the owner
 * (lib/flows.ts). Added 17 October 2026 so those are inside the monthly
 * emails each plan's worst month already counts (tests/plan-cost-registry.ts).
 * Zero when the store has no allowance or the count cannot be written.
 */
export async function takeFromMonth(store: Store, n: number): Promise<number> {
  if (!Number.isSafeInteger(n) || n <= 0 || !store.listId || !isRedisConfigured()) return 0;
  const allowance = monthlyAllowance(store);
  const window = windowOf(store);
  if (!Number.isSafeInteger(allowance) || allowance <= 0 || !window) return 0;
  if (!(await admitNonPaying(store))) return 0;
  if (store.period?.funded===true && !(await reservePaidResourceWindow(store))) return 0;
  try {
    const key = usedKey(store.listId, window);
    const results = await redisPipeline([["INCRBY", key, n], ["EXPIRE", key, 70 * 86400]]);
    const total = confirmedCount(results[0], n);
    if (results.length !== 2 || total === null) return 0;
    const over = Math.min(n, Math.max(0, total - allowance));
    if (over > 0) await redisPipeline([["DECRBY", key, over]]);
    return n - over;
  } catch {
    return 0;
  }
}

/** Gives back to the store's month what takeFromMonth took for emails that did not go. */
export async function giveBackToMonth(store: Store, n: number): Promise<void> {
  const window = windowOf(store);
  if (store.listId && window && Number.isSafeInteger(n) && n > 0) await redisPipeline([["DECRBY", usedKey(store.listId, window), n]]);
}

/** Gives back what was taken for a batch that was not sent. */
export async function release(store: Store, n: number): Promise<void> {
  const window = windowOf(store);
  if (store.listId && window && n > 0) {
    await redisPipeline([
      ["DECRBY", usedKey(store.listId, window), n],
      ["DECRBY", dayKey(), n],
    ]);
  }
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The creator's text as HTML, now kept with the designer that writes it (lib/mail-body.ts). */
export { bodyHtml };

export type Rendered = { subject: string; html: string; text: string; headers: Record<string, string> };

/**
 * The way out of an email that is not to the creator's list, such as the
 * announcements a community member asked for (lib/community-mail.ts): its
 * own page and one-click address, why the reader gets it, and what the link
 * stops.
 */
export type Door = {
  page: string;
  oneClick: string;
  why: string;
  label: string;
  after: string;
  /** The text version's line with the link, whole; "<label>: <page>" when left out. */
  line?: string;
  /** The last line, in the store's language; "Sent with Marktmorgen." when left out. */
  sent?: string;
  /** The language the email is written in, for its html element ("es-ES"). */
  lang?: string;
};

/** One email, for one reader, with everything it has to carry. */
export function render(
  store: Store,
  subject: string,
  body: string,
  token: string | null,
  door?: Door,
  tag?: MailTag,
  /** The reader's link key, when they allowed their link use to be seen (lib/mail-clicks.ts): their links carry it, and the foot says how to stop it. */
  readerKey?: string,
): Rendered {
  const fromName = store.mail?.fromName || store.name;
  const address = store.mail?.address ?? "";
  const unsub = door ? door.page : token ? `${SITE_URL}/unsubscribe?t=${token}` : `${SITE_URL}/@${store.handle}`;
  const oneClick = door ? door.oneClick : token ? `${SITE_URL}/api/mail/unsubscribe?t=${token}` : "";
  // The words the store adds around the creator's own, in the store's
  // language (lib/buyer-words/affiliates.ts); a door brings its own.
  const a = affiliatesWords(store.language);
  const why = door ? door.why : a.listWhy(fromName);
  const label = door ? door.label : a.footerUnsubscribe;
  const after = door ? door.after : a.footerUnsubscribeAfter(fromName);
  const sent = door?.sent ?? a.sentWith;
  // Said only in a sequence's email to somebody who allowed it, with the way to stop it.
  const counting = Boolean(readerKey && token && !door && tag?.medium === "sequence");
  const stopCounting = counting ? `${SITE_URL}/unsubscribe?l=${token}` : "";
  const html = `<!doctype html><html lang="${escape(door?.lang ?? LANGUAGES[parseLanguage(store.language)].locale)}"><body style="margin:0;padding:0;background:#f7f5f0">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1c1917">
<div style="background:#ffffff;border-radius:16px;padding:28px 24px">${bodyHtml(body, tag ? (href) => taggedLink(href, store, tag, counting ? readerKey : undefined) : undefined, store.look ? lookColours(store.look).accent : undefined)}</div>
<div style="padding:20px 8px 0;font-size:13px;line-height:1.5;color:#57534e">
<p style="margin:0 0 8px">${escape(why)}</p>
<p style="margin:0 0 8px"><a href="${escape(unsub)}" style="color:#57534e;text-decoration:underline">${escape(label)}</a> ${escape(after)}</p>
${counting ? `<p style="margin:0 0 8px">${escape(a.clicksOn(fromName))} <a href="${escape(stopCounting)}" style="color:#57534e;text-decoration:underline">${escape(a.clicksStop)}</a></p>` : ""}
${address ? `<p style="margin:0 0 8px">${escape(fromName)} · ${escape(address)}</p>` : ""}
<p style="margin:0">${escape(sent)}</p>
</div></div></body></html>`;
  const text = [
    bodyText(body).trim(),
    "",
    "—",
    why,
    door ? door.line ?? a.doorText(door.label, unsub) : a.unsubscribeText(unsub),
    counting ? `${a.clicksOn(fromName)} ${a.clicksStopText(stopCounting)}` : "",
    address ? `${fromName} · ${address}` : "",
    sent,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
  const headers: Record<string, string> = oneClick
    ? { "List-Unsubscribe": `<${oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : {};
  return { subject: subject.slice(0, MAX_SUBJECT), html, text, headers };
}

/**
 * Who a creator's email is from: their own name, and their own address on
 * the domain set apart for creators' email when there is one
 * (lib/mail-from.ts), so that what a reader thinks of it is never held
 * against the address login links and receipts come from.
 */
export function fromLine(store: Store): string {
  const address = creatorAddress(store.handle, NIMBUS_FROM) ?? marketingAddress();
  return `"${displayName(store.mail?.fromName || store.name)}" <${address}>`;
}

/**
 * The sender takes a few requests a second for the whole company, sign-in
 * links and receipts included. Marketing email keeps well under that, so
 * those always get through.
 */
const BATCH_GAP_MS = 1_500;
let lastBatchAt = 0;
async function paced(): Promise<void> {
  const wait = lastBatchAt + BATCH_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastBatchAt = Date.now();
}

export type SendOutcome = {
  /** Addresses the email went to. */
  done: string[];
  /** Addresses not tried, because the send stopped before them. */
  rest: string[];
  stopped: "allowance" | "day" | "sender" | "paused" | "portion" | "retry" | "refused" | null;
  /** Why and until when, for a send stopped as "paused" (lib/mail-health.ts). */
  pause?: Pause;
  /**
   * Addresses of a batch that was handed to the provider when the answer
   * came back as "retry": it may have been sent before the answer was lost.
   * Also in `rest`. Sequences hold these runs instead of sending again
   * (lib/flow-runs.ts); a broadcast records a terminal review notice instead
   * of retrying automatically after that checkpoint is confirmed.
   */
  uncertain?: string[];
};

/** What a send that met the sender's ceiling says in the studio. */
export const SENDER_WAIT_NOTE =
  "Waiting on our side: the service that sends our email has no confirmed room for this batch right now. The rest go out by themselves when room is confirmed. Nothing is lost.";

/**
 * Sends one email to each address, in batches. Stops at the first batch the
 * month cannot cover, or the sender will not take; anyone who has left the
 * list since is skipped.
 */
export async function sendTo(
  store: Store,
  emails: string[],
  subject: string,
  body: string,
  keyBase: string,
  /** Which email this is, so a sale from one of its links can be counted for it (lib/mail-links.ts). */
  tag?: MailTag,
): Promise<SendOutcome> {
  const done: string[] = [];
  // A store whose addresses turned out to be bad ones waits its week out
  // (lib/mail-health.ts). Nothing is taken from its month for it.
  const watched = healthId(store);
  const pause = await pauseForSending(watched);
  // A missing checkpoint is not evidence that this list is safe to send.
  if (pause === undefined) return { done, rest: emails, stopped: "retry" };
  if (pause) return { done, rest: emails, stopped: "paused", pause };
  const tags = healthTags(store, true);
  for (let i = 0; i < emails.length; ) {
    const room = await dailyRoom();
    if (room <= 0) return { done, rest: emails.slice(i), stopped: "day" };
    // A list with addresses lately brought in goes out in portions that
    // double (lib/mail-health.ts); for any other store this is every one asked for.
    const portion = await rampRoom(watched, Math.min(BATCH_SIZE, room, emails.length - i));
    if (portion <= 0) return { done, rest: emails.slice(i), stopped: "portion" };
    const chunk = emails.slice(i, i + portion);
    const reserved = await reserve(store, chunk.length, true);
    if (reserved !== "ok") {
      await rampBack(watched, chunk.length);
      return { done, rest: emails.slice(i), stopped: reserved === "month" ? "allowance" : reserved === "unavailable" ? "retry" : reserved };
    }
    // In a sequence, those who allowed their link use to be seen get links that say so (lib/mail-clicks.ts).
    const counting = tag?.medium === "sequence" ? new Set<string>() : undefined;
    const tokens = await tokensFor(store.listId as string, chunk, store.handle, counting);
    const keys = counting?.size ? await rememberLinkKeys([...counting].map((email) => tokens.get(email) ?? "")) : new Map<string, string>();
    const messages: BatchMessage[] = chunk
      .filter((email) => tokens.has(email))
      .map((email) => {
        const token = tokens.get(email)!;
        const r = render(store, subject, body, token, undefined, tag, counting?.has(email) ? keys.get(token) : undefined);
        return { from: fromLine(store), to: email, subject: r.subject, text: r.text, html: r.html, replyTo: store.email, headers: r.headers, tags };
      });
    if (messages.length) await paced();
    const outcome = await sendListBatch(messages, `${keyBase}:${i}:${chunk.length}`, { by: "monthly" });
    if (outcome === "waiting") {
      // This invocation made no provider send. Existing allowance/portion
      // reservations may be returned; unknown acceptance never uses this path.
      await release(store, chunk.length);
      await rampBack(watched, chunk.length);
      return { done, rest: emails.slice(i), stopped: "sender" };
    }
    if (outcome !== "sent") {
      // Dispatch may have succeeded before its acknowledgement was lost.
      // Keep attempted capacity reserved; retries consume new capacity.
      return { done, rest: emails.slice(i), stopped: outcome, ...(outcome === "retry" ? { uncertain: messages.map((m) => m.to) } : {}) };
    }
    if (messages.length < chunk.length) await release(store, chunk.length - messages.length);
    // What a bounce or a complaint is later measured against.
    await noteSent(watched, messages.length);
    for (const m of messages) done.push(m.to);
    i += chunk.length;
  }
  return { done, rest: [], stopped: null };
}
