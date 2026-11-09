/**
 * One-off emails to a creator's list: sent now or at a time they choose.
 *
 * Who receives it is decided the moment it starts, from the people who agreed
 * and have not left, and written down, so a list that changes during a long
 * send neither skips anyone nor sends anyone two. It goes out a hundred at a
 * time, each batch with its own key. A saved uncertain outcome stops
 * automatic retries for review; confirmed unfinished work continues on the
 * next run. This is not a lifetime exactly-once delivery guarantee.
 *
 *   nl:mail:bc:<id>        the broadcast (JSON)
 *   nl:mail:bc:<id>:to     who it goes to, in order (a list)
 *   nl:mail:bcs:<listId>   the store's broadcasts, newest first
 *   nl:mail:queue          broadcasts waiting or under way
 */
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { hasPlaceholder } from "@/lib/mail-body";
import { randomBytes, randomInt } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { needData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { WHO, type Who, audience, readTags } from "@/lib/contacts";
import { PORTION_NOTE, pauseNote } from "@/lib/mail-health";
import { BATCH_SIZE, MAX_MAIL_BODY, MAX_SUBJECT, SENDER_WAIT_NOTE, monthlyAllowance, sendTo, usedThisMonthExact } from "@/lib/mail";
import { WINDOW_ID, allowanceWindow, opensAgainWords, windowId } from "@/lib/allowance-window";
import { refreshPeriod } from "@/lib/billing-sync";
import { costStandingOf } from "@/lib/plan-standing";
import { allowancesUsedStrict, giveAllowance, giveAllowanceIn, holdAllowanceAt, takeAllowance } from "@/lib/store-allowance";
import { paypalKept } from "@/lib/paypal-sales";
import type { Store } from "@/lib/store";
import { hasProduct, idsOfKind } from "@/lib/catalog";
import { broadcastCampaign, isOwnLink, variantCampaign } from "@/lib/mail-links";
import { type Counted, type SubjectTest, MIN_TEST_REACH, chooseSubject, newTest, parseTest, partAt, splitFor } from "@/lib/mail-test";
import { campaignViews, readPaidSales } from "@/lib/stats";
import { moneyByCampaign } from "@/lib/mail-revenue";
import { AudienceNotCounted, type StudioHold, countedAudience } from "@/lib/audience-read";
import { BUYER_LEDGER_UNITS, LedgerNotCounted, type Narrow, isNarrowed, keepFor, ledgerReadBytes, ledgerReadingUnits, ledgerUnits, readNarrow, readsBuyers } from "@/lib/segments";
import { sameNarrow } from "@/lib/segments-rules";

export type BroadcastStatus = "scheduled" | "sending" | "sent" | "waiting" | "cancelled" | "failed";

export type Broadcast = {
  id: string;
  listId: string;
  handle: string;
  subject: string;
  body: string;
  /** Everyone who may be written to, or only those who got one product. */
  productId: string | null;
  /**
   * Nobody who already has this product. Set with or without productId: on
   * its own it is "everyone except the people who bought this", and with one
   * it is "the people who took that, and have not bought this".
   */
  notProductId: string | null;
  /**
   * Everybody, only the people who have bought something, or only the ones
   * who have not bought yet (lib/contacts.ts). Narrowed further by the two
   * above when they are set: "buyers, leaving out whoever has the course".
   */
  who: Who;
  /**
   * Spent at least, first found the store through, has not bought in these
   * days (lib/segments.ts): worked out from the store's sales when the email
   * starts. Null for none, which is every email made before 12 October 2026.
   */
  narrow: Narrow | null;
  /**
   * Only people who carry this label (lib/contacts.ts, tags; 99
   * [E2-TAG-BROADCAST]), as an import or a sequence put it on them. Null for
   * none, and absent on every email made before 2 November 2026.
   */
  label?: string | null;
  status: BroadcastStatus;
  createdAt: number;
  sendAt: number;
  finishedAt: number;
  total: number;
  sent: number;
  /** Why it is waiting or failed, in words for the studio. */
  note: string;
  failures: number;
  /** Whether who it goes to has been written down yet. */
  listed: boolean;
  /**
   * Whether the links to the store in it carry this email's tag
   * (lib/mail-links.ts), which is what lets its sales be counted. False for
   * every email made before that existed: for those there is nothing to
   * count, and the studio says nothing rather than "no sales".
   */
  tagged: boolean;
  /**
   * A second subject line tried against the first on part of the list, the
   * rest getting the one that did better (lib/mail-test.ts). Null for an
   * email with one subject, which is every email made before this existed.
   */
  test: SubjectTest | null;
  /**
   * Studio requests held for the readings of the store's buyers its list
   * needs when the scheduled job makes it (a narrowed email: READS_HELD
   * readings for one scheduled, EXTRA_READS for one that starts at once, each
   * at its worst, lib/segments.ts ledgerReadingUnits), in the window of the
   * month it goes out (`window`, lib/store-allowance.ts holdAllowanceAt), and
   * not drawn yet (`units`). Those readings draw from it; what they need
   * beyond it, or all of it when it was held for another month than the one
   * it goes out in, is taken from that month, and without it the email waits
   * for the month that has them. What is not drawn is given back once its
   * list is made, or when it is canceled. Absent on an email that holds none.
   */
  hold?: { window: string; units: number };
  /**
   * Readings of the store's buyers the scheduled job made for it, each paid
   * before it was read: at most READS_HELD, then it stops, failed, saying
   * why. A reading that failed at Stripe or PayPal is not one (`misses`).
   */
  reads?: number;
  /** Readings that failed at Stripe or PayPal in a row: each waited out longer (READ_RETRY_SECONDS), at most READ_MISSES_ALLOWED. */
  misses?: number;
  /** A waiting email is not tried before this moment (seconds): the month whose studio requests it waits for, or a failed reading's wait. */
  retryAt?: number;
};

/** Creation may have been partially written even when its acknowledgement is lost. */
export class BroadcastWriteUnconfirmed extends Error {
  constructor() { super("Campaign creation could not be confirmed"); this.name = "BroadcastWriteUnconfirmed"; }
}

export class BroadcastCancellationUnconfirmed extends Error {
  constructor() { super("Campaign cancellation could not be confirmed"); this.name = "BroadcastCancellationUnconfirmed"; }
}

export const MAX_SCHEDULE_DAYS = 365;
/** How long a broadcast's record is kept after its last change, and who it went to after it was made. */
const RECORD_DAYS = 400;
const RECIPIENT_DAYS = 60;
/**
 * Readings of the buyers the scheduled job may make for one email beyond its
 * first (C3-80 (d)): a list that could not be made for another reason (the
 * data room full, which is rare) is read again at most this many times, then
 * the email stops, failed, saying why. Each one is paid in studio requests
 * before it is read: from what the email holds, or from the month it is
 * read in (advanceBroadcast).
 */
export const EXTRA_READS = 1;
/** Readings of the buyers a narrowed email scheduled for later holds when it is written down: its first, and EXTRA_READS. */
export const READS_HELD = 1 + EXTRA_READS;
/** The first wait after a reading failed at Stripe or PayPal; each failure in a row doubles it, up to a day. */
export const READ_RETRY_SECONDS = 3_600;
const readRetry = (misses: number) => Math.min(86_400, READ_RETRY_SECONDS * 2 ** Math.min(Math.max(misses - 1, 0), 5));
/** Readings in a row that may fail at Stripe or PayPal before the email stops, failed, saying so (about four days of waits). */
export const READ_MISSES_ALLOWED = 7;
/** Said on a narrowed email whose readings of its buyers failed at Stripe or PayPal READ_MISSES_ALLOWED times in a row. */
export const READ_GAVE_UP_NOTE = `Your sales could not be read after ${READ_MISSES_ALLOWED} tries, so the list of who it goes to could not be made and it stopped. Nothing was sent. To send it, write it again.`;
/** Said on a narrowed email whose store reads no buyers any more (Stripe and PayPal disconnected, none brought over). */
export const NO_BUYERS_NOTE = "Your store can no longer read its sales (Stripe and PayPal are not connected, and no buyers were brought over), so the buyers this email was narrowed to could not be found. It was canceled and sent to no one. Reconnect, then write it again.";
/** A wait after the list could not be made for a reason of the store's or ours, before it is tried again (seconds). */
export const LIST_RETRY_SECONDS = 3_600;
/** Said when a narrowed email's list could not be made now for a reason that passes: tried again in an hour. */
const LIST_WAIT_NOTE = "The list of who it goes to could not be prepared just now. Nothing was sent. It is tried again in an hour.";
/** Said on an email to the whole list canceled because, when it was due, the plan was not paid and running: nothing read, sent or used. */
export const PLAN_OFF_NOTE = "Your plan was not active when this email was due, so it was canceled. Nothing was sent and none of your studio requests were used for it. To send it, write it again while your plan is on.";
/**
 * The same for a narrowed email: counting its buyers when it was written, and any reading of them since, used studio
 * requests that stay used, so it never says none were (review of #2205, C3-112); what it set aside is given back.
 */
export const PLAN_OFF_NARROWED_NOTE = "Your plan was not active when this email was due, so it was canceled. Nothing was sent. What it set aside of your studio requests is given back; what finding its buyers already used stays used. To send it, write it again while your plan is on.";
/** Said on an email stopped partway because the plan stopped being paid and running: how many had gone, and nothing more. */
export function planOffPartNote(sent: number, total: number): string {
  return `Your plan stopped being active while this email was going out, so the rest was canceled: ${sent.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} had gone out. Nothing more is sent. To reach the rest, write it again while your plan is on.`;
}
/** Said on a narrowed email whose reading of its buyers failed at Stripe or PayPal: nothing spent, tried again later. */
export const READ_FAILED_NOTE = `Your sales could not be read just now, so the list of who it goes to could not be made. Nothing was sent. What that try used of your studio requests stays used. It is tried again later, up to ${READ_MISSES_ALLOWED} times in a row, then it stops.`;
/** Said on a narrowed email waiting for the month whose studio requests will pay for its reading of the buyers: only if the plan still runs then (a trial or a plan set to end that ends first cancels it). */
export function studioWaitNote(opens: string): string {
  return `Your studio requests for this month are used up, so the list of who it goes to could not be made. Nothing was sent. It goes out by itself when they open again, on ${opens} (UTC), if your plan is still active then; if it ends first, the email is canceled.`;
}

/** The note of an email stopped because its readings of the buyers ran out: why it waited, without "tried again". */
export function readsSpentNote(waiting: string): string {
  const why = waiting.replace(/\s*(Make room, and it is tried again automatically|It will be checked again automatically|It is tried again automatically|It is tried again in an hour|(Make room: it|It) is tried again in an hour, [^.]*)\.$/, "").trim();
  return `${why || "The list of who it goes to could not be made. Nothing was sent."} It was tried as many times as it can be, so it stopped. To send it, write it again.`;
}

/** The longest note a broadcast's record was given room for (createBroadcast). */
export const NOTE_ROOM = 300;
const QUEUE = "nl:mail:queue";
const bcKey = (id: string) => `nl:mail:bc:${id}`;
const toKey = (id: string) => `nl:mail:bc:${id}:to`;
/** Every key a broadcast keeps, by its id: for a closed store (lib/closed-store-data.ts). */
export const broadcastKeys = (id: string): string[] => [bcKey(id), toKey(id), `${bcKey(id)}:lock`];
const listKey = (listId: string) => `nl:mail:bcs:${listId}`;
const lockKey = (id: string) => `nl:mail:bc:${id}:lock`;
export const BROADCAST_ID = /^[0-9a-f]{24}$/;

function parse(raw: unknown): Broadcast | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Broadcast;
    if (!BROADCAST_ID.test(value.id)) return null;
    // Written before the exclusion existed: it goes to everyone it was
    // addressed to, exactly as it was when it was scheduled.
    return {
      ...value,
      notProductId: typeof value.notProductId === "string" ? value.notProductId : null,
      tagged: value.tagged === true,
      who: WHO.includes(value.who) ? value.who : "all",
      narrow: isNarrowed(value.narrow) ? readNarrow(value.narrow) : null,
      ...(typeof value.label === "string" && value.label ? { label: value.label } : {}),
      test: parseTest(value.test),
    };
  } catch {
    return null;
  }
}

export async function readBroadcast(id: string): Promise<Broadcast | null> {
  if (!BROADCAST_ID.test(id) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", bcKey(id)]]);
  return parse(raw);
}

async function save(b: Broadcast): Promise<void> {
  const response = await redisPipeline([["SET", bcKey(b.id), JSON.stringify(b), "EX", RECORD_DAYS * 86_400]]);
  if (!Array.isArray(response) || response.length !== 1 || response[0] !== "OK") throw new Error("Campaign progress write could not be confirmed");
}

/** The ids LRANGE answered, when they are exactly a list of ids this code writes (rule 24, repliesFor/stringList); null otherwise. Pure. */
function listedIds(response: unknown, limit: number): string[] | null {
  const ids = stringList(repliesFor(response, 1)?.[0]);
  if (!ids || ids.length > limit || !ids.every((id) => BROADCAST_ID.test(id)) || new Set(ids).size !== ids.length) return null;
  return ids;
}

/**
 * How many of the newest `limit` broadcasts there are and how many bytes
 * their records hold, before they are read: for a reading that pays for its
 * size first (lib/mcp-tools.ts, emailsTool). Null when a size did not come back.
 */
export async function broadcastSizes(listId: string | null, limit = 30): Promise<{ count: number; bytes: number } | null> {
  if (!listId || !isRedisConfigured()) return { count: 0, bytes: 0 };
  // Only Redis's own list of ids: any other answer is unknown, never "no campaigns".
  const list = listedIds(await redisPipeline([["LRANGE", listKey(listId), 0, limit - 1]]), limit);
  if (!list) return null;
  if (!list.length) return { count: 0, bytes: 0 };
  const replies = repliesFor(await redisPipeline(list.map((id) => ["STRLEN", bcKey(id)])), list.length);
  if (!replies) return null;
  const lengths = replies.map(countOf);
  if (lengths.some((n) => n === null)) return null;
  // A broadcast added between this and the reading is a few bytes more, bounded by how fast a store writes them.
  return { count: list.length, bytes: (lengths as number[]).reduce((a, b) => a + b, 0) };
}

export class BroadcastsUnreadable extends Error {
  constructor(what: string) {
    super(`The store's campaigns could not be read: ${what}`);
    this.name = "BroadcastsUnreadable";
  }
}

/**
 * The store's broadcasts, newest first, read exactly (rule 24). A record Redis answers as its own nil is a campaign
 * whose record expired (it is written before its id is listed, and kept RECORD_DAYS): left out, known. A list of
 * ids in another shape, a record that does not read, or one of another id or list throws BroadcastsUnreadable, never
 * read as fewer or no campaigns. Records read as before (parse, with its documented defaults).
 */
export async function listBroadcasts(listId: string | null, limit = 30): Promise<Broadcast[]> {
  if (!listId || !isRedisConfigured()) return [];
  const list = listedIds(await redisPipeline([["LRANGE", listKey(listId), 0, limit - 1]]), limit);
  if (!list) throw new BroadcastsUnreadable("the list of campaigns");
  if (!list.length) return [];
  const rows = repliesFor(await redisPipeline(list.map((id) => ["GET", bcKey(id)])), list.length);
  if (!rows) throw new BroadcastsUnreadable("the campaigns' records");
  const out: Broadcast[] = [];
  for (let i = 0; i < list.length; i += 1) {
    if (rows[i] === null) continue;
    const b = parse(rows[i]);
    if (!b || b.id !== list[i] || b.listId !== listId) throw new BroadcastsUnreadable("a campaign's record");
    out.push(b);
  }
  return out;
}


/** Shared strict validation for studio history and executable campaign records. */
function parseStoredBroadcast(raw: unknown, id: string, listId?: string): Broadcast {
  const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const association = (value: unknown) => value === null || typeof value === "string" && value.length > 0;
  const statuses = new Set(["scheduled", "sending", "sent", "waiting", "cancelled", "failed"]);
  if (typeof raw !== "string") throw new Error("Campaign record is unavailable");
  const record: unknown = JSON.parse(raw);
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid campaign record");
  const value = record as Record<string, unknown>;
  const b = parse(raw);
  if (!b || b.id !== id || typeof b.listId !== "string" || !b.listId.trim() || (listId !== undefined && b.listId !== listId) || typeof b.handle !== "string" || !b.handle.trim() || typeof b.subject !== "string" || !b.subject.trim() || typeof b.body !== "string" || !b.body.trim() || !association(b.productId) || !statuses.has(b.status) || !nonnegative(b.createdAt) || !b.createdAt || !nonnegative(b.sendAt) || !b.sendAt || !nonnegative(b.finishedAt) || !nonnegative(b.total) || !nonnegative(b.sent) || b.sent > b.total || !nonnegative(b.failures) || typeof b.listed !== "boolean" || typeof b.note !== "string") throw new Error("Invalid campaign fields");
  // These fields were absent in older campaigns; explicit malformed values are not legacy defaults.
  if (value.who !== undefined && !WHO.includes(value.who as Who) || value.notProductId !== undefined && !association(value.notProductId) || value.tagged !== undefined && typeof value.tagged !== "boolean" || value.test !== undefined && value.test !== null && b.test === null) throw new Error("Invalid campaign options");
  if (value.label !== undefined && value.label !== null && (typeof value.label !== "string" || readTags([value.label])[0] !== value.label)) throw new Error("Invalid campaign label");
  if (value.hold !== undefined && (!value.hold || typeof value.hold !== "object" || Array.isArray(value.hold) || typeof (value.hold as { window?: unknown }).window !== "string" || !WINDOW_ID.test((value.hold as { window: string }).window) || !nonnegative((value.hold as { units?: unknown }).units))) throw new Error("Invalid campaign hold");
  for (const field of ["reads", "misses", "retryAt"] as const) if (value[field] !== undefined && !nonnegative(value[field])) throw new Error(`Invalid campaign ${field}`);
  if (value.narrow !== undefined && value.narrow !== null) {
    if (typeof value.narrow !== "object" || Array.isArray(value.narrow)) throw new Error("Invalid campaign audience");
    const narrow = value.narrow as Record<string, unknown>;
    const normalized = readNarrow(narrow);
    if (!sameNarrow(narrow, normalized)) throw new Error("Invalid campaign audience fields");
  }
  return b;
}

/** A failed or malformed read is never a confirmed missing campaign. */
async function readBroadcastForWork(id: string): Promise<Broadcast | null> {
  if (!isRedisConfigured()) throw new Error("Campaign storage is unavailable");
  const response = await redisPipeline([["GET", bcKey(id)]]);
  if (!Array.isArray(response) || response.length !== 1) throw new Error("Campaign read is incomplete");
  if (response[0] === null) return null;
  return parseStoredBroadcast(response[0], id);
}

/** A studio snapshot is all-or-unavailable; missing rows must not look like no campaigns. */
/**
 * With `expired: "skip"`, an id whose record Redis answers as its own nil is left out: the record is written before
 * its id enters the list (createBroadcast) and lives RECORD_DAYS under its own EXPIRE while the list never expires, so
 * nil is a campaign that is gone, known. Every other answer still throws (rule 24). Without it, one missing record
 * withholds the whole list, as before.
 */
export async function listBroadcastsStrict(listId: string | null, limit = 30, options: { expired?: "skip" } = {}): Promise<Broadcast[]> {
  if (!listId) return [];
  if (!isRedisConfigured()) throw new Error("Campaign storage is unavailable");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid campaign history limit");
  const response = await redisPipeline([["LRANGE", listKey(listId), 0, limit - 1]]);
  if (!Array.isArray(response) || response.length !== 1 || !Array.isArray(response[0])) throw new Error("Campaign index is unavailable");
  const ids: unknown[] = response[0];
  if (ids.length > limit || Array.from(ids).some(id => typeof id !== "string" || !BROADCAST_ID.test(id)) || new Set(ids).size !== ids.length) throw new Error("Campaign index is incomplete");
  if (!ids.length) return [];
  const rows = await redisPipeline(ids.map(id => ["GET", bcKey(id as string)]));
  if (!Array.isArray(rows) || rows.length !== ids.length) throw new Error("Campaign records are incomplete");
  const out: Broadcast[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    if (options.expired === "skip" && rows[i] === null) continue;
    out.push(parseStoredBroadcast(rows[i], ids[i] as string, listId));
  }
  return out;
}

/**
 * Who a kind of reader is, for this store today: the products sold for money
 * come from the store's own index, so nothing is read to know them.
 */
export function whoOf(store: Store, kind: Who): { kind: Who; paid: ReadonlySet<string> } | undefined {
  return kind === "all" ? undefined : { kind, paid: new Set(idsOfKind(store, "paid")) };
}

export type CreateResult =
  // `keep`: the narrowing read and counted here, for a send that starts in the same request (advanceBroadcast's `given`).
  // `startsNow`: it is due already, so the request that wrote it starts it (the scheduled job takes up the rest).
  | { ok: true; broadcast: Broadcast; keep: ((email: string) => boolean) | undefined; startsNow: boolean }
  | { ok: false; reason: "subject" | "body" | "when" | "product" | "empty" | "allowance" | "setup" | "plan" | "test_subject" | "test_small" | "test_links" | "placeholder" }
  // Its readings of the buyers could not be held (lib/store-allowance.ts holdAllowanceAt): the sentence says why.
  | { ok: false; reason: "studio_used"; message: string };

const LINK = /https:\/\/[^\s<>"')\]]+/g;

/**
 * Whether an email has a link to the creator's own store in it. A test of two
 * subject lines is decided by what those links bring; without one there is
 * nothing to count, and the "winner" would be the first subject every time.
 */
export function linksToStore(body: string, store: Pick<Store, "handle" | "domain">): boolean {
  for (const found of body.match(LINK) ?? []) {
    try {
      if (isOwnLink(new URL(found.replace(/[.,;:!?]+$/, "")), store)) return true;
    } catch {
      // Not an address after all: not a link to the store either.
    }
  }
  return false;
}

/**
 * Writes a broadcast down to go now or later. What it may contain is checked
 * here. `count` counts the reading of the store's buyers a narrowed email
 * needs before it is read (lib/segments.ts, buyerLedger; LedgerNotCounted
 * when it is not, nothing written). Then, since the scheduled job may make its
 * list (always for one scheduled; for one due now, when another run takes it
 * first or its list has to wait), it holds what those readings cost at the
 * most in the month it goes out (the broadcast's `hold`): refused with the
 * sentence when that month has too few left after what is already held in
 * it, or when the plan does not pay for that month as it stands.
 */
export async function createBroadcast(
  store: Store,
  input: { subject: unknown; body: unknown; productId: unknown; notProductId: unknown; sendAt: unknown; who?: unknown; test?: unknown; narrow?: unknown; label?: unknown },
  count?: (units: number) => Promise<boolean>,
  /** Takes the studio requests the read of the list costs, by its size, before it is read (lib/audience-read.ts); the studio's route always gives it. */
  hold?: StudioHold,
): Promise<CreateResult> {
  if (monthlyAllowance(store) === 0) return { ok: false, reason: "plan" };
  if (!store.mail || !store.listId) return { ok: false, reason: "setup" };
  const subject = typeof input.subject === "string" ? input.subject.replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT) : "";
  const body = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n").trim().slice(0, MAX_MAIL_BODY) : "";
  if (!subject) return { ok: false, reason: "subject" };
  if (!body) return { ok: false, reason: "body" };
  // A template's part left to write is a direction, never words sent in the creator's name (lib/mail-body.ts).
  if (hasPlaceholder(subject) || hasPlaceholder(body)) return { ok: false, reason: "placeholder" };
  const productId = typeof input.productId === "string" && input.productId ? input.productId : null;
  if (productId && !hasProduct(store, productId)) return { ok: false, reason: "product" };
  const notProductId = typeof input.notProductId === "string" && input.notProductId ? input.notProductId : null;
  if (notProductId && !hasProduct(store, notProductId)) return { ok: false, reason: "product" };
  // "Only the people who got X, who have not got X" is nobody, every time.
  if (notProductId && notProductId === productId) return { ok: false, reason: "empty" };
  const who: Who = WHO.includes(input.who as Who) ? (input.who as Who) : "all";
  const asNarrowed = readNarrow(input.narrow);
  const narrow = isNarrowed(asNarrowed) ? asNarrowed : null;
  // A label as a file or a sequence writes one: cleaned, at most MAX_TAG_LENGTH; empty is none.
  const label = typeof input.label === "string" ? readTags([input.label])[0] ?? null : null;
  const now = Math.floor(Date.now() / 1000);
  let sendAt = now;
  if (input.sendAt !== undefined && input.sendAt !== null && input.sendAt !== "") {
    const at = Math.floor(Number(input.sendAt) / 1000);
    if (!Number.isFinite(at) || at < now - 60 || at > now + MAX_SCHEDULE_DAYS * 86_400) return { ok: false, reason: "when" };
    sendAt = Math.max(at, now);
  }
  // Due now exactly when advanceBroadcast takes it as due (sendAt <= now): any later, even by a minute, it is the
  // scheduled job's to start, so it is written down as scheduled.
  const startsNow = sendAt <= now;
  // Checked now for a send that starts now; a scheduled one is checked again when it starts.
  const keep = await keepFor(store, narrow, count);
  let reach: number;
  try {
    reach = (hold
      ? await countedAudience(hold, store.listId, productId ?? undefined, notProductId ?? undefined, whoOf(store, who), keep, label ?? undefined)
      : await audience(store.listId, productId ?? undefined, notProductId ?? undefined, whoOf(store, who), keep, label ?? undefined)).length;
  } catch (error) {
    // The list's size is paid for before it is read: when it is not there, nothing was read and nothing is written.
    if (error instanceof AudienceNotCounted) return { ok: false, reason: "studio_used", message: error.message };
    throw error;
  }
  if (reach === 0) return { ok: false, reason: "empty" };
  // A second subject line, when one was asked for. Refused here, with the
  // reason, whenever it could not be a real test: the creator finds out while
  // they can still change the email, not from a result that means nothing.
  const asked = newTest(input.test, subject, MAX_SUBJECT);
  if (asked === "subject") return { ok: false, reason: "test_subject" };
  const test = asked === "none" ? null : asked;
  if (test && reach < MIN_TEST_REACH) return { ok: false, reason: "test_small" };
  if (test && !linksToStore(body, store)) return { ok: false, reason: "test_links" };
  if (startsNow) {
    // The month as the plan counts it (lib/allowance-window.ts), the same window
    // reserve takes from and the studio shows; a window that cannot be told
    // leaves nothing, as reserve would refuse every batch of it. A count that cannot be read throws: never an untouched month.
    const window = windowId(store);
    const left = window ? monthlyAllowance(store) - (await usedThisMonthExact(store.listId, window)) : 0;
    if (reach > left) return { ok: false, reason: "allowance" };
  }
  const broadcast: Broadcast = {
    id: randomBytes(12).toString("hex"),
    listId: store.listId,
    handle: store.handle,
    subject,
    body,
    productId,
    notProductId,
    who,
    narrow,
    ...(label ? { label } : {}),
    status: "scheduled",
    createdAt: now,
    sendAt,
    finishedAt: 0,
    total: reach,
    sent: 0,
    note: "",
    failures: 0,
    listed: false,
    tagged: true,
    test,
  };
  // What the scheduled job's readings of the buyers will cost at the most, held in the month it goes out, before
  // anything is written. Given back if its room in the data room is not there (below), so a refusal holds nothing.
  if (narrow && count) {
    const units = (startsNow ? EXTRA_READS : READS_HELD) * (await ledgerReadingUnits(store));
    if (units > 0) {
      const held = await holdAllowanceAt(await refreshPeriod(store), "studio", units, sendAt * 1000).catch(() => null);
      if (!held?.ok) return { ok: false, reason: "studio_used", message: held?.message ?? "" };
      broadcast.hold = { window: held.window, units };
    }
  }
  // Its room in the store's data room first (DataRoomError when it does not
  // fit): its record, until it expires by itself (400 days after the last
  // change, which comes at the latest when it goes out), and its place in
  // the store's list of broadcasts.
  // Sized at the most the record can grow to: its longest note and status, and every count it keeps at its widest.
  const widest = Number.MAX_SAFE_INTEGER;
  const grown = { ...broadcast, status: "cancelled", note: "x".repeat(NOTE_ROOM), finishedAt: widest, total: widest, sent: widest, failures: widest, hold: { window: "0000-00-00", units: widest }, reads: widest, misses: widest, retryAt: widest };
  try {
    await needData(store, [
      { until: (now + (MAX_SCHEDULE_DAYS + RECORD_DAYS + 1) * 86_400) * 1000, bytes: dataBytes([JSON.stringify(grown)], 1) },
      { slot: "bc", bytes: dataBytes([broadcast.id], 1) },
    ]);
  } catch (error) {
    // Not written: what was held for it is given back, so the refusal costs nothing but the count just read.
    if (broadcast.hold) await giveAllowanceIn(store, "studio", broadcast.hold.units, broadcast.hold.window);
    throw error;
  }
  try {
    const saved = await redisPipeline([["SET", bcKey(broadcast.id), JSON.stringify(broadcast), "EX", RECORD_DAYS * 86_400]]);
    if (!Array.isArray(saved) || saved.length !== 1 || saved[0] !== "OK") throw new BroadcastWriteUnconfirmed();
    const indexed = await redisPipeline([
      ["LPUSH", listKey(store.listId), broadcast.id],
      ["SADD", QUEUE, broadcast.id],
    ]);
    if (!Array.isArray(indexed) || indexed.length !== 2 || typeof indexed[0] !== "number" || !Number.isSafeInteger(indexed[0]) || indexed[0] < 1 || (indexed[1] !== 0 && indexed[1] !== 1)) throw new BroadcastWriteUnconfirmed();
  } catch {
    // Do not retry or roll back: any of these writes may already have happened.
    throw new BroadcastWriteUnconfirmed();
  }
  return { ok: true, broadcast, keep, startsNow };
}

/** Stops a broadcast that has not started. One under way is not stopped halfway. */
export async function cancelBroadcast(store: Store, id: string): Promise<boolean> {
  if (!BROADCAST_ID.test(id) || !store.listId) return false;
  let acquired = false;
  try {
    acquired = await takeBroadcastLock(id);
    if (!acquired) return false;
    // Read only after acquiring the same lock used by the sender.
    const b = await readBroadcast(id);
    // Scheduled, or waiting before its list of who it goes to was made (the plan without email, the data room full):
    // nothing was sent, so it can still be called off. What it holds for its reading of the buyers and did not draw
    // is given back once the canceled record is written.
    if (!b || b.id !== id || b.listId !== store.listId || (b.status !== "scheduled" && b.status !== "waiting") || b.sent !== 0 || b.listed !== false) return false;
    const cancelled: Broadcast = { ...b, status: "cancelled", finishedAt: Math.floor(Date.now() / 1000), ...(b.hold ? { hold: { ...b.hold, units: 0 } } : {}) };
    const saved = await redisPipeline([["SET", bcKey(id), JSON.stringify(cancelled), "EX", RECORD_DAYS * 86_400]]);
    if (!Array.isArray(saved) || saved.length !== 1 || saved[0] !== "OK") throw new BroadcastCancellationUnconfirmed();
    const removed = await redisPipeline([["SREM", QUEUE, id]]);
    if (!Array.isArray(removed) || removed.length !== 1 || (removed[0] !== 0 && removed[0] !== 1)) throw new BroadcastCancellationUnconfirmed();
    // A list half written by a run cut short (written without its expiry) goes with it: best effort, the email is canceled either way.
    await redisPipeline([["DEL", toKey(id)]]).catch(() => {});
    if (b.hold?.units) await giveAllowanceIn(store, "studio", b.hold.units, b.hold.window);
    return true;
  } catch {
    // Either write may have happened: do not retry or restore a scheduled state.
    throw new BroadcastCancellationUnconfirmed();
  } finally {
    if (acquired) await redisPipeline([["DEL", lockKey(id)]]).catch(() => {});
  }
}


/** Only an explicit lock acknowledgement permits a reader to become a writer. */
async function takeBroadcastLock(id: string): Promise<boolean> {
  if (!BROADCAST_ID.test(id)) return false;
  const reply = await redisPipeline([["SET", lockKey(id), "1", "NX", "EX", 90]]);
  if (!Array.isArray(reply) || reply.length !== 1 || (reply[0] !== "OK" && reply[0] !== null)) throw new Error("Campaign lock could not be confirmed");
  return reply[0] === "OK";
}

/**
 * Moves one broadcast on for as long as `deadline` allows. Safe to call from
 * two places at once: only one holds the broadcast at a time.
 *
 * Its list of who it goes to reads the store's buyers when it is narrowed:
 * `given` is that narrowing, already read and counted when the broadcast was
 * written down in the same request (createBroadcast's `keep`), so it is
 * neither read nor counted twice. Otherwise every reading is paid in studio
 * requests before it is read: from what was held for it in the month it goes
 * out (`hold`, createBroadcast), and beyond that from the month it is read
 * in; when that month has none left, it waits for the next one that has,
 * saying so and when. Never read unpaid. A narrowed email due while the plan
 * is not paid and running is canceled, saying so, with nothing read or used.
 */
export async function advanceBroadcast(
  id: string,
  load: (handle: string) => Promise<Store | null>,
  deadline: number,
  given?: { keep: ((email: string) => boolean) | undefined },
): Promise<Broadcast | null> {
  const seconds = () => Math.floor(Date.now() / 1000);
  if (!await takeBroadcastLock(id)) return null;
  try {
    let b = await readBroadcastForWork(id);
    if (!b) {
      await redisPipeline([["SREM", QUEUE, id]]);
      return null;
    }
    if (b.status === "sent" || b.status === "cancelled" || b.status === "failed") {
      await redisPipeline([["SREM", QUEUE, id]]);
      return b;
    }
    const now = Math.floor(Date.now() / 1000);
    if (b.status === "scheduled" && b.sendAt > now) return b;
    // Waiting for a month's studio requests, or out a failed reading's wait: not tried, nothing read, before then.
    if (b.status === "waiting" && b.retryAt !== undefined && b.retryAt > now) return b;
    const store = await load(b.handle);
    if (!store || store.listId !== b.listId) {
      b = { ...b, status: "failed", note: "The store is not here anymore.", finishedAt: now };
      await save(b);
      await redisPipeline([["SREM", QUEUE, id]]);
      return b;
    }
    // An email due while the plan is not paid and running (ended, never started, its renewal unpaid or disputed) is
    // canceled, saying so, narrowed or to the whole list (owner, C3-108): nothing goes out after the plan ends, and a
    // plan switched on again later does not bring it back. A narrowed one's buyers are never read, nothing is taken,
    // and what it held for that month is given back. One part sent is stopped there, saying how many went. A trial
    // running is its plan's own month.
    const standing = costStandingOf(store, now);
    if (standing !== "paid" && standing !== "trial") {
      const held = b.hold;
      b = { ...b, status: "cancelled", note: b.sent > 0 ? planOffPartNote(b.sent, b.total) : b.narrow ? PLAN_OFF_NARROWED_NOTE : PLAN_OFF_NOTE, finishedAt: now, ...(held ? { hold: { ...held, units: 0 } } : {}) };
      await save(b);
      await redisPipeline([["SREM", QUEUE, id], ["DEL", toKey(id)]]);
      if (held?.units) await giveAllowanceIn(store, "studio", held.units, held.window);
      return b;
    }
    if (monthlyAllowance(store) === 0) {
      b = { ...b, status: "waiting", note: "Your plan does not include email right now. It goes out once Pro is on again." };
      await save(b);
      return b;
    }

    if (!b.listed) {
      if (b.sent !== 0) {
        b = { ...b, status: "waiting", note: "The recipient list needs review because this campaign already has recorded progress. Nothing more was sent." };
        await save(b);
        return b;
      }
      // Narrowed to buyers, and the store reads none any more: never sent without the narrowing (that would be to
      // everyone); canceled, saying why, with what it held given back.
      if (!given && isNarrowed(b.narrow) && !readsBuyers(store)) {
        const left = b.hold?.units ? b.hold : null;
        b = { ...b, status: "cancelled", note: NO_BUYERS_NOTE, finishedAt: now, ...(left ? { hold: { ...left, units: 0 } } : {}) };
        await save(b);
        await redisPipeline([["SREM", QUEUE, id], ["DEL", toKey(id)]]);
        if (left) await giveAllowanceIn(store, "studio", left.units, left.window);
        return b;
      }
      let keep = given?.keep;
      if (!given && isNarrowed(b.narrow)) {
        const read = await readNarrowing(b, store, now);
        if (read.stop) return read.stop;
        b = read.b;
        keep = read.keep;
      }
      const to = await audience(b.listId, b.productId ?? undefined, b.notProductId ?? undefined, whoOf(store, b.who), keep, b.label ?? undefined);
      let test = b.test;
      if (test) {
        if (to.length < MIN_TEST_REACH) {
          // Scheduled for a list that has shrunk since: everyone gets the
          // first subject, and the studio says no test was run.
          test = { ...test, skipped: true, a: 0, b: 0 };
        } else {
          // Who gets which subject is chance and nothing else: the list is
          // put in a random order once, here, and written down in it.
          shuffle(to);
          test = { ...test, ...splitFor(to.length, test.share) };
        }
      }
      // Who it goes to takes room in the store's data room until the list expires by itself.
      const taken = await takeData(store, [{ until: Date.now() + (RECIPIENT_DAYS + 1) * 86_400_000, bytes: dataBytes(to, to.length) }]);
      if (!taken.ok) {
        const full = taken.reason === "full";
        if (isNarrowed(b.narrow) && readsBuyers(store)) {
          // Each try reads the buyers again, paid: at most READS_HELD of them, an hour apart, and the note says so.
          const why = full ? "Your store's data room is full, so the list of who it goes to could not be made. Nothing was sent." : "The recipient list could not be prepared. Nothing was sent.";
          const left = READS_HELD - (b.reads ?? 0);
          if (left <= 0) {
            const held = b.hold?.units ? b.hold : null;
            b = { ...b, status: "failed", note: readsSpentNote(why), finishedAt: now, ...(held ? { hold: { ...held, units: 0 } } : {}) };
            await save(b);
            await redisPipeline([["SREM", QUEUE, id]]);
            if (held) await giveAllowanceIn(store, "studio", held.units, held.window);
            return b;
          }
          b = { ...b, status: "waiting", note: `${why} ${full ? "Make room: it" : "It"} is tried again in an hour, ${left === 1 ? "once more" : `${left} more times at most`}, then it stops.`, retryAt: now + LIST_RETRY_SECONDS };
        } else {
          b = { ...b, status: "waiting", note: full ? "Your store's data room is full, so the list of who it goes to could not be made. Nothing was sent. Make room, and it is tried again automatically." : "The recipient list could not be prepared. Nothing was sent. It will be checked again automatically." };
        }
        await save(b);
        return b;
      }
      const commands: (string | number)[][] = [["DEL", toKey(id)]];
      for (let i = 0; i < to.length; i += 500) commands.push(["RPUSH", toKey(id), ...to.slice(i, i + 500)]);
      commands.push(["EXPIRE", toKey(id), RECIPIENT_DAYS * 86_400]);
      try {
        const prepared = await redisPipeline(commands);
        if (!Array.isArray(prepared) || prepared.length !== commands.length || (prepared[0] !== 0 && prepared[0] !== 1) || prepared.at(-1) !== (to.length ? 1 : 0)) throw new Error("Recipient snapshot write is unconfirmed");
        let count = 0;
        for (let i = 1; i < commands.length - 1; i += 1) {
          count += commands[i].length - 2;
          if (prepared[i] !== count) throw new Error("Recipient snapshot is incomplete");
        }
      } catch {
        b = { ...b, status: "waiting", note: "The recipient list could not be prepared completely. Nothing was sent. It will be checked again automatically." };
        await save(b);
        return b;
      }
      const left = b.hold?.units ? b.hold : null;
      b = { ...b, status: "sending", total: to.length, note: "", listed: true, test, ...(left ? { hold: { ...left, units: 0 } } : {}) };
      await save(b);
      // Its list is made: what it held for its readings and did not draw is given back, once that is written down.
      if (left) await giveAllowanceIn(store, "studio", left.units, left.window);
    }
    if (b.status === "waiting") b = { ...b, status: "sending", note: "" };

    while (b.sent < b.total && Date.now() < deadline) {
      // With two subjects on trial the list has three parts, and a batch
      // never crosses from one into the next (lib/mail-test.ts).
      const running: SubjectTest | null = b.test && !b.test.skipped ? b.test : null;
      const { part, end } = running ? partAt(running, b.sent, b.total) : { part: "rest" as const, end: b.total };
      if (running && part === "rest" && !running.winner) {
        // The test's own emails have all gone. The rest wait for the hours
        // the creator chose, counted from now, and then get the better one.
        if (!running.endsAt) {
          b = { ...b, test: { ...running, endsAt: seconds() + running.hours * 3_600 } };
          await save(b);
        }
        if (seconds() < (b.test as SubjectTest).endsAt) {
          // No note: the studio says what is being waited for, with the
          // numbers and the time, from the test itself.
          b = { ...b, status: "waiting", note: "" };
          break;
        }
        const counted = await countTest(store, b);
        const chosen = chooseSubject(running, counted.visits, counted.sales);
        b = { ...b, test: { ...(b.test as SubjectTest), winner: chosen.winner, why: chosen.why, visits: counted.visits, sales: counted.sales } };
        // Written down before anything more is sent, so a run cut short here
        // cannot send half the rest under one subject and half under the other.
        await save(b);
        continue;
      }
      const subject = running && (part === "b" || (part === "rest" && running.winner === "b")) ? running.subjectB : b.subject;
      const campaign = part === "rest" ? broadcastCampaign(id) : variantCampaign(id, part);
      let emails: string[];
      try {
        const expected = Math.min(BATCH_SIZE, end - b.sent);
        const response = await redisPipeline([["LRANGE", toKey(id), b.sent, b.sent + expected - 1]]);
        if (!Number.isSafeInteger(expected) || expected < 1 || !Array.isArray(response) || response.length !== 1 || !Array.isArray(response[0])) throw new Error("Recipient batch is unavailable");
        const chunk: unknown[] = Array.from(response[0]);
        if (chunk.length !== expected || chunk.some(email => typeof email !== "string" || email.length > MAX_EMAIL_LENGTH || email !== normaliseEmail(email) || !EMAIL_PATTERN.test(email)) || new Set(chunk).size !== chunk.length) throw new Error("Recipient batch is incomplete or invalid");
        emails = chunk as string[];
      } catch {
        b = { ...b, status: "waiting", note: "The recipient list could not be read completely. Nothing more was sent. It will be checked again automatically." };
        break;
      }
      const result = await sendTo(
        store,
        emails,
        subject,
        b.body,
        `bc:${id}:${b.sent}`,
        // Only an email made since links were tagged: one scheduled before
        // goes out exactly as it was written and scheduled.
        b.tagged ? { medium: "broadcast", campaign } : undefined,
      );
      // Whatever went before a stop counts, so the next run starts after it.
      const processed = emails.length - result.rest.length;
      if (processed > 0) b = { ...b, sent: b.sent + processed };
      if (result.uncertain?.length) {
        // Once this existing terminal progress write is confirmed, later
        // workers must not repeat a batch the provider may already have taken.
        // Keep the recipient snapshot; an unconfirmed write/crash before this
        // checkpoint remains outside this safeguard.
        b = { ...b, status: "failed", finishedAt: now,
          note: "Sending could not be confirmed. Some emails may already have gone out. Automatic retries are stopped to avoid sending twice. The saved recipient list is retained." };
        break;
      }
      if (result.stopped === "allowance") {
        b = { ...b, status: "waiting", note: "This month's emails ran out. The rest go out when the month turns." };
        break;
      }
      if (result.stopped === "day") {
        b = { ...b, status: "waiting", note: "Going out in daily portions: the rest continue tomorrow, by themselves." };
        break;
      }
      if (result.stopped === "sender") {
        // Not this store's doing and not its month: the sender's own ceiling
        // (lib/mail.ts). It waits, and the scheduled job takes it up again.
        b = { ...b, status: "waiting", note: SENDER_WAIT_NOTE };
        break;
      }
      if (result.stopped === "portion") {
        // Addresses were brought into this list lately, so it goes out in
        // portions that double (lib/mail-health.ts); the next one opens by itself.
        b = { ...b, status: "waiting", note: PORTION_NOTE };
        break;
      }
      if (result.stopped === "paused") {
        // This store's own addresses (lib/mail-health.ts): it waits its week
        // out, and the scheduled job takes it up again.
        b = { ...b, status: "waiting", note: result.pause ? pauseNote(result.pause) : "Paused for now. The rest go out by themselves." };
        break;
      }
      if (result.stopped) {
        const failures = b.failures + 1;
        b = failures >= 5
          ? { ...b, status: "failed", failures, note: "The email service would not take it. Nothing more was sent.", finishedAt: now }
          : { ...b, status: "sending", failures, note: "Paused for a moment: the email service asked us to slow down." };
        break;
      }
      b = { ...b, failures: 0, note: "" };
      await save(b);
    }
    if (b.status === "sending" && b.sent >= b.total) {
      b = { ...b, status: "sent", finishedAt: Math.floor(Date.now() / 1000) };
    }
    await save(b);
    // Keep the snapshot until the terminal progress write is confirmed.
    if (b.status === "sent") await redisPipeline([["DEL", toKey(id)]]);
    if (b.status === "sent" || b.status === "failed") await redisPipeline([["SREM", QUEUE, id]]);
    return b;
  } finally {
    await redisPipeline([["DEL", lockKey(id)]]).catch(() => {});
  }
}

/**
 * Reads the buyers for a narrowed email's list in the scheduled job, paid
 * before it is read (advanceBroadcast): `stop` is the record, already saved,
 * when it must not go on now. Every part buyerLedger counts is drawn from the
 * email's hold when it is held in the month running now, and the rest taken
 * from that month (a hold made for another month is given back and the whole
 * taken from this one); each draw from the hold is written down before that
 * part is read, and lowers the hold in memory only once written. With no
 * studio requests left this month, it waits for the next month, saying when.
 * A hold made under a larger plan draws no more than the plan of this month
 * leaves for it (the rest given back). A reading that fails at Stripe or
 * PayPal keeps spent what it drew (pages may have been read) and is tried
 * again later, at most READ_MISSES_ALLOWED times in a row, saying so. At most
 * READS_HELD readings are made, then it stops, failed, saying why.
 */
async function readNarrowing(start: Broadcast, store: Store, now: number): Promise<{ stop: Broadcast; b?: undefined; keep?: undefined } | { stop?: undefined; b: Broadcast; keep: ((email: string) => boolean) | undefined }> {
  let b = start;
  const reads = b.reads ?? 0;
  if (reads >= READS_HELD) {
    const left = b.hold?.units ? b.hold : null;
    b = { ...b, status: "failed", note: readsSpentNote(b.note), finishedAt: now, ...(left ? { hold: { ...left, units: 0 } } : {}) };
    await save(b);
    await redisPipeline([["SREM", QUEUE, b.id]]);
    if (left) await giveAllowanceIn(store, "studio", left.units, left.window);
    return { stop: b };
  }
  const current = await refreshPeriod(store);
  const window = allowanceWindow(current, now * 1000);
  const wait = async (): Promise<{ stop: Broadcast }> => {
    b = { ...b, status: "waiting", note: LIST_WAIT_NOTE, retryAt: now + LIST_RETRY_SECONDS };
    await save(b);
    return { stop: b };
  };
  if (!window) return wait();
  // Held for another month than the one it is read in: given back there once that is written down, and this month pays.
  if (b.hold && b.hold.window !== window.id) {
    const stale = b.hold;
    b = { ...b, hold: { window: window.id, units: 0 } };
    await save(b);
    if (stale.units) await giveAllowanceIn(store, "studio", stale.units, stale.window);
  }
  let held = b.hold?.units ?? 0;
  if (held > 0) {
    // Held under the plan it was scheduled on: when this month's plan is smaller, the hold draws no more than this
    // month's figure leaves beside everything else taken in it; the rest is given back, once that is written down.
    const counts = await allowancesUsedStrict(current, ["studio"], now * 1000).catch(() => null);
    if (!counts) return wait();
    const [{ used, figure }] = counts;
    const usable = Math.max(0, Math.min(held, figure - (used - held)));
    if (usable < held) {
      b = { ...b, hold: { window: window.id, units: usable } };
      await save(b);
      await giveAllowanceIn(current, "studio", held - usable, window.id, now * 1000);
      held = usable;
    }
  }
  let refused: "used" | "other" | null = null;
  const draw = async (units: number): Promise<boolean> => {
    const fromHold = Math.min(units, held);
    const rest = units - fromHold;
    if (rest > 0) {
      const taken = await takeAllowance(current, "studio", rest, now * 1000).catch(() => null);
      if (!taken?.ok) {
        refused = taken?.reason === "used" ? "used" : "other";
        return false;
      }
    }
    if (fromHold > 0) {
      try {
        await save({ ...b, hold: { window: window.id, units: held - fromHold } });
      } catch {
        // Not written down: nothing drawn, the hold whole, and what this month gave taken back.
        if (rest > 0) await giveAllowance(current, "studio", rest, now * 1000);
        return false;
      }
      held -= fromHold;
    }
    return true;
  };
  const withHold = (units: number): Broadcast => (b.hold || units ? { ...b, hold: { window: window.id, units } } : b);
  let keep: ((email: string) => boolean) | undefined;
  try {
    keep = await keepFor(store, b.narrow, draw);
  } catch (error) {
    if (error instanceof LedgerNotCounted) {
      // Nothing more was read: this month has no studio requests left for it, or a draw could not be written down.
      // Nothing more was read: this month has no studio requests left for it (it waits for the next), or they could
      // not be counted, or a draw could not be written down (tried again in an hour).
      b = withHold(held);
      if (refused === "used") {
        b = { ...b, status: "waiting", note: studioWaitNote(opensAgainWords(window, now * 1000)), retryAt: Math.ceil(window.end / 1000) };
        await save(b);
        return { stop: b };
      }
      return wait();
    }
    // Stripe or PayPal did not answer, perhaps after some pages were read: what it drew stays spent. Tried again after
    // a wait that grows, READ_MISSES_ALLOWED times in a row at most; then it stops, failed, saying so.
    const misses = (b.misses ?? 0) + 1;
    console.error("reading a scheduled email's buyers failed", b.id, error);
    if (misses >= READ_MISSES_ALLOWED) {
      const left = held;
      b = { ...withHold(0), status: "failed", note: READ_GAVE_UP_NOTE, misses, finishedAt: now };
      delete b.retryAt;
      await save(b);
      await redisPipeline([["SREM", QUEUE, b.id]]);
      if (left) await giveAllowanceIn(current, "studio", left, window.id, now * 1000);
      return { stop: b };
    }
    b = { ...withHold(held), status: "waiting", note: READ_FAILED_NOTE, misses, retryAt: now + readRetry(misses) };
    await save(b);
    return { stop: b };
  }
  // Read and paid: one reading more, and no wait or failed reading left on it.
  const done: Broadcast = { ...withHold(held), reads: reads + 1 };
  delete done.retryAt;
  delete done.misses;
  return { b: done, keep };
}

/** Pages of sales a subject test decided by sales reads (countTest): within a reading of every sale (ALL_TIME_PAGES). */
export const TEST_SALES_PAGES = 5;

/** A random order, in place: every order as likely as any other. */
function shuffle(list: string[]): void {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
}

/**
 * What each subject line has brought so far: visits to the store, from the
 * store's own count of them, and sales, from the creator's own Stripe
 * account. Either is null when it could not be read; neither is guessed.
 * Sales are read only for a test that is decided by them.
 */
export async function countTest(store: Store, b: Broadcast): Promise<{ visits: Counted; sales: Counted }> {
  const a = variantCampaign(b.id, "a");
  const bee = variantCampaign(b.id, "b");
  let visits: Counted = null;
  let sales: Counted = null;
  try {
    // Every day the test could have been running on, and one to spare.
    const days = Math.ceil((Date.now() / 1000 - b.sendAt) / 86_400) + 2;
    const views = await campaignViews(store.statsId, [a, bee], days);
    if (views) visits = { a: views[a] ?? 0, b: views[bee] ?? 0 };
  } catch (error) {
    console.error("reading a subject test's visits failed", error);
  }
  if (b.test?.by === "sales" && store.stripeAccountId) {
    try {
      // Paid in the store's studio requests before it is read, as a reading of every sale is (TEST_SALES_PAGES of
      // its pages, within that); without them the sales are not read, and the test is decided without them.
      const kept = await paypalKept(store.statsId, Boolean(store.paypalSeller));
      const units = BUYER_LEDGER_UNITS + ledgerUnits(ledgerReadBytes({ imported: 0, paypalSales: kept.sales, paypalRefunds: 0 }));
      const paid = await takeAllowance(await refreshPeriod(store), "studio", units);
      if (!paid.ok) throw new Error("a subject test's sales were not read: its studio requests could not be counted");
      const read = await readPaidSales(store, b.sendAt - 60, TEST_SALES_PAGES);
      const by = moneyByCampaign(read.sales, store.currency);
      // A count of sales, so a sale in another currency counts too; no amount is added (22 [E5], unit 2d).
      sales = { a: (by[a]?.sales ?? 0) + (by[a]?.elsewhere ?? 0), b: (by[bee]?.sales ?? 0) + (by[bee]?.elsewhere ?? 0) };
    } catch (error) {
      console.error("reading a subject test's sales failed", error);
    }
  }
  return { visits, sales };
}

/** Moves every waiting or scheduled broadcast on. For the scheduled job. */
export async function advanceAll(load: (handle: string) => Promise<Store | null>, deadline: number): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const response = await redisPipeline([["SMEMBERS", QUEUE]]);
  if (!Array.isArray(response) || response.length !== 1 || !Array.isArray(response[0])) throw new Error("Campaign queue is unavailable");
  const ids: unknown[] = Array.from(response[0]);
  if (ids.some(id => typeof id !== "string" || !BROADCAST_ID.test(id)) || new Set(ids).size !== ids.length) throw new Error("Campaign queue is invalid");
  let touched = 0;
  for (const id of ids) {
    if (Date.now() > deadline) break;
    try {
      if (await advanceBroadcast(id as string, load, deadline)) touched += 1;
    } catch {
      // Do not retry uncertain work in this pass or block unrelated campaigns.
      console.error("Advancing a queued campaign failed", id);
    }
  }
  return touched;
}
