/**
 * "Apply first" (604 [WP3]) applications, kept (the rules are in
 * lib/apply-first-rules.ts). Nothing here opens a checkout or sends an email:
 * those come in later units, on top of what this file keeps and answers.
 *
 *   nl:apply:r:<sid>:<id>        string  one application: the address it was sent from and its record
 *                                        (APPLY_RECORD_MAX_BYTES at most), until it is no longer needed (untilOf)
 *   nl:apply:s:<sid>             zset    the store's applications: id → when its record goes
 *                                        (APPLY_MAX_KEPT at most), for the creator's list;
 *                                        it expires with the last record it names
 *   nl:apply:p:<sid>:<person>    zset    one address's applications in the store (lib/person-key.ts):
 *                                        id → when its record goes (APPLY_MAX_PER_PERSON at most),
 *                                        for the cap, the deletion and the copy of a person's data
 *   nl:apply:d:<sid>:<day>       string  how many applications the store took that UTC day
 *                                        (APPLY_PER_STORE_DAY at most), kept two days
 *   nl:apply:on:<sid>            set     the store's products that ask for an application first
 *                                        (MAX_PRODUCTS at most); only read here, written by the
 *                                        studio's product setting (a later unit)
 *
 * Every key has an expiry, set in the same step that writes it. A record is
 * written by one script on the Redis side (NEW): the store's and the person's
 * caps are checked and the record and both index entries written together,
 * or nothing is written. Before that, the store's count for the day is taken,
 * so a burst of applications is refused before anything else is kept. A
 * decision is written only over the record as it was read (CHANGE), so two
 * presses at once, or a press after the person was deleted, never write a
 * record back.
 *
 * Unknown is never a yes (CX-123 rule 24): a reply that is not exactly what
 * was asked for is read back where a write may have landed, and is otherwise
 * "unavailable" (a write) or null / UnknownReplyError (a read), never an empty
 * list, a saved application or a person with nothing kept.
 *
 * The record also keeps the exact sentence the person agreed to and its
 * version (APPLY_CONSENT_TEXT, APPLY_CONSENT_VERSION), at the time they
 * applied: an application is never kept without it.
 *
 * The record keeps the address the person applied with, because the creator
 * must see who applied and the approved person must be sent their link. The
 * link's token is never kept: an approval answers it once, to the caller that
 * sends it (a later unit), and the record keeps only its digest. So that an
 * approval which landed while its answer was lost never leaves a link nobody
 * holds, the press may carry a key (APPROVAL_KEY): the record keeps that key's
 * digest, and the same press sent again finds its own approval and answers a
 * fresh token in place of the kept one, so the lost one stops working.
 */
import { createHash, randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { personKey } from "@/lib/person-key";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, listSlots, repliesFor, stringList } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import {
  APPLICATION_ID,
  APPLY_LINK_DAYS_DEFAULT,
  APPLY_LINK_DAYS_MAX,
  APPLY_LINK_DAYS_MIN,
  type Application,
  type ApplicationState,
  applicantDigest,
  applyTokenDigest,
  newApplication,
  newApplyToken,
  nextApplication,
  parseApplication,
} from "@/lib/apply-first-rules";

const DAY = 86_400_000;
/** How long an application waits for the creator's answer, from when it was sent. */
export const APPLY_KEEP_DAYS = 60;
/** How long a decided application stays on the creator's list after its decision, or after its link's end. */
export const APPLY_AFTER_DAYS = 30;
/** Applications a store takes in one UTC day: counted before anything is kept. */
export const APPLY_PER_STORE_DAY = 200;
/** Applications a store keeps at once. */
export const APPLY_MAX_KEPT = 500;
/** Applications one address keeps in one store at once. */
export const APPLY_MAX_PER_PERSON = 5;
/** The largest stored application: the rules' record (2 KB at most) with the address and the sentence agreed to, written once more as text. */
export const APPLY_RECORD_MAX_BYTES = 3_072;
/** The day count's life: the day it counts and the next. */
export const APPLY_DAY_SECONDS = 2 * 86_400;
/**
 * The most Redis commands each call runs, scripts' own commands included, for
 * the cost line of the route that calls it (a later unit): sending one is the
 * day count (2), the script (1 and 12 inside) and a read back when its reply
 * is unknown (1); a decision is its read (1), the script (1 and 8 inside) and
 * a read back (1); the creator's list is 2; a person's copy is 2; a person's
 * deletion is its read (1), a DEL for each id its index can name (twice
 * APPLY_MAX_PER_PERSON) and the two index removals (2).
 */
export const APPLY_SUBMIT_COMMANDS = 16;
export const APPLY_DECIDE_COMMANDS = 11;
/** The mode's read on a product (SISMEMBER), before an application is kept. */
export const APPLY_MODE_COMMANDS = 1;
/**
 * Public requests one application takes before anything about it is read
 * (app/api/store/apply/route.ts): its own commands, the mode's read, the
 * connection's hourly count and the product's read, held under the price of
 * that many later pages in tests/apply-first-routes.test.ts.
 */
export const APPLY_SUBMIT_REQUEST_UNITS = 2;
/**
 * Studio requests a decision takes more than the one its door counts
 * (app/api/store/applications/route.ts): its commands with the door's own
 * stay inside two studio requests, held in tests/apply-first-routes.test.ts.
 */
export const APPLY_DECIDE_STUDIO_UNITS = 1;

/** Applications sent from one connection to one store in an hour (app/api/store/apply/route.ts). */
export const APPLY_PER_CONNECTION_HOUR = 10;
/** What the product's page is told, in its address, about an application; never anything typed. */
export type ApplyStatus = "sent" | "email" | "consent" | "closed" | "busy" | "limited" | "full" | "person" | "error";

/** The version of the sentence an applicant agrees to; bumped whenever its words change. */
export const APPLY_CONSENT_VERSION = "apply-first-1";
/** The sentence itself, kept with every application as it was shown. */
export const APPLY_CONSENT_TEXT =
  "Keep my email address with my application, so the creator can read it and email me their answer.";
/** Every version's words, so a kept application is read only with the words it was given under. */
const CONSENT_WORDS: Readonly<Record<string, string>> = { [APPLY_CONSENT_VERSION]: APPLY_CONSENT_TEXT };
export const APPLY_LIST_COMMANDS = 2;
export const APPLY_COPY_COMMANDS = 2;
export const APPLY_FORGET_COMMANDS = 1 + APPLY_MAX_PER_PERSON * 2 + 2;

const recordKey = (sid: string, id: string) => `nl:apply:r:${sid}:${id}`;
const storeIndex = (sid: string) => `nl:apply:s:${sid}`;
const personIndex = (sid: string, email: string) => `nl:apply:p:${sid}:${personKey(sid, email)}`;
const modeKey = (sid: string) => `nl:apply:on:${sid}`;
const dayKey = (sid: string, now: number) => `nl:apply:d:${sid}:${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}`;

/**
 * A new application, in one step: 3 when its id is taken already (nothing
 * written); 4 when the store keeps APPLY_MAX_KEPT; 5 when the address keeps
 * APPLY_MAX_PER_PERSON; 1 written, with both index entries. Index entries
 * whose record is gone (their score is past) leave first. Each index's expiry
 * is only ever moved later, to the record's own, so an index goes with the
 * last record it names. The first line names it for a stand-in.
 */
export const APPLY_NEW =
  "-- marktmorgen:apply-first-new:v1\n" +
  'if redis.call("EXISTS", KEYS[1]) ~= 0 then return 3 end\n' +
  'redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", ARGV[5])\n' +
  'redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", ARGV[5])\n' +
  'if redis.call("ZCARD", KEYS[2]) >= tonumber(ARGV[6]) then return 4 end\n' +
  'if redis.call("ZCARD", KEYS[3]) >= tonumber(ARGV[7]) then return 5 end\n' +
  'redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])\n' +
  'redis.call("ZADD", KEYS[2], ARGV[4], ARGV[1])\n' +
  'redis.call("ZADD", KEYS[3], ARGV[4], ARGV[1])\n' +
  'if redis.call("TTL", KEYS[2]) < tonumber(ARGV[3]) then redis.call("EXPIRE", KEYS[2], ARGV[3]) end\n' +
  'if redis.call("TTL", KEYS[3]) < tonumber(ARGV[3]) then redis.call("EXPIRE", KEYS[3], ARGV[3]) end\n' +
  "return 1";

/**
 * A decision, written only over the record as it was read: 0 when the record
 * is not that (changed, or deleted), nothing written; 1 written, its index
 * entries moved to when it now goes, each index's expiry only moved later.
 */
export const APPLY_CHANGE =
  "-- marktmorgen:apply-first-change:v1\n" +
  'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end\n' +
  'redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])\n' +
  'redis.call("ZADD", KEYS[2], ARGV[4], ARGV[5])\n' +
  'redis.call("ZADD", KEYS[3], ARGV[4], ARGV[5])\n' +
  'if redis.call("TTL", KEYS[2]) < tonumber(ARGV[3]) then redis.call("EXPIRE", KEYS[2], ARGV[3]) end\n' +
  'if redis.call("TTL", KEYS[3]) < tonumber(ARGV[3]) then redis.call("EXPIRE", KEYS[3], ARGV[3]) end\n' +
  "return 1";

/** What the creator's list and the person's copy show of one application. Never the link's token. */
export type ApplicationView = {
  id: string;
  offer: string;
  email: string;
  state: ApplicationState;
  at: number;
  decidedAt: number;
  expiresAt: number;
  usedAt: number;
  /** The sentence they agreed to when they applied, and its version. */
  consent: { text: string; version: string };
};

/** One press of "approve" (16 random bytes, hex), chosen by the caller and sent again with the same press. */
export const APPROVAL_KEY = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * op: the digest of the key of the press that approved it (approvalDigest),
 * kept only while approved or used, never the key itself.
 */
type Kept = { email: string; app: Application; consent: { text: string; version: string }; op?: string };

/** What the record keeps of a press's key: bound to the store and the application, under this file's own label. */
function approvalDigest(sid: string, id: string, key: string): string {
  return createHash("sha256").update(`nimbus-apply-first-approval:${sid}:${id}:${key}`).digest("hex");
}

/** When an application's record is no longer needed: it waits KEEP days, and a decision or a link adds AFTER days. */
export function untilOf(app: Application): number {
  return Math.max(
    app.at + APPLY_KEEP_DAYS * DAY,
    app.decidedAt ? app.decidedAt + APPLY_AFTER_DAYS * DAY : 0,
    app.expiresAt ? app.expiresAt + APPLY_AFTER_DAYS * DAY : 0,
  );
}

const seconds = (until: number, now: number) => Math.max(60, Math.ceil((until - now) / 1000));

/** The stored text: the address and the rules' record, in one fixed shape. */
function storedText(kept: Kept): string {
  return JSON.stringify({
    v: 1, email: kept.email, app: JSON.stringify(kept.app), consent: { text: kept.consent.text, version: kept.consent.version },
    ...(kept.op ? { op: kept.op } : {}),
  });
}

/**
 * Reads a stored application, or null when it is not exactly one this file
 * wrote for this id: too long, another shape or order, a field named twice,
 * a record the rules do not read, or an address that is not the one its
 * record's digest was made from.
 */
function readKept(raw: unknown, id: string): Kept | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > APPLY_RECORD_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { v, email, app, consent, op } = value as Record<string, unknown>;
  if (v !== 1 || typeof email !== "string" || typeof app !== "string" || !consent || typeof consent !== "object") return null;
  const { text, version } = consent as Record<string, unknown>;
  if (typeof text !== "string" || typeof version !== "string" || !Object.hasOwn(CONSENT_WORDS, version) || CONSENT_WORDS[version] !== text) return null;
  if (op !== undefined && (typeof op !== "string" || !DIGEST.test(op))) return null;
  // Written exactly as storedText writes it, or it was not written here.
  if (JSON.stringify({ v: 1, email, app, consent: { text, version }, ...(op ? { op } : {}) }) !== raw) return null;
  const parsed = parseApplication(app);
  if (!parsed || parsed.id !== id || normaliseEmail(email) !== email || applicantDigest(email) !== parsed.applicant) return null;
  if (op && parsed.state !== "approved" && parsed.state !== "used") return null;
  return op ? { email, app: parsed, consent: { text, version }, op } : { email, app: parsed, consent: { text, version } };
}

function viewOf(kept: Kept): ApplicationView {
  const { id, offer, state, at, decidedAt, expiresAt, usedAt } = kept.app;
  return { id, offer, email: kept.email, state, at, decidedAt, expiresAt, usedAt, consent: { ...kept.consent } };
}

/** A pipeline's one reply read back after an unknown answer: the key holding exactly `value` means it landed. */
async function landed(key: string, value: string): Promise<boolean> {
  try {
    const back = repliesFor(await redisPipeline([["GET", key]]), 1);
    return !!back && back[0] === value;
  } catch {
    return false;
  }
}

export type Submitted =
  | { ok: true; application: ApplicationView }
  | { ok: false; reason: "bad-input" | "consent" | "day" | "full" | "person" | "unavailable" };

/**
 * Keeps one application from the form, within the store's day, the store's
 * and the address's caps. "day" is refused before anything else is kept.
 */
export async function submitApplication(
  store: Pick<Store, "sid">,
  input: { offer: string; email: string; consentVersion: string },
  now = Date.now(),
): Promise<Submitted> {
  if (!store.sid || !isRedisConfigured()) return { ok: false, reason: "unavailable" };
  // Kept only with the sentence the person agreed to, in the version they were shown.
  if (input.consentVersion !== APPLY_CONSENT_VERSION) return { ok: false, reason: "consent" };
  const sid = store.sid;
  const app = newApplication({ id: randomBytes(16).toString("hex"), offer: input.offer, email: input.email, now });
  if (!app) return { ok: false, reason: "bad-input" };
  const kept: Kept = { email: normaliseEmail(input.email), app, consent: { text: APPLY_CONSENT_TEXT, version: APPLY_CONSENT_VERSION } };
  const text = storedText(kept);
  if (Buffer.byteLength(text, "utf8") > APPLY_RECORD_MAX_BYTES || !readKept(text, app.id)) return { ok: false, reason: "bad-input" };
  try {
    // The day's count first: a store past it keeps nothing more today.
    const day = dayKey(sid, now);
    const counted = repliesFor(await redisPipeline([["INCR", day], ["EXPIRE", day, APPLY_DAY_SECONDS]]), 2);
    const taken = counted ? countOf(counted[0]) : null;
    if (!counted || taken === null || taken < 1 || counted[1] !== 1) return { ok: false, reason: "unavailable" };
    if (taken > APPLY_PER_STORE_DAY) return { ok: false, reason: "day" };
    const until = untilOf(app);
    const key = recordKey(sid, app.id);
    const reply = repliesFor(await redisPipeline([[
      "EVAL", APPLY_NEW, 3, key, storeIndex(sid), personIndex(sid, kept.email),
      app.id, text, seconds(until, now), until, now, APPLY_MAX_KEPT, APPLY_MAX_PER_PERSON,
    ]]), 1);
    const answer = reply?.[0];
    if (answer === 1) return { ok: true, application: viewOf(kept) };
    if (answer === 4) return { ok: false, reason: "full" };
    if (answer === 5) return { ok: false, reason: "person" };
    if (answer === 3) return { ok: false, reason: "unavailable" };
    // Answered in another shape, or not at all: the script may have run. Only the record itself says so.
    return (await landed(key, text)) ? { ok: true, application: viewOf(kept) } : { ok: false, reason: "unavailable" };
  } catch (error) {
    console.error("keeping an application failed", error);
    return { ok: false, reason: "unavailable" };
  }
}

export type Decided =
  | { ok: true; application: ApplicationView; token?: string }
  | { ok: false; reason: "gone" | "final" | "still-open" | "bad-input" | "changed" | "unavailable" };

/**
 * The creator's answer to one of the store's applications. Approving answers
 * the new link's token, once: it is not kept, so whoever sends the link must
 * take it from here. "changed": the application changed or was deleted while
 * this was decided, and nothing was written.
 *
 * An approval whose answer was lost is read back: kept exactly as proposed, it
 * answers the token still in hand; otherwise "unavailable", never approved
 * without a link. An approval sent with `key` keeps that key's digest; the
 * same press sent again with the same key, while its link is open and unused,
 * is that approval: a fresh token replaces the kept digest (the token nobody
 * holds stops working) and is answered. Any other press on an open link is
 * "still-open", as before.
 */
export async function decideApplication(
  store: Pick<Store, "sid">,
  id: string,
  step: { kind: "approve"; days?: number; key?: string } | { kind: "decline" },
  now = Date.now(),
): Promise<Decided> {
  if (!store.sid || !isRedisConfigured()) return { ok: false, reason: "unavailable" };
  if (typeof id !== "string" || !APPLICATION_ID.test(id)) return { ok: false, reason: "gone" };
  const sid = store.sid;
  const key = recordKey(sid, id);
  const press = step.kind === "approve" ? step.key : undefined;
  if (press !== undefined && (typeof press !== "string" || !APPROVAL_KEY.test(press))) return { ok: false, reason: "bad-input" };
  const op = press === undefined ? "" : approvalDigest(sid, id, press);
  try {
    const read = repliesFor(await redisPipeline([["GET", key]]), 1);
    if (!read) return { ok: false, reason: "unavailable" };
    if (read[0] === null) return { ok: false, reason: "gone" };
    const kept = readKept(read[0], id);
    if (!kept) return { ok: false, reason: "unavailable" };
    const token = step.kind === "approve" ? newApplyToken() : "";
    const days = step.kind === "approve" ? step.days ?? APPLY_LINK_DAYS_DEFAULT : 0;
    const retry = step.kind === "approve" && op !== "" && kept.op === op && kept.app.state === "approved" &&
      kept.app.usedAt === 0 && now < kept.app.expiresAt;
    const answer = retry
      ? reissued(kept.app, now, days, token)
      : step.kind === "approve"
        ? nextApplication(kept.app, { kind: "approve", now, days, token })
        : step.kind === "decline" ? nextApplication(kept.app, { kind: "decline", now }) : null;
    if (!answer) return { ok: false, reason: "bad-input" };
    if (!answer.ok) {
      if (answer.why === "final" || answer.why === "still-open" || answer.why === "bad-input") return { ok: false, reason: answer.why };
      return { ok: false, reason: "unavailable" };
    }
    // A decline drops the press's digest with the link; an approval keeps its own press's, or none.
    const next: Kept = answer.next.state === "approved" && op
      ? { email: kept.email, app: answer.next, consent: kept.consent, op }
      : { email: kept.email, app: answer.next, consent: kept.consent };
    const text = storedText(next);
    if (Buffer.byteLength(text, "utf8") > APPLY_RECORD_MAX_BYTES) return { ok: false, reason: "unavailable" };
    // A record's life only grows: a decline after an approval keeps the longer one, so its index entries, and the
    // indexes themselves, never outlive or undercount it.
    const until = Math.max(untilOf(kept.app), untilOf(next.app));
    let reply: unknown[] | null;
    try {
      reply = repliesFor(await redisPipeline([[
        "EVAL", APPLY_CHANGE, 3, key, storeIndex(sid), personIndex(sid, kept.email),
        read[0] as string, text, seconds(until, now), until, id,
      ]]), 1);
    } catch (error) {
      // The script may have run and only its answer been lost: the record read back below decides.
      console.error("deciding an application: the write's answer was lost", error);
      reply = null;
    }
    const done = { ok: true as const, application: viewOf(next), ...(token ? { token } : {}) };
    if (reply?.[0] === 1) return done;
    if (reply?.[0] === 0) return { ok: false, reason: "changed" };
    return (await landed(key, text)) ? done : { ok: false, reason: "unavailable" };
  } catch (error) {
    console.error("deciding an application failed", error);
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * The same approval's link given again: a fresh token over the open link the
 * same press wrote, for the days it asks for, from now. The rules read the
 * result exactly (parseApplication); anything they refuse is unknown.
 */
function reissued(app: Application, now: number, days: number, token: string): ReturnType<typeof nextApplication> {
  if (!Number.isSafeInteger(days) || days < APPLY_LINK_DAYS_MIN || days > APPLY_LINK_DAYS_MAX || now < app.decidedAt) return { ok: false, why: "bad-input" };
  const next = parseApplication(JSON.stringify({ ...app, decidedAt: now, expiresAt: now + days * DAY, tokenDigest: applyTokenDigest(token) }));
  return next && next.tokenDigest !== app.tokenDigest ? { ok: true, next } : { ok: false, why: "unknown" };
}

/**
 * Whether a product of the store asks for an application before it is bought:
 * one SISMEMBER, read exactly. Anything but 0 or 1 throws UnknownReplyError,
 * never "no" or "yes". No store id or no database is "no": nothing is taken.
 */
export async function isApplyFirst(store: Pick<Store, "sid">, productId: string): Promise<boolean> {
  if (!store.sid || !isRedisConfigured() || typeof productId !== "string" || !productId) return false;
  const reply = repliesFor(await redisPipeline([["SISMEMBER", modeKey(store.sid), productId]]), 1);
  if (!reply || (reply[0] !== 0 && reply[0] !== 1)) throw new UnknownReplyError("whether a product asks for an application");
  return reply[0] === 1;
}

/** The ids an index names, read exactly: a list of application ids, or UnknownReplyError. */
function idsOf(reply: unknown, most: number, what: string): string[] {
  const ids = stringList(reply);
  if (!ids || ids.length > most || new Set(ids).size !== ids.length || !ids.every((id) => APPLICATION_ID.test(id))) {
    throw new UnknownReplyError(what);
  }
  return ids;
}

/** The records of these ids, read exactly: each a stored application, or null when it is gone; else UnknownReplyError. */
async function keptOf(sid: string, ids: string[], what: string): Promise<(Kept | null)[]> {
  const read = repliesFor(await redisPipeline([["MGET", ...ids.map((id) => recordKey(sid, id))]]), 1);
  const values = read ? listSlots(read[0]) : null;
  if (!values || values.length !== ids.length) throw new UnknownReplyError(what);
  return values.map((raw, i) => {
    if (raw === null) return null;
    const kept = readKept(raw, ids[i]);
    if (!kept) throw new UnknownReplyError(what);
    return kept;
  });
}

/**
 * The store's applications still kept, in the order they were sent, for the
 * creator; null when they cannot be read exactly. Only reads.
 */
export async function listApplications(store: Pick<Store, "sid">, now = Date.now()): Promise<ApplicationView[] | null> {
  if (!store.sid || !isRedisConfigured()) return null;
  const sid = store.sid;
  const what = "a store's applications";
  try {
    const index = repliesFor(await redisPipeline([["ZRANGEBYSCORE", storeIndex(sid), `(${now}`, "+inf", "LIMIT", 0, APPLY_MAX_KEPT]]), 1);
    if (!index) throw new UnknownReplyError(what);
    const ids = idsOf(index[0], APPLY_MAX_KEPT, what);
    if (!ids.length) return [];
    const kept = await keptOf(sid, ids, what);
    return kept
      .filter((k): k is Kept => k !== null)
      .map(viewOf)
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  } catch (error) {
    console.error("reading applications failed", error);
    return null;
  }
}

/** The ids of one address's applications in the store, read exactly, or UnknownReplyError. */
async function personIds(sid: string, email: string, what: string): Promise<string[]> {
  const index = repliesFor(await redisPipeline([["ZRANGEBYSCORE", personIndex(sid, email), "-inf", "+inf"]]), 1);
  if (!index) throw new UnknownReplyError(what);
  // The cap is checked when one is added; twice it is room for entries whose record is gone and not yet taken out.
  return idsOf(index[0], APPLY_MAX_PER_PERSON * 2, what);
}

/**
 * Deletes every application one address sent to the store, with its entries
 * in both indexes (lib/person-erasure.ts): how many records were deleted. An
 * application sent while this runs is in the person's index after it, so a
 * second run finds it. A reply that is not exactly what was asked for throws
 * UnknownReplyError: never "nothing was there".
 */
export async function forgetApplyFirstPerson(sid: string | null, email: string): Promise<number> {
  if (!sid || !isRedisConfigured()) return 0;
  const what = "deleting a person's applications";
  const ids = await personIds(sid, email, what);
  if (!ids.length) return 0;
  const commands: (string | number)[][] = [
    ...ids.map((id) => ["DEL", recordKey(sid, id)]),
    ["ZREM", storeIndex(sid), ...ids],
    ["ZREM", personIndex(sid, email), ...ids],
  ];
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  if (!replies) throw new UnknownReplyError(what);
  let deleted = 0;
  replies.forEach((reply, i) => {
    const n = countOf(reply);
    if (n === null || (i < ids.length && n > 1)) throw new UnknownReplyError(what);
    if (i < ids.length) deleted += n;
  });
  return deleted;
}

/**
 * One address's applications to the store, for the copy of their data
 * (lib/person-copy.ts): what they applied for, when, and what became of it.
 * The link's token is never kept, so it is not in it. Only reads; a reply
 * that is not exact throws UnknownReplyError, never "none".
 */
export async function applicationsOfPerson(sid: string | null, email: string): Promise<ApplicationView[]> {
  if (!sid || !isRedisConfigured()) return [];
  const what = "a person's applications";
  const ids = await personIds(sid, email, what);
  if (!ids.length) return [];
  const address = normaliseEmail(email);
  const kept = await keptOf(sid, ids, what);
  return kept.flatMap((k) => {
    if (!k) return [];
    if (k.email !== address) throw new UnknownReplyError(what);
    return [viewOf(k)];
  });
}
