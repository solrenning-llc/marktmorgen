/**
 * Mail written to the site's own addresses, passed on to the inbox that
 * reads it.
 *
 * The addresses printed on the site (support@marktmorgen.com) and the ones
 * our own emails are sent from (hello@, orders@) are on a domain that sends
 * through Resend. Resend receives for that domain too: each message it takes
 * in is announced to app/api/mail/inbound, and this file fetches it and sends
 * it on to one inbox, with Reply-To set to whoever wrote, so pressing Reply
 * there answers them.
 *
 * Three settings switch it on, and without all three nothing is received
 * here at all:
 *
 *   RESEND_WEBHOOK_SECRET    signs each announcement (whsec_…)
 *   RESEND_INBOUND_API_KEY   reads a received message and its files; kept
 *                            apart from RESEND_API_KEY, which can only send
 *   SUPPORT_FORWARD_TO       the inbox the mail goes on to; a setting, never
 *                            written in the code or shown on the site
 *
 * What cannot go wrong quietly:
 *
 *   - an announcement is believed only with Resend's signature (Svix:
 *     HMAC-SHA256 of "<id>.<timestamp>.<body>") from the last five minutes;
 *   - a message we sent on ourselves is never sent on again (it carries
 *     FORWARD_HEADER), and the inbox it goes to may not be on this site's own
 *     domain, so mail cannot go round in a circle;
 *   - a file is fetched only from Resend's own hosts, and files are left out,
 *     and named in the message, once they pass MAX_FILES_BYTES together;
 *   - sending on carries an idempotency key made from the message's id, so an
 *     announcement repeated by Resend cannot deliver the same message twice.
 *
 * The message itself stays in Resend's dashboard (Emails, Receiving) whatever
 * happens here.
 *
 * Resend announces every message its account receives to the one address it
 * was given, whichever domain the message was written to. So mail for another
 * site of the same studio that receives through the same account — Hazelsong's
 * support@hazelsong.com is one — arrives here too, and is sent on to the same
 * inbox. It is sent from this site's own address, which is the one this
 * deployment may send from, and it names the domain it was written to instead
 * of this site, so the inbox can tell which product a message is about.
 *
 * One kind of message does not go to that inbox at all. A creator's email
 * to people is sent from the store's own address on a domain set apart for
 * it (lib/mail-from.ts), and carries Reply-To with the creator's real
 * address, so an answer goes straight to them. A mail app that ignores
 * Reply-To answers the store's address instead, and that answer is the
 * creator's and nobody else's to read: it is sent on to the address the
 * store's account is under, from the store's own address, with Reply-To
 * whoever wrote. Mail to a name on that domain that is no store's is
 * dropped, and a store is sent on no more than CREATOR_HOURLY an hour, so
 * that the address cannot be used to pour mail on a creator through us.
 *
 * Mail to our own support is the company's to pay for, and so is held to
 * ceilings of its own, each counted before anything is fetched or sent
 * (ALTO 1 of Claude 5's email audit, 9 November 2026; the month's figure is
 * in docs/funded-exposure-review.md):
 *
 *   - announcements of mail not written to a store, SUPPORT_ANNOUNCED_DAILY a
 *     UTC day, counted before the message is even read at Resend, of which
 *     SUPPORT_ANNOUNCED_CREATOR_DAILY are kept for a From that has a store;
 *   - one sender, however the address is written, SUPPORT_SENDER_HOURLY an
 *     hour and SUPPORT_SENDER_DAILY a day;
 *   - every sender together SUPPORT_DAILY a UTC day, of which a sender with
 *     no PAID plan under its address may use SUPPORT_PUBLIC_DAILY, so made-up
 *     addresses and self-made free stores cannot take the creators' share,
 *     and one paying creator's address SUPPORT_CREATOR_SENDER_DAILY of it (a
 *     forged From of a known paying creator still spends the share);
 *   - files SUPPORT_FILE_BYTES_DAILY bytes a UTC day, each file charged once,
 *     at its listed size, before it is fetched, and never fetched past that
 *     size; a file past the day is left out and named.
 *
 * The sender is the message's From, which nothing here authenticates (no
 * DMARC or SPF result is read): anyone can spend one person's own hour by
 * writing in their name, and anyone who knows creators' addresses can spend
 * their reserved share too. These ceilings bound what the company pays; they
 * do not prove who wrote.
 *
 * A message past a ceiling is held: it is not sent on and will not be sent
 * later, it can be read in Resend (Emails, Receiving), and the inbox is told
 * so once a day (SUPPORT_HELD_NOTICES_DAILY). A count that cannot be read
 * sends nothing and asks Resend to try again; each count a message has taken
 * is marked, so a try again never takes it twice. Should Redis stay out of
 * reach for longer than Resend keeps trying, support mail is not sent on and
 * nobody is told: it is only in Resend.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalEmail } from "@/lib/affiliates";
import { NIMBUS_FROM, RESEND_BASE, headerText, oneAddress, sendEmail } from "@/lib/email";
import { creatorDomain } from "@/lib/mail-from";
import { redisPipeline } from "@/lib/redis";
import { stringList } from "@/lib/redis-reply";
import { essentialLimitState, withinLimit } from "@/lib/request-guard";
import { HANDLE_PATTERN, ownsAStore, storeForEmail, storeForHandle } from "@/lib/store";
import { RESEND_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { SITE_URL } from "@/lib/site-url";

/** The header a message sent on by this file carries. */
export const FORWARD_HEADER = "X-Marktmorgen-Forwarded";
/** Files sent on with one message, together, before base64. */
const MAX_FILES_BYTES = 15_000_000;
/** A message's own text or page, each, sent on. */
const MAX_BODY_CHARS = 400_000;
/** Messages sent on to one store in an hour, at the most. */
export const CREATOR_HOURLY = 40;
/** Messages from one sender sent on to our own support, at the most, in an hour and in a day. */
export const SUPPORT_SENDER_HOURLY = 10;
export const SUPPORT_SENDER_DAILY = 30;
/** Messages sent on to our own support in a UTC day, every sender together: a company cost. */
export const SUPPORT_DAILY = 200;
/** Of those, the most a UTC day from senders with no paid plan under their address. */
export const SUPPORT_PUBLIC_DAILY = 120;
/**
 * One paying creator's address, a UTC day. From is not authenticated, so a forged one of a creator known to pay
 * spends the creators' share (SUPPORT_DAILY - SUPPORT_PUBLIC_DAILY) a creator at a time: at this size it takes
 * ten known addresses, not three, to hold it for the day. It is a smaller ceiling than the sender's own day.
 */
export const SUPPORT_CREATOR_SENDER_DAILY = 8;
/** Announcements of mail not written to a store read at Resend in a UTC day, held or sent on. */
export const SUPPORT_ANNOUNCED_DAILY = 1_000;
/**
 * Of those, the reserve for announcements whose From has a store under it (one EXISTS, before the read). The rest
 * (SUPPORT_ANNOUNCED_DAILY - this) is the public share, with every announcement that shows no From. Resend's
 * email.received event is read for `data.from`; no dated Resend source could be read when this was written
 * (resend.com was out of the session's network), so an announcement without a From string is counted as public.
 * From is not authenticated: a forged From of any store owner, a free store included, spends the reserve.
 */
export const SUPPORT_ANNOUNCED_CREATOR_DAILY = 200;
/** Bytes of files sent on with them in a UTC day, together, before base64. */
export const SUPPORT_FILE_BYTES_DAILY = 300_000_000;
/** Notices a UTC day telling the support inbox that messages are held. */
export const SUPPORT_HELD_NOTICES_DAILY = 1;
/** How long a message's own mark (the counts it took, its files' bytes) is kept: longer than Resend tries again. */
const SUPPORT_MARK_SECONDS = 2 * 86_400;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const platformDomain = () => new URL(SITE_URL).hostname;

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** The inbox mail goes on to, or null: one plain address, not on this site's own domain. */
export function forwardTarget(): string | null {
  const address = oneAddress(env("SUPPORT_FORWARD_TO"));
  if (!address) return null;
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return domain === platformDomain() || domain.endsWith(`.${platformDomain()}`) ? null : address;
}

export function isInboundConfigured(): boolean {
  return Boolean(env("RESEND_WEBHOOK_SECRET") && env("RESEND_INBOUND_API_KEY") && forwardTarget());
}

/**
 * Whether Resend's announcements can be believed at all: the one setting that
 * signs them. Enough for the announcements that carry what they say in
 * themselves — an email bounced, an email was marked as spam
 * (lib/mail-health.ts) — which need nothing fetched and nothing sent on.
 */
export function canHearResend(): boolean {
  return Boolean(env("RESEND_WEBHOOK_SECRET"));
}

/**
 * Whether an announcement is Resend's: signed under RESEND_WEBHOOK_SECRET,
 * no more than five minutes ago. The signature header may hold several
 * ("v1,<base64> v1,<base64>"); one that matches is enough.
 */
export function inboundSigned(
  body: string,
  id: string | null,
  timestamp: string | null,
  signatures: string | null,
  now = Date.now(),
): boolean {
  const secret = env("RESEND_WEBHOOK_SECRET");
  if (!secret || !id || !timestamp || !signatures) return false;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !/^\d{9,11}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length < 16) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signatures
    .split(" ")
    .slice(0, 8)
    .some((one) => {
      const [version, value] = one.split(",");
      if (version !== "v1" || !value) return false;
      const given = Buffer.from(value, "base64");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

type Received = {
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  received_for?: unknown;
  reply_to?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  headers?: unknown;
};

type FileEntry = { filename?: unknown; size?: unknown; download_url?: unknown };

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 50) : [];

/** "Jane Doe <jane@example.com>" taken apart; a bare address has no name. */
export function parseSender(from: string): { name: string; address: string | null } {
  const match = from.match(/^\s*"?([^"<]*)"?\s*<([^<>]+)>\s*$/);
  if (match) return { name: headerText(match[1], 80), address: oneAddress(match[2]) };
  return { name: "", address: oneAddress(from) };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A page as plain words, for a message that came with no text of its own. */
function pageToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

async function read(path: string): Promise<{ status: number; data: unknown }> {
  const response = await timed(RESEND_TIMEOUT_MS, (signal) =>
    fetch(`${RESEND_BASE}${path}`, {
      headers: { Authorization: `Bearer ${env("RESEND_INBOUND_API_KEY")}` },
      cache: "no-store",
      redirect: "error",
      signal,
    }),
  );
  return { status: response.status, data: response.ok ? ((await response.json()) as unknown) : null };
}

/** A file's address, only when it is on one of Resend's own hosts (or the local stand-in of a test). */
function fileUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4000) return null;
  try {
    const url = new URL(value);
    if (RESEND_BASE.startsWith("http://127.0.0.1:") && url.origin === RESEND_BASE) return url.href;
    return url.protocol === "https:" && (url.hostname === "resend.com" || url.hostname.endsWith(".resend.com")) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Takes a support file's bytes from the company's day before it is fetched:
 * `want` is the message's files together with this one, at its listed size;
 * only what is more than the message already took is taken, so a message
 * tried again pays once. No when the day has no room or the count cannot be
 * read; a take that finds no room is given back. At most four commands a file.
 */
async function chargeSupportBytes(mark: string, taken: { bytes: number }, want: number, now: number): Promise<boolean> {
  if (want <= taken.bytes) return true;
  const extra = want - taken.bytes;
  const day = `nl:inbound:support:bytes:${new Date(now).toISOString().slice(0, 10)}`;
  try {
    const reply = await redisPipeline([["SET", day, "0", "EX", SUPPORT_MARK_SECONDS, "NX"], ["INCRBY", day, extra]]);
    const total = Array.isArray(reply) ? reply[1] : undefined;
    // Not known: what may have been added stays spent, and the file is left out.
    if (typeof total !== "number" || !Number.isSafeInteger(total)) return false;
    if (total > SUPPORT_FILE_BYTES_DAILY) {
      // Given back with the day's own expiry set again, so a key the give-back makes is never kept for ever.
      await redisPipeline([["DECRBY", day, extra], ["EXPIRE", day, SUPPORT_MARK_SECONDS]]).catch(() => {});
      return false;
    }
    taken.bytes = want;
    // Not kept: a try again pays again, never less than was spent.
    await redisPipeline([["HSET", mark, "bytes", String(want)], ["EXPIRE", mark, SUPPORT_MARK_SECONDS]]).catch(() => {});
    return true;
  } catch (error) {
    console.error("the support files' daily count could not be read", error);
    return false;
  }
}

type Charge = (want: number) => Promise<boolean>;

/** A response's body, or null once it holds more than `most` bytes, read no further than that. */
async function bodyUpTo(response: Response, most: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts, length);
    length += value.byteLength;
    if (length > most) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(Buffer.from(value));
  }
}

/** The files of a received message, as the sender's API takes them, and the names of the ones left out. */
async function files(id: string, charge?: Charge): Promise<{ sent: { filename: string; content: string }[]; left: string[] }> {
  const sent: { filename: string; content: string }[] = [];
  const left: string[] = [];
  const listed = await read(`/emails/receiving/${id}/attachments?limit=100`);
  const entries = (listed.data as { data?: unknown } | null)?.data;
  let total = 0;
  for (const entry of Array.isArray(entries) ? (entries as FileEntry[]).slice(0, 100) : []) {
    const name = headerText(typeof entry.filename === "string" && entry.filename ? entry.filename : "file", 150);
    const size = typeof entry.size === "number" && entry.size >= 0 ? entry.size : 0;
    const url = fileUrl(entry.download_url);
    if (!url || total + size > MAX_FILES_BYTES || (charge && !(await charge(total + size)))) {
      left.push(name);
      continue;
    }
    try {
      const response = await timed(RESEND_TIMEOUT_MS, (signal) => fetch(url, { cache: "no-store", signal }));
      if (!response.ok) throw new Error(`file answered ${response.status}`);
      // Charged at its listed size, a file is read no further than that: one bigger is left out.
      const bytes = charge ? await bodyUpTo(response, size) : Buffer.from(await response.arrayBuffer());
      if (!bytes || total + bytes.length > MAX_FILES_BYTES) {
        left.push(name);
        continue;
      }
      total += bytes.length;
      sent.push({ filename: name, content: bytes.toString("base64") });
    } catch (error) {
      console.error("an inbound file could not be fetched", error);
      left.push(name);
    }
  }
  return { sent, left };
}

/**
 * Whether the address has a store on a paid plan (its subscriptionActive), by one read of the store's record: a
 * free store is not a creator here, since anyone can make one. null when the record could not be read.
 * The read is priced in the registry at the record's largest size (MAX_STORE_BYTES).
 */
async function paysForAPlan(email: string): Promise<boolean | null> {
  try {
    const store = await storeForEmail(email);
    return store ? store.subscriptionActive === true : false;
  } catch {
    return null;
  }
}

/**
 * The UTC day on which this instance saw the day's announcements run out, and whether it then told the inbox. Once
 * the day is out, a later announcement on this instance costs no counter and no notice mark: the day's count only
 * grows, so the answer cannot change before the day ends. Per instance, so another one counts once itself.
 */
let announcedOut: { day: string; public: boolean; creator: boolean; told: boolean } | null = null;
/** For tests: forgets what this instance knows of the day. */
export function forgetSupportDayState(): void {
  announcedOut = null;
}

/**
 * Whether a message to our own support may be sent on, before anything is
 * fetched or sent: "within" once it has taken its sender's hour and day and
 * the company's UTC day (SUPPORT_PUBLIC_DAILY of it for a sender with no
 * store under the address); "held" when one of them has no room; "unknown"
 * when a count could not be read, so nothing is sent and Resend tries again.
 * Each count taken is marked on the message, so a try again takes only the
 * ones still missing; the mark also carries the bytes its files took.
 */
async function admitSupport(id: string, from: string | null, now: number): Promise<{ state: "within" | "held" | "unknown"; mark: string; taken: { bytes: number } }> {
  const mark = `nl:inbound:support:counted:${id}`;
  const taken = { bytes: 0 };
  const unknown = { state: "unknown" as const, mark, taken };
  let fields: string[] | null;
  try {
    const [raw] = await redisPipeline([["HGETALL", mark]]);
    fields = stringList(raw);
  } catch {
    return unknown;
  }
  if (!fields || fields.length % 2 !== 0) return unknown;
  const had = new Map<string, string>();
  for (let n = 0; n < fields.length; n += 2) had.set(fields[n], fields[n + 1]);
  const bytes = had.has("bytes") ? Number(had.get("bytes")) : 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0) return unknown;
  taken.bytes = bytes;
  // Marked once taken; a mark that is not kept only means a try again takes it again, never less than was spent.
  const took = (field: string) => redisPipeline([["HSET", mark, field, "1"], ["EXPIRE", mark, SUPPORT_MARK_SECONDS]]).catch(() => {});
  const who = from ? canonicalEmail(from) : "(no sender)";
  if (!had.has("hour")) {
    const hour = await essentialLimitState("support-sender-hour", who, SUPPORT_SENDER_HOURLY, 3_600);
    if (hour !== "within") return { ...unknown, state: hour === "exceeded" ? "held" : "unknown" };
    await took("hour");
  }
  if (!had.has("day")) {
    const day = await essentialLimitState("support-sender-day", who, SUPPORT_SENDER_DAILY, 86_400);
    if (day !== "within") return { ...unknown, state: day === "exceeded" ? "held" : "unknown" };
    await took("day");
  }
  const today = new Date(now).toISOString().slice(0, 10);
  if (!had.has("public") && !had.has("creator") && !had.has("all")) {
    // A creator is an address with a PAID plan: it may use the whole day, but its own address only
    // SUPPORT_CREATOR_SENDER_DAILY of it. Anyone else (a free store included) first takes the public share, its
    // own count, so the held ones among them never reach the day's count and the creators' rest stays.
    const creator = from ? await paysForAPlan(from) : false;
    if (creator === null) return unknown;
    if (creator) {
      const own = await essentialLimitState("support-creator-day", who, SUPPORT_CREATOR_SENDER_DAILY, 86_400);
      if (own !== "within") return { ...unknown, state: own === "exceeded" ? "held" : "unknown" };
      await took("creator");
    } else {
      const open = await essentialLimitState("support-public", today, SUPPORT_PUBLIC_DAILY, 2 * 86_400);
      if (open !== "within") return { ...unknown, state: open === "exceeded" ? "held" : "unknown" };
      await took("public");
    }
  }
  if (!had.has("all")) {
    const all = await essentialLimitState("support-forward", today, SUPPORT_DAILY, 2 * 86_400);
    if (all !== "within") return { ...unknown, state: all === "exceeded" ? "held" : "unknown" };
    await took("all");
  }
  return { state: "within", mark, taken };
}

/**
 * Tells the support inbox, once a UTC day, that messages are held and where they are; `address` is the one the
 * held message was written to. True when the day has its notice (sent now, or already), false when it could not
 * be sent or marked, so the next held message tries again.
 */
async function tellHeld(target: string, now: number, address: string): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const key = `nl:inbound:support:held:${day}`;
  try {
    const [taken] = await redisPipeline([["SET", key, "1", "EX", SUPPORT_MARK_SECONDS, "NX"]]);
    if (taken !== "OK") return true;
  } catch {
    return false;
  }
  const ok = await sendEmail({ meter: { by: "company" },
    from: `"Marktmorgen support" <support@${platformDomain()}>`,
    to: target,
    subject: "Some support email was not sent on today",
    text: [
      `Some email written to ${address} today was not sent on to this inbox.`,
      `This happens when one sender writes more than ${SUPPORT_SENDER_HOURLY} times in an hour or ${SUPPORT_SENDER_DAILY} times in a day, or in one day (UTC) when more than ${SUPPORT_PUBLIC_DAILY} messages come from addresses with no paid plan here, more than ${SUPPORT_DAILY} are sent on in all, one paying creator's address writes more than ${SUPPORT_CREATOR_SENDER_DAILY} times in a day, or more than ${SUPPORT_ANNOUNCED_DAILY} arrive (${SUPPORT_ANNOUNCED_DAILY - SUPPORT_ANNOUNCED_CREATOR_DAILY} from senders with no store, ${SUPPORT_ANNOUNCED_CREATOR_DAILY} from senders with one).`,
      "These messages were not sent on and will not be sent later. Read them in Resend (Emails, Receiving); this site keeps no copy. New messages are sent on again as usual.",
      "You get this note at most once a day.",
    ].join("\n\n"),
    headers: { [FORWARD_HEADER]: "1" },
    idempotencyKey: `inbound-held-${day}`,
  });
  // Not sent: the next held message tries again.
  if (!ok) await redisPipeline([["DEL", key]]).catch(() => {});
  return ok;
}

/**
 * Sends one received message on.
 *
 *   "sent"     it went on to the inbox
 *   "skipped"  there was nothing to send on: no such message, or one of ours
 *   "retry"    it could not be read or sent just now; the announcement should
 *              be answered with a failure, so Resend makes it again
 *   "held"     to our own support, past a ceiling: kept in Resend, not tried
 *              again, and the inbox told once a day
 */
export async function forwardInbound(id: string, now = Date.now(), announcedTo?: unknown, announcedFrom?: unknown): Promise<"sent" | "skipped" | "retry" | "held"> {
  const target = forwardTarget();
  if (!target || !ID.test(id)) return "skipped";

  // Mail the announcement does not show written to a store is our own support's: its announcements are
  // counted before the message is read at Resend, so held ones cannot cost a read each without end. An announcement
  // whose From has a store (one EXISTS) takes the creators' reserve of the day's announcements; every other, and every
  // one with no From, the public share, so made-up senders cannot hold a creator's mail unread.
  const creatorsDomain = creatorDomain(NIMBUS_FROM);
  const announced = typeof announcedTo === "string" ? [announcedTo] : list(announcedTo);
  if (!creatorsDomain || !announced.some((one) => (parseSender(one).address ?? "").toLowerCase().endsWith(`@${creatorsDomain}`))) {
    const today = new Date(now).toISOString().slice(0, 10);
    const first = announced.map((one) => parseSender(one).address).find((a) => a && a.toLowerCase().endsWith(`@${platformDomain()}`));
    const named = first ?? `support@${platformDomain()}`;
    const out = announcedOut?.day === today ? announcedOut : null;
    const announcedFromAddress = typeof announcedFrom === "string" ? parseSender(announcedFrom).address : null;
    // Out for the day on this instance in both pools: no EXISTS, no counter, no mark; the notice only until it is told.
    let pool: "public" | "creator" = "public"; // the reserve out: a store owner too uses the public share, with no EXISTS
    if (!(out?.public && out.creator)) {
      if (announcedFromAddress && !out?.creator) {
        const owns = await ownsAStore(announcedFromAddress);
        if (owns === null) return "retry";
        if (owns) pool = "creator";
      }
    }
    if (out?.[pool]) {
      if (!out.told) out.told = await tellHeld(target, now, named);
      return "held";
    }
    const heard = pool === "creator"
      ? await essentialLimitState("support-announced-creator", today, SUPPORT_ANNOUNCED_CREATOR_DAILY, 2 * 86_400)
      : await essentialLimitState("support-announced", today, SUPPORT_ANNOUNCED_DAILY - SUPPORT_ANNOUNCED_CREATOR_DAILY, 2 * 86_400);
    if (heard === "unknown") return "retry";
    if (heard === "exceeded") {
      console.warn(`a support message was held in Resend unread: past the day's ${pool} announcements`);
      const now_out = out ?? { day: today, public: false, creator: false, told: false };
      now_out[pool] = true;
      announcedOut = now_out;
      if (!now_out.told) now_out.told = await tellHeld(target, now, named);
      return "held";
    }
  }

  let got: { status: number; data: unknown };
  try {
    got = await read(`/emails/receiving/${id}`);
  } catch (error) {
    console.error("an inbound message could not be read", error);
    return "retry";
  }
  if (got.status === 404) return "skipped";
  if (!got.data || typeof got.data !== "object") return "retry";
  const mail = got.data as Received;

  const headers = mail.headers && typeof mail.headers === "object" ? (mail.headers as Record<string, unknown>) : {};
  if (Object.keys(headers).some((name) => name.toLowerCase() === FORWARD_HEADER.toLowerCase())) return "skipped";

  const from = typeof mail.from === "string" ? headerText(mail.from, 320) : "";
  const sender = parseSender(typeof headers.from === "string" && parseSender(headers.from).address ? headers.from : from);
  const replyTo = list(mail.reply_to).map((a) => parseSender(a).address).find(Boolean) ?? sender.address ?? undefined;
  // Each address once, however it was capitalised.
  const written: string[] = [];
  for (const one of [...list(mail.received_for), ...list(mail.to)]) {
    const address = parseSender(one).address;
    if (address && !written.some((held) => held.toLowerCase() === address.toLowerCase())) written.push(address);
  }
  const ours = written.find((a) => a.toLowerCase().endsWith(`@${platformDomain()}`)) ?? written[0] ?? `support@${platformDomain()}`;
  // Written to a store's own address: the creator's to read, not the site's.
  const creators = creatorDomain(NIMBUS_FROM);
  const toStore = creators ? written.find((a) => a.toLowerCase().endsWith(`@${creators}`)) : undefined;
  let creator: { name: string; email: string; address: string } | null = null;
  let store: Awaited<ReturnType<typeof storeForHandle>> = null;
  if (toStore) {
    const handle = toStore.slice(0, toStore.lastIndexOf("@")).toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) return "skipped";
    let found: Awaited<ReturnType<typeof storeForHandle>>;
    try {
      found = await storeForHandle(handle);
    } catch (error) {
      console.error("the store an inbound message was written to could not be read", error);
      return "retry";
    }
    const email = found ? oneAddress(found.email) : null;
    if (!found || !email) return "skipped";
    if (!(await withinLimit("creator-inbound", handle, CREATOR_HOURLY, 3_600))) return "skipped";
    creator = { name: headerText(found.name, 60).replace(/["\\<>]/g, "") || handle, email, address: `${handle}@${creators}` };
    store = found;
  }
  const subject = typeof mail.subject === "string" && mail.subject.trim() ? mail.subject : "(no subject)";
  const html = typeof mail.html === "string" ? mail.html.slice(0, MAX_BODY_CHARS) : "";
  const text = (typeof mail.text === "string" && mail.text.trim() ? mail.text : pageToText(html)).slice(0, MAX_BODY_CHARS);

  // Our own support: counted before its files are fetched or it is sent.
  let charge: Charge | undefined;
  if (!store) {
    const admitted = await admitSupport(id, sender.address, now);
    if (admitted.state === "unknown") return "retry";
    if (admitted.state === "held") {
      console.warn("a support message was held in Resend: past a sending ceiling");
      await tellHeld(target, now, ours);
      return "held";
    }
    charge = (want) => chargeSupportBytes(admitted.mark, admitted.taken, want, now);
  }

  let attached: Awaited<ReturnType<typeof files>> = { sent: [], left: [] };
  try {
    attached = await files(id, charge);
  } catch (error) {
    console.error("the files of an inbound message could not be listed", error);
    return "retry";
  }

  const who = sender.name ? `${sender.name} <${sender.address ?? "unknown"}>` : (sender.address ?? (from || "unknown sender"));
  const lines = [
    `From: ${who}`,
    `To: ${written.join(", ") || ours}`,
    // A creator has no way into the sender's dashboard, so is not pointed at it.
    ...(attached.left.length ? [`${creator ? "Not attached, too large to send on" : "Not attached (see Resend, Emails, Receiving)"}: ${attached.left.join(", ")}`] : []),
  ];
  const shown = (sender.name || sender.address || "Someone").replace(/["\\<>]/g, "").slice(0, 60);
  // Which site the message was written to: this one, or the domain of the
  // address it came in on (see the note at the top of this file).
  const writtenTo = ours.slice(ours.lastIndexOf("@") + 1).toLowerCase();
  const site = writtenTo === platformDomain() || !/^[a-z0-9.-]{3,80}$/.test(writtenTo) ? "Marktmorgen" : writtenTo;

  // To a creator, one of their store's emails; to our own support, a company cost.
  const ok = await sendEmail({ meter: store ? { by: "store", store, kind: "email" } : { by: "company" },
    from: creator ? `"${shown} via ${creator.name}" <${creator.address}>` : `"${shown} via ${site}" <support@${platformDomain()}>`,
    to: creator ? creator.email : target,
    subject,
    text: `${lines.join("\n")}\n\n${text}`,
    ...(html
      ? {
          html: `<div style="font:13px/1.5 system-ui,sans-serif;color:#555;border-bottom:1px solid #ddd;padding:0 0 8px;margin:0 0 12px">${lines
            .map(escapeHtml)
            .join("<br>")}</div>${html}`,
        }
      : {}),
    replyTo,
    attachments: attached.sent,
    headers: { [FORWARD_HEADER]: "1" },
    idempotencyKey: `inbound-${id}`,
  });
  return ok ? "sent" : "retry";
}
