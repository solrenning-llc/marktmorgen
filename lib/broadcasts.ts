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
import { needData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { WHO, type Who, audience, readTags } from "@/lib/contacts";
import { PORTION_NOTE, pauseNote } from "@/lib/mail-health";
import { BATCH_SIZE, MAX_MAIL_BODY, MAX_SUBJECT, SENDER_WAIT_NOTE, monthlyAllowance, sendTo, usedThisMonth } from "@/lib/mail";
import { windowId } from "@/lib/allowance-window";
import type { Store } from "@/lib/store";
import { hasProduct, idsOfKind } from "@/lib/catalog";
import { broadcastCampaign, isOwnLink, variantCampaign } from "@/lib/mail-links";
import { type Counted, type SubjectTest, MIN_TEST_REACH, chooseSubject, newTest, parseTest, partAt, splitFor } from "@/lib/mail-test";
import { campaignViews, readPaidSales } from "@/lib/stats";
import { moneyByCampaign } from "@/lib/mail-revenue";
import { type Narrow, isNarrowed, keepFor, readNarrow } from "@/lib/segments";
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

/** The store's broadcasts, newest first. */
export async function listBroadcasts(listId: string | null, limit = 30): Promise<Broadcast[]> {
  if (!listId || !isRedisConfigured()) return [];
  const [ids] = await redisPipeline([["LRANGE", listKey(listId), 0, limit - 1]]);
  const list = Array.isArray(ids) ? (ids as string[]) : [];
  if (!list.length) return [];
  const rows = await redisPipeline(list.map((id) => ["GET", bcKey(id)]));
  return rows.map(parse).filter((b): b is Broadcast => b !== null);
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
export async function listBroadcastsStrict(listId: string | null, limit = 30): Promise<Broadcast[]> {
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
  return ids.map((id, i) => parseStoredBroadcast(rows[i], id as string, listId));
}

/**
 * Who a kind of reader is, for this store today: the products sold for money
 * come from the store's own index, so nothing is read to know them.
 */
export function whoOf(store: Store, kind: Who): { kind: Who; paid: ReadonlySet<string> } | undefined {
  return kind === "all" ? undefined : { kind, paid: new Set(idsOfKind(store, "paid")) };
}

export type CreateResult =
  | { ok: true; broadcast: Broadcast }
  | { ok: false; reason: "subject" | "body" | "when" | "product" | "empty" | "allowance" | "setup" | "plan" | "test_subject" | "test_small" | "test_links" | "placeholder" };

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

/** Writes a broadcast down to go now or later. What it may contain is checked here. */
export async function createBroadcast(
  store: Store,
  input: { subject: unknown; body: unknown; productId: unknown; notProductId: unknown; sendAt: unknown; who?: unknown; test?: unknown; narrow?: unknown; label?: unknown },
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
  // Checked now for a send that starts now; a scheduled one is checked again when it starts.
  const reach = (await audience(store.listId, productId ?? undefined, notProductId ?? undefined, whoOf(store, who), await keepFor(store, narrow), label ?? undefined)).length;
  if (reach === 0) return { ok: false, reason: "empty" };
  // A second subject line, when one was asked for. Refused here, with the
  // reason, whenever it could not be a real test: the creator finds out while
  // they can still change the email, not from a result that means nothing.
  const asked = newTest(input.test, subject, MAX_SUBJECT);
  if (asked === "subject") return { ok: false, reason: "test_subject" };
  const test = asked === "none" ? null : asked;
  if (test && reach < MIN_TEST_REACH) return { ok: false, reason: "test_small" };
  if (test && !linksToStore(body, store)) return { ok: false, reason: "test_links" };
  if (sendAt <= now + 60) {
    // The month as the plan counts it (lib/allowance-window.ts), the same window
    // reserve takes from and the studio shows; a window that cannot be told
    // leaves nothing, as reserve would refuse every batch of it.
    const window = windowId(store);
    const left = window ? monthlyAllowance(store) - (await usedThisMonth(store.listId, window)) : 0;
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
  // Its room in the store's data room first (DataRoomError when it does not
  // fit): its record, until it expires by itself (400 days after the last
  // change, which comes at the latest when it goes out), and its place in
  // the store's list of broadcasts.
  await needData(store, [
    { until: (now + (MAX_SCHEDULE_DAYS + RECORD_DAYS + 1) * 86_400) * 1000, bytes: dataBytes([JSON.stringify({ ...broadcast, note: "x".repeat(300) })], 1) },
    { slot: "bc", bytes: dataBytes([broadcast.id], 1) },
  ]);
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
  return { ok: true, broadcast };
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
    if (!b || b.id !== id || b.listId !== store.listId || b.status !== "scheduled" || b.sent !== 0 || b.listed !== false) return false;
    const cancelled = { ...b, status: "cancelled", finishedAt: Math.floor(Date.now() / 1000) };
    const saved = await redisPipeline([["SET", bcKey(id), JSON.stringify(cancelled), "EX", RECORD_DAYS * 86_400]]);
    if (!Array.isArray(saved) || saved.length !== 1 || saved[0] !== "OK") throw new BroadcastCancellationUnconfirmed();
    const removed = await redisPipeline([["SREM", QUEUE, id]]);
    if (!Array.isArray(removed) || removed.length !== 1 || (removed[0] !== 0 && removed[0] !== 1)) throw new BroadcastCancellationUnconfirmed();
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
 */
export async function advanceBroadcast(
  id: string,
  load: (handle: string) => Promise<Store | null>,
  deadline: number,
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
    const store = await load(b.handle);
    if (!store || store.listId !== b.listId) {
      b = { ...b, status: "failed", note: "The store is not here anymore.", finishedAt: now };
      await save(b);
      await redisPipeline([["SREM", QUEUE, id]]);
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
      const to = await audience(b.listId, b.productId ?? undefined, b.notProductId ?? undefined, whoOf(store, b.who), await keepFor(store, b.narrow), b.label ?? undefined);
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
        b = { ...b, status: "waiting", note: taken.reason === "full" ? "Your store's data room is full, so the list of who it goes to could not be made. Nothing was sent. Make room, and it is tried again automatically." : "The recipient list could not be prepared. Nothing was sent. It will be checked again automatically." };
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
      b = { ...b, status: "sending", total: to.length, note: "", listed: true, test };
      await save(b);
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
async function countTest(store: Store, b: Broadcast): Promise<{ visits: Counted; sales: Counted }> {
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
      const read = await readPaidSales(store, b.sendAt - 60, 5);
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
