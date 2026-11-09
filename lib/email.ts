/**
 * The one place that sends email.
 *
 * Everything that needs to reach an inbox goes through here, so there is a
 * single answer to "is sending switched on?" and a single place that knows
 * who sends.
 *
 * There are two senders. Amazon SES is the cheaper by nine times (lib/ses.ts
 * has the prices and the date they were read), and is used whenever Amazon
 * says the account may write to the public. Resend is the one this site
 * started on. Fallback requires a reviewed account-wide paid budget for both
 * sent and received emails; missing proof reports unavailability. Durable
 * order work waits for SES above that fallback quota. An uncertain once-only claim
 * holds both senders and reports failure instead of risking a second send.
 *
 * Nobody chooses between them by hand. Which one sends is decided here, for
 * each email, from what Amazon last said.
 */
import { createHash, randomBytes } from "node:crypto";
import { currentResendFallbackProofIsMissing, guardedResendPost, type ResendTransportRuntime } from "@/lib/resend-fallback-transport";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { atSiteAddress, creatorDomain, domainOf } from "@/lib/mail-from";
import { countSesSent, isSesConfigured, notYetTaken, sesBatch, sesBulkRoom, sesConfig, sesDown, sesReady, sesSend } from "@/lib/ses";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { type AllowanceStore, takeAllowance } from "@/lib/store-allowance";
import { allowanceWindow } from "@/lib/allowance-window";
import type { ShipmentMailDispatch } from "@/lib/shipment-mail-outbox";
import { repliesFor } from "@/lib/redis-reply";

/**
 * What an email is counted against (added 17 October 2026), said by every
 * call that sends one, so no email leaves without a figure that bounds it
 * (tests/plan-cost-registry.ts, EMAIL_SITES, holds each file to the meters
 * it may name):
 *
 *   company  from us to a creator about their own account or plan: sign-in,
 *            security, plan and usage notices, the scheduled reports. Bounded
 *            by the account and by the jobs' schedules: a company cost.
 *   order    one of an order's two emails (its confirmation, and that it
 *            shipped or was delivered), inside each order's cost.
 *   monthly  taken from the store's monthly emails before it is sent
 *            (lib/mail.ts reserve or takeFromMonth, or imports' own).
 *   store    taken here, before it goes, from the store's window: its emails
 *            ("email") or its buyers' access emails ("transactional")
 *            (lib/store-allowance-rules.ts). One that does not fit is not sent.
 *            `asked`: a confirmation to an address a visitor typed, which may
 *            use only part of the access emails (ASKED_SHARE_BPS), so a
 *            stranger cannot spend the links buyers are sent.
 */
export type EmailMeter =
  | { by: "company" }
  | { by: "order" }
  | { by: "monthly" }
  | { by: "store"; store: AllowanceStore; kind: "email" | "transactional"; asked?: boolean };

/** A funded cohort must be admitted even before a provider usage read. */
async function meterCohortReady(meter: EmailMeter): Promise<boolean> {
  if (meter.by !== "store") return true;
  if (meter.store.period?.funded===true && (!meter.store.tier || !(await reservePaidResourceWindow({...meter.store,tier:meter.store.tier,statsId:meter.store.statsId??null})))) return false;
  return true;
}

/** Takes a store's figure for `n` emails before they go; true for the meters already counted elsewhere. */
async function metered(meter: EmailMeter, n: number): Promise<boolean> {
  if (!(await meterCohortReady(meter))) return false;
  return takeMeteredAllowance(meter, n);
}
async function takeMeteredAllowance(meter: EmailMeter, n: number): Promise<boolean> {
  if (meter.by !== "store") return true;
  const taken = await takeAllowance(meter.store, meter.kind, n, Date.now(), meter.asked === true);
  if (!taken.ok) console.error(`an email was not sent: the store's ${meter.kind} figure (${taken.reason})`);
  return taken.ok;
}

type MeterAuthorization = { preflight: () => Promise<boolean>; beforePost: () => Promise<boolean> };
/** Memoize only the debit of this invocation's original store/window. A
 * later variant must still prove current funding and the SAME window.
 * Refusal/throw/unknown stays sticky; this is not a durable retry receipt. */
function lazyMeter(meter: EmailMeter, n: number): MeterAuthorization {
  const selected: EmailMeter = meter.by === "store" ? { ...meter, store: { ...meter.store,
    ...(meter.store.period ? { period: { ...meter.store.period } } : {}),
  } } : { ...meter };
  const original = selected.by === "store" ? allowanceWindow(selected.store) : null;
  let debit: Promise<boolean> | undefined, refused = false;
  const sameWindow = () => {
    if (selected.by !== "store") return true;
    const current = allowanceWindow(selected.store);
    return Boolean(original && current && current.id === original.id && current.start === original.start &&
      current.end === original.end && current.billing === original.billing);
  };
  const preflight = async () => {
    if (refused) return false;
    try {
      if (sameWindow() && await meterCohortReady(selected) && sameWindow()) return true;
    } catch { /* No new debit may follow unknown authorization. */ }
    refused = true;
    return false;
  };
  return { preflight, beforePost: async () => {
    if (!(await preflight())) return false;
    try {
      debit ??= takeMeteredAllowance(selected, n);
      if (await debit === true && sameWindow()) return true;
    } catch { /* Keep the rejected debit promise and any committed effect. */ }
    refused = true;
    return false;
  } };
}

// Local tests may point this at a mock server on 127.0.0.1; nothing else is
// accepted, so a test can never reach the real sender.
const BASE = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.RESEND_API_BASE ?? "")
  ? `${process.env.RESEND_API_BASE}`
  : "https://api.resend.com";

/** Where the sender's API is, for the one other file that reads from it (lib/inbound-mail.ts). */
export const RESEND_BASE = BASE;

export const NIMBUS_FROM =
  process.env.NIMBUS_FROM_EMAIL?.trim() || "Marktmorgen <onboarding@resend.dev>";

export const STORE_FROM =
  process.env.RECOVERY_FROM_EMAIL?.trim() ||
  "Harbor Kitchen <onboarding@resend.dev>";

/**
 * How many emails of every kind this deployment has handed to Resend in a
 * calendar month (UTC): sign-in links, receipts and creators' list email
 * together, because Resend counts them together. What Amazon took is counted
 * apart, by the hour, as Amazon counts it (lib/ses.ts).
 *
 * It is counted here, in the one place everything is sent from, so that list
 * email can be held back before the sender's own ceiling is reached
 * (lib/mail.ts, senderRoom). A count that could not be written is let go: no
 * email is ever lost, or held up, over a counter.
 */
export const sentKey = (now = new Date()) => `nl:sender:${now.toISOString().slice(0, 7)}`;

async function countSent(n: number): Promise<void> {
  if (n <= 0 || !isRedisConfigured()) return;
  const key = sentKey();
  await redisPipeline([
    ["INCRBY", key, n],
    ["EXPIRE", key, 70 * 86_400],
  ]).catch(() => {});
}

/** Confirmed sender usage this month; null when the existing read cannot prove it. */
export async function sentThisMonth(): Promise<number | null> {
  if (!isRedisConfigured()) return null;
  try {
    const reply: unknown = await redisPipeline([["GET", sentKey()]]);
    if (!Array.isArray(reply)) return null;
    const length = Object.getOwnPropertyDescriptor(reply, "length");
    if (!length || !("value" in length) || length.value !== 1) return null;
    const item = Object.getOwnPropertyDescriptor(reply, "0");
    if (!item || !("value" in item)) return null;
    if (item.value === null) return 0;
    if (typeof item.value !== "string" || !/^(0|[1-9][0-9]*)$/.test(item.value)) return null;
    const count = Number(item.value);
    return Number.isSafeInteger(count) ? count : null;
  } catch {
    return null;
  }
}

function getKey(): string | null {
  const key = process.env.RESEND_API_KEY?.trim();
  return key ? key : null;
}

/** The account usage API needs full access, which a domain-restricted send key need not have. */
function usageKey(): string | null {
  return process.env.RESEND_READ_API_KEY?.trim() || getKey();
}

/** Whether an email is from an address on the creators' domain (lib/mail-from.ts). */
function isCreators(from: string): boolean {
  const creators = creatorDomain(NIMBUS_FROM);
  return creators !== null && domainOf(from) === creators;
}

/**
 * The key an email goes to Resend with: a key held to the creators' domain
 * when the email is from an address on it and such a key was given, and the
 * site's own otherwise, which may send from every domain of the account.
 */
function keyFor(from: string): string | null {
  return (isCreators(from) && process.env.RESEND_CREATORS_API_KEY?.trim()) || getKey();
}

/** Resend's answer when a key may not send from the domain an email is from. */
const notThisDomain = (status: number) => status === 401 || status === 403;

export function isSenderConfigured(): boolean {
  return getKey() !== null || isSesConfigured();
}

/** A known global refusal, independent of any recipient or account lookup.
 * No IO, reservation or readiness check: false means unknown, never proof of
 * SES availability, a valid Resend review/binding or remaining fallback quota.
 * The actual send must still pass the existing provider and budget guards.
 */
export function serviceMailKnownUnavailable(runtime: ResendTransportRuntime = {}): boolean {
  return !isSesConfigured() && (!getKey() || currentResendFallbackProofIsMissing(runtime));
}

/** Whether Resend is there to send what Amazon does not take. */
export function hasResend(): boolean {
  return getKey() !== null;
}

/**
 * Tells the site's inbox once a day when Amazon refuses account sending.
 * The notice describes the available routes without claiming that a
 * recipient's email was delivered or that list mail used the fallback.
 */
async function tellAmazonIsDown(why: string): Promise<void> {
  try {
    console.error("Amazon SES account sending is unavailable", why || "(no reason given)");
    const day = new Date().toISOString().slice(0, 10);
    const key = `nl:ses:told:${day}`;
    const read: unknown = await redisPipeline([["GET", key]]);
    if (!Array.isArray(read)) return;
    const length = Object.getOwnPropertyDescriptor(read, "length");
    if (!length || !("value" in length) || length.value !== 1) return;
    const previous = Object.getOwnPropertyDescriptor(read, "0");
    // Only confirmed absence permits a send; an unknown read is not absence.
    if (!previous || !("value" in previous) || previous.value !== null || !hasResend()) return;
    const accepted = await viaResend({
      meter: { by: "company" },
      from: NIMBUS_FROM,
      to: SUPPORT_EMAIL,
      subject: "Amazon SES is not sending: check the account",
      text: [
        "Amazon SES refused account sending. Check its current account status and sending identity.",
        "",
        "Service email can use Resend only while the account review, credential binding and paid fallback quota are confirmed. Missing proof blocks that route. List-only email waits for SES; this notice does not confirm delivery.",
        "The account is checked again automatically. Sending resumes only when its current status allows it.",
        "",
        "What to look at: the Amazon SES console, under Account dashboard (is the account paused or under review?) and Identities (is the sending domain still verified?).",
      ].join("\n"),
    }, key);
    // A failed/uncertain send consumes no notice period. The stable sender
    // identity also protects a retry if this additional write loses its ACK.
    if (accepted === true) await redisPipeline([["SET", key, "1", "NX", "EX", 2 * 86_400]]);
  } catch (error) {
    console.error("telling the inbox Amazon SES is down failed", error);
  }
}

/**
 * What goes into a header of an email, made safe to put there.
 *
 * Subjects and sender names are built from text creators and buyers typed —
 * a product title, a store name, an affiliate's address — and a line break
 * in a header is how an email is made to carry headers, or recipients, that
 * nobody wrote. The sender's API takes JSON rather than raw headers, but we
 * do not rely on it to clean what we send: every control character becomes a
 * space here, runs of space become one, and the length is capped.
 */
export function headerText(value: string, max = 250): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

/** One plain address, or null: no spaces, no commas, one @, nothing that could name a second recipient. */
export function oneAddress(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text || text.length > 254 || !/^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/.test(text)) return null;
  return text;
}

/** A From line: `Name <address>` or a bare address, with nothing that breaks the header. */
function fromLine(value: string): string {
  return headerText(value, 320);
}

function cleanHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^[A-Za-z0-9-]{1,64}$/.test(name)) out[name] = headerText(value, 2000);
  }
  return out;
}

type OneMessage = {
  /** What it is counted against (EmailMeter, above). */
  meter: EmailMeter;
  from: string;
  to: string;
  subject: string;
  text: string;
  /** The same message as a page, when there is one; the text is always sent with it. */
  html?: string;
  /** Where replies go, when that is not the sender. */
  replyTo?: string;
  /** Files to attach, their content in base64. */
  attachments?: { filename: string; content: string }[];
  /** Extra headers, such as the one that lets a mail app offer unsubscribe. */
  headers?: Record<string, string>;
  /**
   * For a message that must go out once: a repeat of the same key, within a
   * day, is answered without sending it again.
   */
  idempotencyKey?: string;
};

const onceKey = (key: string) => `nl:ses:once:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

/**
 * One email through Amazon, when Amazon may be used. True when Amazon took
 * it; false when fallback is allowed; null when claim ownership or SES
 * acceptance is unknown, including a pre-existing legacy claim. A claim is
 * not proof of delivery, nor a source-funded lifetime reservation.
 */
async function viaAmazon(message: OneMessage, to: string, originalIdempotencyKey: string | undefined): Promise<boolean | null> {
  const config = sesConfig();
  if (!config || !(await sesReady())) return false;
  // Amazon keeps no record of a key, so the once-only promise is kept here.
  const once = originalIdempotencyKey ? onceKey(originalIdempotencyKey) : null;
  if (once) {
    try {
      const reply: unknown = await redisPipeline([["SET", once, "1", "NX", "EX", 86_400]]);
      // Bound the envelope before inspecting its sole own data member.
      if (!Array.isArray(reply)) return null;
      const length = Object.getOwnPropertyDescriptor(reply, "length");
      if (!length || !("value" in length) || length.value !== 1) return null;
      const fresh = Object.getOwnPropertyDescriptor(reply, "0");
      if (!fresh || !("value" in fresh)) return null;
      // This legacy marker records only a claim, not a provider ACK. It can
      // remain after a lost SET reply before any POST, so replay is unknown.
      if (fresh.value === null) return null;
      if (fresh.value !== "OK") return null;
    } catch {
      // SET may have committed. Keep the claim; neither sender may proceed.
      return null;
    }
  }
  const headers = cleanHeaders(message.headers);
  let last: Awaited<ReturnType<typeof sesSend>> = { outcome: "busy", why: "" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await sesSend(config, {
      from: fromLine(message.from),
      to,
      subject: headerText(message.subject),
      text: message.text,
      html: message.html,
      replyTo: oneAddress(message.replyTo),
      headers,
      attachments: message.attachments,
    });
    // A timeout or server error may follow acceptance. Keep any existing
    // claim, report unknown, and make no second SES attempt or Resend send.
    // This does not prove delivery or provide lifetime idempotency.
    if (last.uncertain === true) return null;
    if (last.outcome === "sent") {
      await countSesSent(1);
      return true;
    }
    // Too many a second for a moment, with a newsletter going out: a
    // sign-in link waits its turn rather than lose it.
    if (last.outcome !== "busy") break;
    if (attempt < 2) await pause(400 * (attempt + 1));
  }
  // Not taken. The key is let go of, so that Resend, or a later try, may send it.
  if (once) await redisPipeline([["DEL", once]]).catch(() => {});
  if (last.outcome === "account") {
    await sesDown(last.why);
    await tellAmazonIsDown(last.why);
  } else if (last.outcome === "refused") {
    console.error("Amazon SES refused an email; trying the other sender", last.why);
  }
  return false;
}

export async function sendEmail(message: OneMessage, runtime: ResendTransportRuntime = {}): Promise<boolean> {
  const to = oneAddress(message.to);
  if (!to) return false;
  if (!isSenderConfigured() || serviceMailKnownUnavailable(runtime)) return false;
  // Keep one identity across awaits and both routes. Preserve the original
  // string and the existing structural contract, including inherited keys.
  const originalIdempotencyKey = message.idempotencyKey;
  if (isSesConfigured()) {
    if (!(await metered(message.meter, 1))) return false;
    const amazon = await viaAmazon(message, to, originalIdempotencyKey);
    if (amazon === true) return true;
    if (amazon === null) return false;
    return viaResend(message, originalIdempotencyKey, runtime); // The existing SES path already took its allowance.
  }
  return viaResend(message, originalIdempotencyKey, runtime, lazyMeter(message.meter, 1));
}

/** Durable shipment work owns its lifetime claim in the outbox, not the
 * legacy one-day SES marker. The confirmed barrier immediately precedes the
 * one provider POST. Until fallback funding is verified this work waits for
 * SES; it never opens another route after an uncertain response.
 */
export function queuedShipmentMailSender(runtime: ResendTransportRuntime = {}): ShipmentMailDispatch {
  return async (message, beforePost, context) => {
    const usageCredential = usageKey() ?? "";
    const to = oneAddress(message.to);
    if (!to) return "refused";
    const config = sesConfig();
    if (!config || !(await sesReady())) {
      const result = await guardedResendPost({
        base: BASE, path: "/emails", credential: keyFor(message.from) ?? "", usageCredential,
        body: JSON.stringify({ from: fromLine(message.from), to: [to], subject: headerText(message.subject), text: message.text,
          ...(oneAddress(message.replyTo) ? { reply_to: oneAddress(message.replyTo) } : {}) }),
        idempotencyKey: `shipment:${context.id}`, recipients: 1, beforePost,
      }, runtime);
      if (result.kind === "accepted_receipt") return await beforePost() === true ? "accepted" : "unknown";
      if (result.kind === "blocked") return "waiting";
      if (result.kind !== "response") return "unknown";
      if (result.response.ok) { await countSent(1); return "accepted"; }
      return result.response.status === 429 ? "not_accepted" : "refused";
    }
    if (!(await beforePost())) return "unknown";
    const result = await sesSend(config, {
      from: fromLine(message.from), to, subject: headerText(message.subject),
      text: message.text, replyTo: oneAddress(message.replyTo),
    });
    if (result.uncertain === true) return "unknown";
    if (result.outcome === "sent") { await countSesSent(1); return "accepted"; }
    if (result.outcome === "account") await sesDown(result.why);
    return result.outcome === "refused" ? "refused" : "not_accepted";
  };
}
export const sendQueuedShipmentMail: ShipmentMailDispatch = queuedShipmentMailSender();

/** One email through Resend: the first sender, and the floor under the other. */
async function viaResend(message: OneMessage, originalIdempotencyKey: string | undefined, runtime: ResendTransportRuntime = {}, authorization?: MeterAuthorization): Promise<boolean> {
  const usageCredential = usageKey() ?? "";
  const key = keyFor(message.from);
  if (!key) return false;
  const to = oneAddress(message.to);
  if (!to) return false;
  const replyTo = oneAddress(message.replyTo);
  const headers = cleanHeaders(message.headers);

  // Sent again from the site's own address if Resend will not take the
  // creators' domain: see lib/mail-from.ts.
  let from = message.from;
  // Separate intentional service calls with identical text; retries within
  // this invocation keep one stable provider key and budget identity.
  let under = originalIdempotencyKey?.trim() ? originalIdempotencyKey : `nimbus-service:${randomBytes(16).toString("hex")}`;
  const payload = {
    to: [to],
    subject: headerText(message.subject),
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments.map(file => ({...file})) } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(headers ? { headers } : {}),
  };
  const body = () => JSON.stringify({ from: fromLine(from), ...payload });
  let auth = key;
  // A sign-in link or a receipt must not be lost because the sender was busy
  // with a creator's newsletter a second earlier: asked to slow down, it
  // waits a moment and tries again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (authorization && !(await authorization.preflight())) return false;
      const result = await guardedResendPost({
        base: BASE, path: "/emails", credential: auth,
        usageCredential, body: body(),
        ...(under ? { idempotencyKey: under } : {}), recipients: 1, ...(authorization ? { beforePost: authorization.beforePost } : {}),
      }, runtime);
      if (result.kind === "accepted_receipt") return true;
      if (result.kind !== "response") return false;
      const response = result.response;
      if (response.ok) {
        await countSent(1);
        return true;
      }
      if (response.status === 429 && attempt < 2) {
        await pause(1_000 + attempt * 1_000);
        continue;
      }
      const site = getKey();
      if (notThisDomain(response.status) && isCreators(from) && site && attempt < 2) {
        console.error("Resend refused the creators' domain; sending from the site's own address", response.status);
        from = atSiteAddress(from, NIMBUS_FROM);
        auth = site;
        // No longer the same request, so not under the same key.
        under = under ? `${under}:site` : under;
        continue;
      }
      console.error("email rejected", response.status);
      return false;
    } catch (error) {
      console.error("email failed", error);
      return false;
    }
  }
  return false;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type BatchMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /**
   * Labels the sender keeps with the email and gives back when it tells us
   * what became of it: which store's it was, so a bounce can be counted for
   * that store (lib/mail-health.ts). Never shown to the reader.
   */
  tags?: Record<string, string>;
};

/** Tags as the sender takes them: ASCII letters, digits, "_" and "-" only, 256 at most; anything else is left out. */
export function cleanTags(tags: Record<string, string> | undefined): { name: string; value: string }[] {
  const ok = /^[A-Za-z0-9_-]{1,256}$/;
  return Object.entries(tags ?? {})
    .filter(([name, value]) => ok.test(name) && ok.test(value))
    .map(([name, value]) => ({ name, value }));
}

/**
 * Sends up to a hundred emails. The key makes a retry of the same batch
 * write to nobody twice: Resend keeps it for a whole request, and for what
 * Amazon took, one email at a time, it is kept here (lib/ses.ts).
 *
 * "retry" means nothing was sent and the same batch may be tried again later;
 * "refused" means the provider will not send it as it is.
 */
export async function sendBatch(
  messages: BatchMessage[],
  batchKey: string,
  /** What the batch is counted against (EmailMeter). A store's figure that cannot take the whole batch sends none of it. */
  meter: EmailMeter,
  /**
   * One sender and no other, for the daily check that each of them brings a
   * bounce back (lib/verify-mail.ts). Everything else leaves this out, and
   * the choice is made here.
   */
  only?: "resend" | "amazon",
  runtime: ResendTransportRuntime = {},
): Promise<"sent" | "retry" | "refused"> {
  const result = await dispatchBatch(messages, batchKey, meter, only, false, runtime);
  return result === "waiting" ? "retry" : result;
}

/** List mail waits for SES; a known no-send result is distinct from unknown acceptance. */
export async function sendListBatch(
  messages: BatchMessage[], batchKey: string, meter: EmailMeter,
): Promise<"sent" | "waiting" | "retry" | "refused"> {
  if (messages.length === 0) return "sent";
  return dispatchBatch(messages, batchKey, meter, "amazon", true);
}

async function dispatchBatch(
  messages: BatchMessage[], batchKey: string, meter: EmailMeter,
  only: "resend" | "amazon" | undefined, listOnly: boolean, runtime: ResendTransportRuntime = {},
): Promise<"sent" | "waiting" | "retry" | "refused"> {
  if (!isSenderConfigured()) return listOnly ? "waiting" : "retry";
  if (messages.length === 0) return "sent";
  // What actually goes: a message with no address that can be written to is
  // left out below, and is not counted as sent either.
  let going = messages.slice(0, 100).filter((m) => oneAddress(m.to) !== null);
  const config = sesConfig();
  // Decide only a known unavailable selected route before taking its figure.
  // These synchronous observations grant no quota or provider permission.
  if (only === "amazon" && !(config && isSesConfigured())) return listOnly ? "waiting" : "retry";
  if (going.length && (only === "resend"
    ? currentResendFallbackProofIsMissing(runtime)
    : serviceMailKnownUnavailable(runtime))) return "retry";
  const resendSelected = only === "resend" || !(config && isSesConfigured());
  let authorization: MeterAuthorization | undefined;
  if (going.length) {
    if (resendSelected) {
      // Keep the same recipients/content through tags/domain variants and
      // bind the lazy debit to their filtered, bounded occurrence count.
      going = going.map(message => ({ ...message,
        ...(message.headers ? { headers: { ...message.headers } } : {}),
        ...(message.tags ? { tags: { ...message.tags } } : {}),
      }));
      authorization = lazyMeter(meter, going.length);
      if (!(await authorization.preflight())) return "refused";
    } else if (!(await metered(meter, going.length))) return "refused";
  }
  let idempotencyKey = batchKey;
  if (config && isSesConfigured() && only !== "resend") {
    const all = going.length;
    // Whoever Amazon already took under this key, in a batch that was then
    // cut short and is being tried again, is not written to twice.
    const pending = await notYetTaken(batchKey, going);
    // Unreadable evidence must not release recipients to either provider.
    if (pending === null) return "retry";
    going = pending;
    // And a batch whose rest was once handed to Resend goes back to Resend,
    // under the same key: if Resend took it and the answer was lost on the
    // way, only Resend can tell, and Amazon would write to them all again.
    const handed = `nl:ses:rest:${createHash("sha256").update(batchKey).digest("hex").slice(0, 40)}`;
    let toResend = false;
    try {
      const reply: unknown = await redisPipeline([["GET", handed]]);
      if (!Array.isArray(reply)) return "retry";
      const length = Object.getOwnPropertyDescriptor(reply, "length");
      if (!length || !("value" in length) || length.value !== 1) return "retry";
      const marker = Object.getOwnPropertyDescriptor(reply, "0");
      // Only explicit absence or our own handoff marker can select a sender.
      // A lost or malformed read must not turn into another provider attempt.
      if (!marker || !("value" in marker)) return "retry";
      if (marker.value === "1") toResend = true;
      else if (marker.value !== null) return "retry";
    } catch {
      return "retry";
    }
    if (listOnly && toResend && going.length) return "retry"; // A prior provider handoff needs reconciliation, not another sender.
    const state = going.length && !toResend ? await sesReady() : null;
    // Many at a time use Amazon's day only up to a share of it; past that
    // they go through Resend, and the rest of the day is kept for the
    // emails that go one at a time (lib/ses.ts).
    const room = state ? await sesBulkRoom(state) : null;
    // Unknown usage cannot authorize SES or a fallback provider attempt.
    if (state && room === null) return listOnly ? "waiting" : "retry";
    if (listOnly && going.length && (!state || room === null || room < going.length)) return "waiting";
    if (state && room !== null && room >= going.length) {
      const result = await sesBatch(
        config,
        state,
        going.map((m) => ({
          ...m,
          from: fromLine(m.from),
          to: oneAddress(m.to) as string,
          subject: headerText(m.subject),
          replyTo: oneAddress(m.replyTo),
          headers: cleanHeaders(m.headers),
          tags: cleanTags(m.tags),
          original: m,
        })),
        batchKey,
      );
      await countSesSent(result.taken.length);
      if (result.down) {
        await sesDown(result.down);
        await tellAmazonIsDown(result.down);
      }
      // A lost SES reply is not a refusal. The unresolved batch must reach
      // its caller without another SES wave or a switch to Resend. A durable
      // caller checkpoint is still needed before a later invocation.
      if (result.uncertain === true) return "retry";
      // SES excludes definitively refused recipients from both accepted and
      // pending lists. Missing recipients cannot establish a completed list.
      if (listOnly && result.taken.length + result.left.length < going.length) {
        // Accepted-recipient markers are not an acknowledged durable receipt.
        // A partial send must hold the caller, never authorize automatic replay.
        return result.taken.length > 0 ? "retry" : "refused";
      }
      going = result.left.map((m) => m.original);
    }
    if (going.length === 0) return "sent";
    if (only === "amazon") return "retry";
    if (!toResend) {
      try {
        const reply: unknown = await redisPipeline([["SET", handed, "1", "EX", 2 * 86_400]]);
        if (!Array.isArray(reply)) return "retry";
        const length = Object.getOwnPropertyDescriptor(reply, "length");
        if (!length || !("value" in length) || length.value !== 1) return "retry";
        const acknowledgement = Object.getOwnPropertyDescriptor(reply, "0");
        // An unconfirmed handoff may already be stored. Keep it, and do not
        // post to Resend until the existing marker proves the provider choice.
        if (!acknowledgement || !("value" in acknowledgement) || acknowledgement.value !== "OK") return "retry";
      } catch { return "retry"; }
    }
    // Resend answers a key it has seen with what it answered then, so a
    // different set of people must not go under the same key.
    if (going.length !== all) {
      idempotencyKey = `${batchKey}:${createHash("sha256").update(going.map((m) => m.to).sort().join(",")).digest("hex").slice(0, 16)}`;
    }
  }
  // A batch is one store's, so one address it is all from.
  const usageCredential = usageKey() ?? "";
  const key = going.length ? keyFor(going[0].from) : getKey();
  if (!key) return "retry";
  const tagged = going.some((m) => cleanTags(m.tags).length > 0);
  let firstPost = true;
  const post = async (withTags: boolean, under: string, auth: string = key, fromSite = false): Promise<Response | "accepted_receipt" | null> => {
    // The first Resend-selected preflight immediately precedes this path;
    // every known-refusal variant must independently precede its usage GET.
    if (!firstPost && authorization && !(await authorization.preflight())) return null;
    firstPost = false;
    const result = await guardedResendPost({
      base: BASE, path: "/emails/batch", credential: auth, usageCredential,
      idempotencyKey: under, recipients: going.length, ...(authorization ? { beforePost: authorization.beforePost } : {}),
      body: JSON.stringify(going.map((m) => {
        const replyTo = oneAddress(m.replyTo);
        const headers = cleanHeaders(m.headers);
        const tags = withTags ? cleanTags(m.tags) : [];
        return {
          from: fromLine(fromSite ? atSiteAddress(m.from, NIMBUS_FROM) : m.from),
          to: [oneAddress(m.to) as string], subject: headerText(m.subject),
          text: m.text, html: m.html,
          ...(replyTo ? { reply_to: replyTo } : {}), ...(headers ? { headers } : {}),
          ...(tags.length ? { tags } : {}),
        };
      })),
    }, runtime);
    return result.kind === "accepted_receipt" ? "accepted_receipt" : result.kind === "response" ? result.response : null;
  };
  try {
    let response = await post(true, idempotencyKey);
    if (response === "accepted_receipt") return "sent";
    if (!response) return "retry";
    if (!response.ok && tagged && (response.status === 400 || response.status === 422)) {
      // The tags are for us, not for the reader: they say whose email it was
      // on the day one bounces (lib/mail-health.ts). If the sender will not
      // take a batch that carries them, the email matters more than the
      // label, so it goes once more without them, under a key of its own
      // because it is no longer the same request.
      console.error("batch refused with its tags; sending it without them", response.status);
      response = await post(false, `${idempotencyKey}:plain`);
      if (response === "accepted_receipt") return "sent";
      if (!response) return "retry";
    }
    const site = getKey();
    if (!response.ok && notThisDomain(response.status) && site && going.some((m) => isCreators(m.from))) {
      // Resend will not take the creators' domain for the key it was given:
      // the same emails go from the site's own address (lib/mail-from.ts),
      // under a key of their own because it is no longer the same request.
      console.error("Resend refused the creators' domain for a batch; sending it from the site's own address", response.status);
      response = await post(true, `${idempotencyKey}:site`, site, true);
      if (response === "accepted_receipt") return "sent";
      if (!response) return "retry";
    }
    if (response.ok) {
      await countSent(going.length);
      return "sent";
    }
    console.error("batch rejected", response.status);
    return response.status === 429 || response.status >= 500 ? "retry" : "refused";
  } catch (error) {
    console.error("batch failed", error);
    return "retry";
  }
}

/* ------------------------------------------------------------------ */
/* One email its caller sends again under the same key                 */
/* ------------------------------------------------------------------ */

const pinKey = (key: string) => `nl:mail:pin:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
/** How long the sender a key's email went to is kept: a day, as long as SES's once-mark and Resend's own key. */
export const PINNED_SENDER_SECONDS = 86_400;
type Sender = "ses" | "resend";

/**
 * The sender kept for a key: `wanted` when none was (SET NX, read back by the same pipeline's GET), or the one kept
 * before. Null when a reply is not exactly what those commands answer (CX-123 rule 24): no request is made then.
 */
async function keepSender(key: string, wanted: Sender): Promise<Sender | null> {
  try {
    const replies = repliesFor(await redisPipeline([["SET", pinKey(key), wanted, "NX", "EX", PINNED_SENDER_SECONDS], ["GET", pinKey(key)]]), 2);
    if (!replies || (replies[0] !== "OK" && replies[0] !== null)) return null;
    const kept = replies[1];
    if (kept !== "ses" && kept !== "resend") return null;
    return replies[0] === "OK" && kept !== wanted ? null : kept;
  } catch {
    return null;
  }
}

/** The sender kept for a key, "none" when Redis answered that none is; null when the reply is not exact. */
async function keptSender(key: string): Promise<Sender | "none" | null> {
  try {
    const replies = repliesFor(await redisPipeline([["GET", pinKey(key)]]), 1);
    const kept = replies ? replies[0] : undefined;
    return kept === null ? "none" : kept === "ses" || kept === "resend" ? kept : null;
  } catch {
    return null;
  }
}

/**
 * sendEmail for an email its caller tries again under the same idempotencyKey until a sender takes it (a PayPal
 * receipt, lib/paypal-delivery.ts). The sender is kept for the key (PINNED_SENDER_SECONDS) just before its first
 * request, and every later try goes only to it, so an email whose answer was lost is never sent again by the other
 * sender, which has never seen the key. A kept sender that is not ready now sends nothing, and neither does a
 * refusal fall over to the other one: the caller tries again later. False without a key; without Redis it is
 * sendEmail. Every other email goes through sendEmail, unchanged.
 */
export async function sendEmailPinned(message: OneMessage, runtime: ResendTransportRuntime = {}): Promise<boolean> {
  const key = message.idempotencyKey;
  if (typeof key !== "string" || !key.trim()) return false;
  if (!isRedisConfigured()) return sendEmail(message, runtime);
  const to = oneAddress(message.to);
  if (!to) return false;
  if (!isSenderConfigured() || serviceMailKnownUnavailable(runtime)) return false;
  if (sesConfig() && (await sesReady())) {
    const kept = await keepSender(key, "ses");
    if (kept === "ses") {
      if (!(await metered(message.meter, 1))) return false;
      return (await viaAmazon(message, to, key)) === true;
    }
    if (kept !== "resend") return false;
  } else {
    // Kept as Amazon, which is not ready now, or not known: nothing goes to Resend.
    const kept = await keptSender(key);
    if (kept !== "resend" && kept !== "none") return false;
  }
  // Kept as Resend just before its request (the guard's last step before it), never in place of a kept Amazon.
  const toResend = async () => (await keepSender(key, "resend")) === "resend";
  if (isSesConfigured()) {
    if (!(await metered(message.meter, 1))) return false;
    return viaResend(message, key, runtime, { preflight: async () => true, beforePost: toResend });
  }
  const meter = lazyMeter(message.meter, 1);
  return viaResend(message, key, runtime, { preflight: meter.preflight, beforePost: async () => (await meter.beforePost()) && (await toResend()) });
}
