/**
 * A store's email to people is stopped by itself when its addresses turn out
 * to be bad ones, before they can cost every other store its email.
 *
 * Every store here sends through one account at the sender, and the sender
 * judges the account as a whole: more than 4% of its email bouncing, or more
 * than 0.08% of it marked as spam, and the account "may be shut down without
 * warning" (resend.com/legal/acceptable-use, read October 6, 2026). Its own
 * guide to accounts shared by many customers says the same thing from the
 * other side: one of them writing to a stale list can take the others down
 * with it. The account is also what sends every login link and hands every
 * buyer their file.
 *
 * A creator does not have to mean any harm for this to happen. A list
 * exported from another platform three years ago is full of addresses that
 * no longer exist, and importing it and writing to it is exactly what this
 * store invites them to do.
 *
 * So two things happen by themselves, and neither needs anybody watching:
 *
 *   1. An address that bounces for good, or whose owner marks the email as
 *      spam, is never written to by that store again (lib/contacts.ts,
 *      stopWriting). The sender tells us about each one
 *      (app/api/mail/inbound), and says which store it was by the tags these
 *      emails carry.
 *
 *   2. A store whose last seven days show too many of either is paused for
 *      seven days. Its list emails wait, as they do when a month runs out,
 *      and go on by themselves afterwards, to a list the bad addresses have
 *      by then been taken off.
 *
 * Two kinds of email are watched, because they are the two that go to
 * addresses somebody typed or brought in a file rather than ones a payment
 * proved: a creator's email to their list (lib/mail.ts, sendTo), and the one
 * email to buyers brought over from another platform (lib/imports.ts). A
 * sign-in link, a receipt, or an announcement to paying members is neither
 * counted nor paused.
 *
 * The lines are drawn inside the sender's own, so a store is stopped before
 * the account is in question:
 *
 *   bounces      at least 25 of them, and 2% or more of what was sent
 *                (the sender's line is 4%)
 *   complaints   at least 5 of them, and 0.08% or more of what was sent
 *                (the sender's own line: a store is not held to a stricter
 *                one than the account, only to the same one sooner)
 *
 * The floors are there because a rate over a handful of emails is noise: one
 * mistyped address in a list of thirty is 3%, and is nobody's bad list.
 *
 * A bounce is only known after the email has gone, so a third thing makes
 * sure few have gone by then:
 *
 *   3. After a store brings in addresses from elsewhere, its emails go out
 *      in portions that double — a hundred people, then two hundred, each a
 *      quarter of an hour after the one before (rampRoom, below). A list
 *      with many dead addresses is found, and paused, while a few hundred
 *      people have been written to rather than every one of them. A good
 *      list is through it in under two hours and never sees it again.
 *
 * What this does not do: it does not know an address is dead before writing
 * to it once. It limits what a bad list can cost to its first portions,
 * where before there was no limit at all.
 *
 *   nl:mail:health:<id>:<YYYY-MM-DD>   s, b, c: sent, bounced, complained
 *   nl:mail:health:<id>:seen:<hash>    an address already counted this week
 *   nl:mail:health:<id>:from           the day the count starts again, after a pause
 *   nl:mail:paused:<id>                why and until when (JSON)
 *   nl:mail:ramp:<id>                  the portion being sent, and when the next opens (JSON)
 *
 * <id> is the store's own id; for a store made before stores had one, its
 * list's id (healthId, below). Both are 32 hex characters.
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { stopWriting } from "@/lib/contacts";
import { normaliseEmail } from "@/lib/auth";
import type { Store } from "@/lib/store";
import { BOUNCE_FLOOR, BOUNCE_RATE, COMPLAINT_FLOOR, COMPLAINT_RATE, HEALTH_WINDOW_DAYS, PAUSE_DAYS, RAMP_FIRST, RAMP_GAP_MINUTES, RAMP_LAST, RAMP_TRIGGER } from "@/lib/mail-health-rules";

export { BOUNCE_FLOOR, BOUNCE_RATE, COMPLAINT_FLOOR, COMPLAINT_RATE, HEALTH_WINDOW_DAYS, PAUSE_DAYS };

/** The tag a watched email carries, naming the store it is counted for. */
export const STORE_TAG = "nl_store";
/** And, on a list email, the list the address is on, so it can be taken off it. */
export const LIST_TAG = "nl_list";
/** The email shared by all of its recipients, for aggregate delivery reporting. */
export const MAIL_REPORT_TAG = "nl_mail";
export const HEALTH_ID = /^[0-9a-f]{32}$/;
const REPORT_CAMPAIGN = /^[bs]-[A-Za-z0-9_-]{1,38}$/;

/** A campaign made by lib/mail-links.ts, or an empty string for an untrusted tag. */
export function mailReportCampaign(value: unknown): string {
  return typeof value === "string" && REPORT_CAMPAIGN.test(value) ? value : "";
}

/** What a store's watched email is counted under. "" for a store with neither id, which sends none. */
export function healthId(store: Pick<Store, "sid" | "listId">): string {
  const id = store.sid || store.listId || "";
  return HEALTH_ID.test(id) ? id : "";
}

/** The tags for one watched email, as the sender takes them. */
export function healthTags(store: Pick<Store, "sid" | "listId">, onList: boolean, campaign?: string): Record<string, string> {
  const id = healthId(store);
  if (!id) return {};
  const report = mailReportCampaign(campaign);
  return {
    [STORE_TAG]: id,
    ...(onList && store.listId && HEALTH_ID.test(store.listId) ? { [LIST_TAG]: store.listId } : {}),
    ...(report ? { [MAIL_REPORT_TAG]: report } : {}),
  };
}


export type PauseReason = "bounces" | "complaints";
export type Pause = { reason: PauseReason; until: number; sent: number; count: number };
export type Health = { sent: number; bounced: number; complained: number };

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const mailHealthDayKey = (id: string, ms: number) => `nl:mail:health:${id}:${dayOf(ms)}`;
const seenKey = (id: string, email: string) => `nl:mail:health:${id}:seen:${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;
const pausedKey = (id: string) => `nl:mail:paused:${id}`;
const fromKey = (id: string) => `nl:mail:health:${id}:from`;
/** Unit 2 gives daily report hashes their reviewed 30-day lifetime and cost ceiling. */
export const MAIL_HEALTH_DAY_SECONDS = (HEALTH_WINDOW_DAYS + 3) * 86_400;
const MAIL_HEALTH_SEEN_SECONDS = (HEALTH_WINDOW_DAYS + 3) * 86_400;

async function add(id: string, field: "s" | "b" | "c", n: number, now: number): Promise<void> {
  const key = mailHealthDayKey(id, now);
  await redisPipeline([
    ["HINCRBY", key, field, n],
    ["EXPIRE", key, MAIL_HEALTH_DAY_SECONDS],
  ]);
}

/** Counts watched emails handed to the sender for this store. Never throws: a send is not lost over a count. */
export async function noteSent(id: string, n: number, now = Date.now()): Promise<void> {
  if (!id || n <= 0 || !isRedisConfigured()) return;
  await add(id, "s", n, now).catch((error) => console.error("counting a store's sent email failed", error));
}

/** What the last seven days of this store's watched email look like, today included. */
export async function listHealth(id: string, now = Date.now()): Promise<Health> {
  const days: string[] = [];
  for (let i = 0; i < HEALTH_WINDOW_DAYS; i += 1) days.push(dayOf(now - i * 86_400_000));
  const [from, ...rows] = await redisPipeline([["GET", fromKey(id)], ...days.map((day) => ["HMGET", `nl:mail:health:${id}:${day}`, "s", "b", "c"])]);
  const total: Health = { sent: 0, bounced: 0, complained: 0 };
  rows.forEach((row, i) => {
    if (!Array.isArray(row)) return;
    // A store that has served a pause starts its count again from the day
    // the pause ends: the bounces it was paused for, and the ones that came
    // in late from the same emails, are not held against it twice.
    if (typeof from === "string" && days[i] < from) return;
    total.sent += Number(row[0]) || 0;
    total.bounced += Number(row[1]) || 0;
    total.complained += Number(row[2]) || 0;
  });
  return total;
}

/**
 * Whether those seven days are over a line, and which. Bounces are looked at
 * first: they are the commoner cause and the one the creator can do
 * something about.
 */
export function overTheLine(health: Health): { reason: PauseReason; count: number } | null {
  if (health.sent <= 0) return null;
  if (health.bounced >= BOUNCE_FLOOR && health.bounced / health.sent >= BOUNCE_RATE) return { reason: "bounces", count: health.bounced };
  if (health.complained >= COMPLAINT_FLOOR && health.complained / health.sent >= COMPLAINT_RATE) return { reason: "complaints", count: health.complained };
  return null;
}

/**
 * Read the existing health-pause checkpoint before admitting list email.
 * Null proves no current pause; undefined means the read is unconfirmed.
 * No unknown result authorizes a marketing attempt.
 */
export async function pauseForSending(id: string, now = Date.now()): Promise<Pause | null | undefined> {
  if (!id || !isRedisConfigured()) return undefined;
  try {
    const reply: unknown = await redisPipeline([["GET", pausedKey(id)]]);
    if (!Array.isArray(reply)) return undefined;
    const length = Object.getOwnPropertyDescriptor(reply, "length");
    if (!length || !("value" in length) || length.value !== 1) return undefined;
    const item = Object.getOwnPropertyDescriptor(reply, "0");
    if (!item || !("value" in item)) return undefined;
    if (item.value === null) return null;
    if (typeof item.value !== "string" || item.value.length > 512) return undefined;
    const value = JSON.parse(item.value) as Partial<Pause> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (value.reason !== "bounces" && value.reason !== "complaints") return undefined;
    const { until, sent, count } = value;
    if (typeof until !== "number" || !Number.isSafeInteger(until) || until < 0 ||
        typeof sent !== "number" || !Number.isSafeInteger(sent) || sent < 0 ||
        typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
    if (until * 1000 <= now) return null;
    return { reason: value.reason, until, sent, count };
  } catch {
    return undefined;
  }
}

/** Existing display/service contract; list admission uses pauseForSending instead. */
export async function pausedFor(id: string, now = Date.now()): Promise<Pause | null> {
  return (await pauseForSending(id, now)) ?? null;
}

/** Pauses the store when its seven days are over a line. A pause already running keeps its own end. */
async function pauseIfOver(id: string, now: number): Promise<Pause | null> {
  const health = await listHealth(id, now);
  const over = overTheLine(health);
  if (!over) return null;
  const pause: Pause = { reason: over.reason, until: Math.floor(now / 1000) + PAUSE_DAYS * 86_400, sent: health.sent, count: over.count };
  const [set] = await redisPipeline([["SET", pausedKey(id), JSON.stringify(pause), "NX", "EX", PAUSE_DAYS * 86_400]]);
  if (set === null) return null;
  await redisPipeline([["SET", fromKey(id), dayOf(pause.until * 1000), "EX", (PAUSE_DAYS + HEALTH_WINDOW_DAYS + 1) * 86_400]]);
  // When the week is over it starts again with a hundred people, not with
  // everyone who is left: what is left of a bad list is still a bad list.
  await startRamp(id, RAMP_TRIGGER);
  return pause;
}

/* ------------------------------------------------------------------ */
/* Growing portions, after addresses are brought in                    */
/* ------------------------------------------------------------------ */

type Ramp = { size: number; left: number; opens: number };
const rampKey = (id: string) => `nl:mail:ramp:${id}`;
const RAMP_KEPT_SECONDS = 180 * 86_400;

/** A single, explicit own response to one existing ramp command. */
function rampReply(reply: unknown): { value: unknown } | null {
  if (!Array.isArray(reply)) return null;
  const length = Object.getOwnPropertyDescriptor(reply, "length");
  if (!length || !("value" in length) || length.value !== 1) return null;
  const item = Object.getOwnPropertyDescriptor(reply, "0");
  return item && "value" in item ? { value: item.value } : null;
}

function parseRamp(raw: unknown): Ramp | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  try {
    const value = JSON.parse(raw) as Partial<Ramp> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { size, left, opens } = value;
    if (typeof size !== "number" || !Number.isSafeInteger(size) ||
        typeof left !== "number" || !Number.isSafeInteger(left) || left < 0 || left > size ||
        typeof opens !== "number" || !Number.isSafeInteger(opens) || opens < 0) return null;
    let knownSize = false;
    for (let portion = RAMP_FIRST; portion <= RAMP_LAST; portion *= 2) {
      if (size === portion) knownSize = true;
    }
    return knownSize ? { size, left, opens } : null;
  } catch {
    return null;
  }
}

/**
 * Starts the portions over for a store that has just had `added` addresses
 * brought in (a file of contacts, a paste, buyers moved from another
 * platform). Fewer than RAMP_TRIGGER starts nothing: a creator adding a few
 * people by hand is not a list of unknown age.
 */
export async function startRamp(id: string, added: number): Promise<void> {
  if (!id || added < RAMP_TRIGGER || !isRedisConfigured()) return;
  const ramp: Ramp = { size: RAMP_FIRST, left: RAMP_FIRST, opens: 0 };
  await redisPipeline([["SET", rampKey(id), JSON.stringify(ramp), "EX", RAMP_KEPT_SECONDS]]).catch((error) =>
    console.error("starting a store's portions failed", error),
  );
}

/**
 * How many of `want` emails this store may send right now, taken from the
 * portion that is open. `want` itself for a store with no portions running,
 * which is nearly every store nearly all the time; 0 while the next portion
 * has not opened yet, or when its read/write checkpoint is unconfirmed.
 */
export async function rampRoom(id: string, want: number, now = Date.now()): Promise<number> {
  if (!id || !Number.isSafeInteger(want) || want <= 0 || !Number.isFinite(now) || !isRedisConfigured()) return 0;
  const key = rampKey(id);
  try {
    const found = rampReply(await redisPipeline([["GET", key]]));
    if (!found) return 0;
    // Only confirmed absence means no portions are running. An unreadable
    // checkpoint cannot authorize the whole requested audience.
    if (found.value === null) return want;
    let ramp = parseRamp(found.value);
    if (!ramp) return 0;
    const seconds = Math.floor(now / 1000);
    if (ramp.left <= 0) {
      if (seconds < ramp.opens) return 0;
      const next = ramp.size * 2;
      if (next > RAMP_LAST) {
        // The confirmed final portion has finished; this only cleans up
        // its existing checkpoint, without changing the progression.
        await redisPipeline([["DEL", key]]);
        return want;
      }
      ramp = { size: next, left: next, opens: 0 };
    }
    const take = Math.min(want, ramp.left);
    const left = ramp.left - take;
    const after: Ramp = { size: ramp.size, left, opens: left === 0 ? seconds + RAMP_GAP_MINUTES * 60 : 0 };
    const saved = rampReply(await redisPipeline([["SET", key, JSON.stringify(after), "EX", RAMP_KEPT_SECONDS]]));
    // A missing acknowledgement may have applied. Keep that capacity taken
    // and grant no dispatch; do not refund or overwrite an uncertain write.
    return saved?.value === "OK" ? take : 0;
  } catch {
    return 0;
  }
}

/** Gives back what rampRoom took, for a batch that did not go out. */
export async function rampBack(id: string, n: number): Promise<void> {
  if (!id || n <= 0 || !isRedisConfigured()) return;
  const key = rampKey(id);
  const [raw] = await redisPipeline([["GET", key]]);
  const ramp = parseRamp(raw);
  if (!ramp) return;
  const after: Ramp = { size: ramp.size, left: Math.min(ramp.size, ramp.left + n), opens: 0 };
  await redisPipeline([["SET", key, JSON.stringify(after), "EX", RAMP_KEPT_SECONDS]]);
}

/** What an email waiting for its next portion says in the studio. */
export const PORTION_NOTE = `Going out in growing portions: addresses were brought into this list from elsewhere, so the first emails go to a few people at a time while dead addresses are found. The rest follow by themselves, every ${RAMP_GAP_MINUTES} minutes. Nothing is lost.`;

/**
 * Forgets everything kept about one id: its counts, the addresses counted,
 * a pause, its portions. For the daily check (lib/verify-mail.ts), which
 * makes up a store that is nobody's and takes it away again.
 */
export async function forgetHealth(id: string, emails: string[], now = Date.now()): Promise<void> {
  if (!HEALTH_ID.test(id) || !isRedisConfigured()) return;
  const keys = [pausedKey(id), fromKey(id), rampKey(id), ...emails.map((email) => seenKey(id, normaliseEmail(email)))];
  for (let i = -1; i <= HEALTH_WINDOW_DAYS; i += 1) keys.push(mailHealthDayKey(id, now - i * 86_400_000));
  await redisPipeline([["DEL", ...keys]]);
}

export type Told = "counted" | "paused" | "ignored";

/** What the sender said about one email, whichever sender it was (app/api/mail/inbound). */
export type SenderNotice = {
  kind: "bounced" | "complained";
  /** False for a bounce that may yet deliver: a full mailbox, a server that was down. */
  permanent: boolean;
  to: string;
  /** The email's tags, as it was sent with them. */
  store: string;
  list: string;
};

/**
 * What the sender said about one watched email: it bounced for good, or it
 * was marked as spam. The address is taken off that store's list, the day's
 * count goes up, and the store is paused if that puts it over a line.
 *
 * "ignored" for anything that is not ours to act on: an email that carried no
 * tag (a login link to a mistyped address is nobody's bad list), a bounce
 * that is only temporary, or an address already counted this week — the same
 * address bouncing twice is one bad address.
 */
export async function heardFromSender(notice: SenderNotice, now = Date.now()): Promise<Told> {
  if (!isRedisConfigured() || !HEALTH_ID.test(notice.store)) return "ignored";
  if (notice.kind === "bounced" && !notice.permanent) return "ignored";
  const email = normaliseEmail(notice.to);
  if (!email) return "ignored";
  // Off the list first, and every time: this is the part that must not be
  // skipped because a count had already been made.
  if (HEALTH_ID.test(notice.list)) await stopWriting(notice.list, email, notice.kind);
  const [first] = await redisPipeline([["SET", seenKey(notice.store, email), "1", "NX", "EX", MAIL_HEALTH_SEEN_SECONDS]]);
  if (first === null) return "ignored";
  await add(notice.store, notice.kind === "complained" ? "c" : "b", 1, now);
  return (await pauseIfOver(notice.store, now)) ? "paused" : "counted";
}

const n = (x: number) => x.toLocaleString("en-US");

/** "October 13": the day a pause ends, said the same wherever the reader is. */
export function pauseEnds(pause: Pick<Pause, "until">): string {
  return new Date(pause.until * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** Why a store's list email is waiting, in words for its studio. */
export function pauseWords(pause: Pause): string {
  const what =
    pause.reason === "bounces"
      ? `${n(pause.count)} of the ${n(pause.sent)} emails your store sent in a week went to addresses that do not exist`
      : `${n(pause.count)} of the ${n(pause.sent)} emails your store sent in a week were marked as spam by the people who got them`;
  const done =
    pause.reason === "bounces"
      ? "Those addresses have been taken off your list."
      : "Those people have been taken off your list.";
  return `Email to your list is paused until ${pauseEnds(pause)}: ${what}. ${done} It starts again by itself on that day, and anything waiting goes out then.`;
}

/** The same, short, for the line under one waiting email. */
export function pauseNote(pause: Pause): string {
  return pause.reason === "bounces"
    ? `Paused until ${pauseEnds(pause)}: too many of this store's emails went to addresses that do not exist. The rest go out by themselves then.`
    : `Paused until ${pauseEnds(pause)}: too many of this store's emails were marked as spam. The rest go out by themselves then.`;
}

/** Forgets that one address was counted this week for this store (lib/person-erasure.ts). */
export async function forgetHealthPerson(store: Pick<Store, "sid" | "listId">, email: string): Promise<number> {
  const id = healthId(store);
  if (!id || !isRedisConfigured()) return 0;
  const [gone] = await redisPipeline([["DEL", seenKey(id, normaliseEmail(email))]]);
  return Number(gone) || 0;
}
