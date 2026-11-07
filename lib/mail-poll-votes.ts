/**
 * The answers to a poll in a one-off email (125 [F2-EMAIL-POLLS], unit 1;
 * added 6 November 2026). The poll is written in the email
 * (lib/mail-poll.ts); this is what its answers keep and who may give one.
 *
 *   - Each reader's copy carries their own links: a key for the reader made
 *     from the list and their address with a secret (it cannot be turned
 *     back into the address, or made from one without the secret), the
 *     store's id (which a new address never changes), and a signature over
 *     the poll, the store and that key.
 *     A link with another key, another poll, another store or a wrong
 *     signature records nothing. Nothing in it can be guessed.
 *   - A link opens a page (app/poll); only the button on it records, so a
 *     mail scanner that opens every link records nothing, and nothing is
 *     inferred from an email being opened: there is no pixel.
 *   - One answer a reader: the first is kept (HSETNX), a second is told it
 *     was already given. The reader can take it back, and then answer again
 *     while the poll is open.
 *   - Open POLL_OPEN_DAYS from the first send, then closed; everything it
 *     keeps is gone by itself POLL_KEEP_DAYS later.
 *   - A list keeps at most MAX_POLLS_KEPT polls at once, counted and written
 *     in one step (POLL_OPEN): a poll is never deleted while it is kept, so a
 *     reader never finds an open poll gone; a new one past the cap is
 *     refused, and a poll leaves the count when its time is over.
 *   - The creator sees totals only (pollResults), never with names, and only
 *     once the poll has closed (no answer moves them after, so two looks
 *     cannot be set side by side) and from POLL_MIN_SHOWN answers. The store's
 *     owner and team are not readers: their presses record nothing
 *     ("team"), so they cannot make up the fewest answers themselves.
 *   - Each page and each answer is one of the store's public requests
 *     (lib/traffic.ts, takePublicRequest), taken after the store is found
 *     from the signed link and before anything of the poll is read or
 *     written; a refused one reads and records nothing.
 *
 *   nl:mpoll:<list>:<poll>     the poll: store, question, answers, when (JSON)
 *   nl:mpoll:v:<list>:<poll>   reader's key -> the place of their answer
 *   nl:mpoll:ix:<list>         the list's polls, by when they are gone, at
 *                              most MAX_POLLS_KEPT at once
 *
 * Deleted with the person (forgetPollPerson, lib/person-erasure.ts) and with
 * the store: every key is named by its list (lib/data-families.ts, CLOSING).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { deriveKey } from "@/lib/secret-box";
import { SITE_URL } from "@/lib/site-url";
import { MAX_POLL_ANSWER, MAX_POLL_ANSWERS, MAX_POLL_QUESTION, POLL_MIN_SHOWN, type MailPoll } from "@/lib/mail-poll";

/** How long a poll takes answers after its email first went out. */
export const POLL_OPEN_DAYS = 30;
/** How long its totals stay in the studio once it closed; then all of it is gone. */
export const POLL_KEEP_DAYS = 60;
/** The polls a list keeps at once; a new one beyond them is refused until one is gone. */
export const MAX_POLLS_KEPT = 20;
/** The fewest answers a poll's totals are shown at (lib/mail-poll.ts). */
export { POLL_MIN_SHOWN };
/** What one poll's record weighs at the most: its key, the store's handle, its question, its answers and two times, as JSON. */
export const POLL_RECORD_BYTES = 64 + 64 + MAX_POLL_QUESTION * 4 + MAX_POLL_ANSWERS * (MAX_POLL_ANSWER * 4 + 8) + 64;
const POLL_SECONDS = (POLL_OPEN_DAYS + POLL_KEEP_DAYS) * 86_400;
/**
 * Writes a poll down while its list keeps fewer than the most at once, in one
 * step, so two emails can never take the list past it. A poll already there
 * is answered as it is; polls whose time is over leave the count first (their
 * keys are gone by themselves by then). Nothing kept is ever deleted.
 * KEYS: the record, the list's polls. ARGV: now, the poll, the most, the
 * record, its seconds, when it is gone, the list's polls' seconds.
 * Answers {1, kept} when it was there, {2, written} when written, {0} when full.
 */
export const POLL_OPEN = `-- marktmorgen:mail-poll-open:v1
local kept = redis.call('GET', KEYS[1])
if kept then return {1, kept} end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if not redis.call('ZSCORE', KEYS[2], ARGV[2]) and redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return {0} end
redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[5])
redis.call('ZADD', KEYS[2], ARGV[6], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[7])
return {2, ARGV[4]}`;
/**
 * The most an email with a poll adds to sending it, counted in the list-email
 * line (tests/plan-cost-registry.ts): POLL_OPEN's EVAL and its seven
 * commands (GET, ZREMRANGEBYSCORE, ZSCORE, ZCARD, SET, ZADD, EXPIRE), and one
 * read a sequence's round takes first (125 unit 2); the script, the record
 * sent and read back, and the keys and numbers with them (256 bytes). Taken
 * as if every email had to write its poll down.
 */
export const POLL_SEND_COMMANDS = 9;
export const POLL_SEND_BYTES = 2 * POLL_RECORD_BYTES + POLL_OPEN.length + 256;

export const POLL_ID = /^[0-9a-f]{24}$/;
export const POLL_LIST = /^[0-9a-f]{32}$/;
const HEX32 = /^[0-9a-f]{32}$/;
/** A store's id, as lib/store.ts STORE_ID_PATTERN (not imported, so this file stays clear of the store module). */
const STORE_ID = /^[0-9a-f]{32}$/;

const recordKey = (listId: string, pollId: string) => `nl:mpoll:${listId}:${pollId}`;
const votesKey = (listId: string, pollId: string) => `nl:mpoll:v:${listId}:${pollId}`;
const indexKey = (listId: string) => `nl:mpoll:ix:${listId}`;

const mac = (text: string): string | null => {
  const key = deriveKey("mail-poll");
  return key ? createHmac("sha256", key).update(text).digest("hex").slice(0, 32) : null;
};

/** A reader's key on a list: made with a secret, so it cannot be turned back into the address. Null without the secret. */
export function voterOf(listId: string, email: string): string | null {
  return mac(`voter:${listId}:${normaliseEmail(email)}`);
}

const signatureOf = (listId: string, sid: string, pollId: string, voter: string) => mac(`vote:${listId}:${sid}:${pollId}:${voter}`);

/** One reader's link to one answer of a poll. */
/** One reader's link to one answer of a poll; `sid` is the store's id, which a new address never changes. */
export type Ballot = { listId: string; sid: string; pollId: string; voter: string; signature: string; answer: number };

/** The address of a ballot's page. */
export function ballotUrl(ballot: Ballot, extra = ""): string {
  return `${SITE_URL}/poll?l=${ballot.listId}&i=${ballot.sid}&p=${ballot.pollId}&v=${ballot.voter}&s=${ballot.signature}&a=${ballot.answer}${extra}`;
}

/** This reader's links, one an answer, or null when they cannot be signed (no secret): then the email does not go. */
export function voteLinks(listId: string, sid: string, pollId: string, email: string, answers: number): string[] | null {
  const voter = voterOf(listId, email);
  const signature = voter && STORE_ID.test(sid) ? signatureOf(listId, sid, pollId, voter) : null;
  if (!voter || !signature) return null;
  return Array.from({ length: answers }, (_, answer) => ballotUrl({ listId, sid, pollId, voter, signature, answer }));
}

/** A ballot from a page's address, or null when it is not one this site signed. */
export function readBallot(query: { [key: string]: string | string[] | undefined } | URLSearchParams): Ballot | null {
  const get = (name: string) => {
    const value = query instanceof URLSearchParams ? query.get(name) : query[name];
    return typeof value === "string" ? value.slice(0, 80) : "";
  };
  const listId = get("l"), sid = get("i"), pollId = get("p"), voter = get("v"), signature = get("s"), raw = get("a");
  if (!POLL_LIST.test(listId) || !STORE_ID.test(sid) || !POLL_ID.test(pollId) || !HEX32.test(voter) || !HEX32.test(signature) || !/^[0-9]$/.test(raw)) return null;
  const answer = Number(raw);
  if (answer >= MAX_POLL_ANSWERS) return null;
  const expected = signatureOf(listId, sid, pollId, voter);
  if (!expected || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  return { listId, sid, pollId, voter, signature, answer };
}

/** A poll as it is kept. */
export type PollRecord = MailPoll & { handle: string; at: number; closes: number };

function parseRecord(raw: unknown): PollRecord | null | "bad" {
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(String(raw)) as Record<string, unknown>;
    const answers = Array.isArray(value.a) ? value.a.filter((a): a is string => typeof a === "string") : [];
    if (typeof value.h !== "string" || typeof value.q !== "string" || answers.length < 2 || answers.length !== (value.a as unknown[]).length || !Number.isSafeInteger(value.at) || !Number.isSafeInteger(value.closes)) return "bad";
    return { handle: value.h, question: value.q, answers, at: value.at as number, closes: value.closes as number };
  } catch {
    return "bad";
  }
}

/**
 * Writes the poll down before its email goes, once (a later batch finds it
 * there), in one step with its place among the list's polls (POLL_OPEN):
 * "ok" when the poll as it is kept is this one, "full" when the list keeps
 * MAX_POLLS_KEPT polls already (nothing is deleted for it), "failed" when it
 * cannot say. Only on "ok" does the email go.
 */
export async function openPoll(listId: string, handle: string, pollId: string, poll: MailPoll, now = Math.floor(Date.now() / 1000)): Promise<"ok" | "full" | "failed"> {
  if (!POLL_LIST.test(listId) || !POLL_ID.test(pollId) || !HANDLE_PATTERN.test(handle) || !isRedisConfigured() || !deriveKey("mail-poll")) return "failed";
  const until = now + POLL_SECONDS;
  try {
    const record = JSON.stringify({ h: handle, q: poll.question, a: poll.answers, at: now, closes: now + POLL_OPEN_DAYS * 86_400 });
    const [reply] = await redisPipeline([["EVAL", POLL_OPEN, 2, recordKey(listId, pollId), indexKey(listId), now, pollId, MAX_POLLS_KEPT, record, POLL_SECONDS, until, POLL_SECONDS]]);
    if (!Array.isArray(reply)) return "failed";
    if (Number(reply[0]) === 0 && reply.length === 1) return "full";
    if (!(Number(reply[0]) === 1 || Number(reply[0]) === 2)) return "failed";
    const found = parseRecord(reply[1]);
    // The handle kept is the one it was first written under; a store renamed since is still this store (the list is its own).
    if (!found || found === "bad" || found.question !== poll.question || found.answers.join("\n") !== poll.answers.join("\n")) return "failed";
    return "ok";
  } catch {
    return "failed";
  }
}

/** How many polls the list keeps now, against MAX_POLLS_KEPT; null when it cannot be read. */
export async function pollsKept(listId: string | null, now = Math.floor(Date.now() / 1000)): Promise<number | null> {
  if (!listId) return 0;
  if (!POLL_LIST.test(listId) || !isRedisConfigured()) return null;
  try {
    const [count] = await redisPipeline([["ZCOUNT", indexKey(listId), `(${now}`, "+inf"]]);
    const n = Number(count);
    return count !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** The poll a ballot is for: null when it is gone (closed and kept no more), "failed" when it could not be read. */
export async function readPollRecord(listId: string, pollId: string): Promise<PollRecord | null | "failed"> {
  try {
    const [raw] = await redisPipeline([["GET", recordKey(listId, pollId)]]);
    const found = parseRecord(raw);
    return found === "bad" ? "failed" : found;
  } catch {
    return "failed";
  }
}

export const pollClosed = (record: PollRecord, now = Math.floor(Date.now() / 1000)) => now >= record.closes;

/** This reader's answer: its place, null when none, "failed" when it could not be read. */
export async function answerOf(ballot: Ballot): Promise<number | null | "failed"> {
  try {
    const [raw] = await redisPipeline([["HGET", votesKey(ballot.listId, ballot.pollId), ballot.voter]]);
    if (raw === null || raw === undefined) return null;
    const answer = Number(raw);
    return Number.isSafeInteger(answer) && answer >= 0 && answer < MAX_POLL_ANSWERS ? answer : "failed";
  } catch {
    return "failed";
  }
}

export type VoteOutcome = "recorded" | "already" | "withdrawn" | "none" | "closed" | "failed" | "limited" | "team";

/** Presses a connection may make in an hour (app/api/mail/poll); past them it is told so (lib/buyer-words/mail-poll.ts, limited). */
export const POLL_PRESSES_AN_HOUR = 60;

/** Keeps a reader's first answer. "recorded" only when this answer is now kept as theirs. */
export async function castVote(ballot: Ballot, record: PollRecord, now = Math.floor(Date.now() / 1000)): Promise<VoteOutcome> {
  if (pollClosed(record, now)) return "closed";
  if (ballot.answer >= record.answers.length) return "failed";
  try {
    const [set] = await redisPipeline([
      ["HSETNX", votesKey(ballot.listId, ballot.pollId), ballot.voter, ballot.answer],
      ["EXPIREAT", votesKey(ballot.listId, ballot.pollId), record.at + POLL_SECONDS],
    ]);
    if (Number(set) === 1 && set !== null) return "recorded";
    if (Number(set) === 0 && set !== null) return "already";
    return "failed";
  } catch {
    return "failed";
  }
}

/** Takes a reader's answer back, while the poll is open. */
export async function withdrawVote(ballot: Ballot, record: PollRecord, now = Math.floor(Date.now() / 1000)): Promise<VoteOutcome> {
  if (pollClosed(record, now)) return "closed";
  try {
    const [gone] = await redisPipeline([["HDEL", votesKey(ballot.listId, ballot.pollId), ballot.voter]]);
    if (Number(gone) === 1) return "withdrawn";
    if (Number(gone) === 0 && gone !== null) return "none";
    return "failed";
  } catch {
    return "failed";
  }
}

/** One poll's totals, as the studio shows them: never with names, and none before it closed or below POLL_MIN_SHOWN answers (`shown` false, every count null). */
export type PollResult = { id: string; question: string; answers: { text: string; count: number | null }[]; total: number | null; shown: boolean; at: number; closes: number; closed: boolean };

/** The list's polls, newest first, with their totals; null when they could not be read whole. */
export async function pollResults(listId: string | null): Promise<PollResult[] | null> {
  if (!listId || !isRedisConfigured()) return [];
  try {
    const [ids] = await redisPipeline([["ZREVRANGE", indexKey(listId), 0, MAX_POLLS_KEPT - 1]]);
    const list = (Array.isArray(ids) ? ids.map(String) : []).filter((id) => POLL_ID.test(id));
    if (!list.length) return [];
    const rows = await redisPipeline(list.flatMap((id) => [["GET", recordKey(listId, id)], ["HVALS", votesKey(listId, id)]]));
    const out: PollResult[] = [];
    for (const [i, id] of list.entries()) {
      const record = parseRecord(rows[i * 2]);
      if (record === "bad") return null;
      if (!record) continue;
      const counts = record.answers.map(() => 0);
      for (const raw of Array.isArray(rows[i * 2 + 1]) ? (rows[i * 2 + 1] as unknown[]) : []) {
        const answer = Number(raw);
        if (Number.isSafeInteger(answer) && answer >= 0 && answer < counts.length) counts[answer] += 1;
      }
      const total = counts.reduce((a, b) => a + b, 0);
      // Before it closes, or below the fewest shown, nothing of the count leaves here: not the total, not a share.
      const shown = pollClosed(record) && total >= POLL_MIN_SHOWN;
      out.push({ id, question: record.question, answers: record.answers.map((text, k) => ({ text, count: shown ? counts[k] : null })), total: shown ? total : null, shown, at: record.at, closes: record.closes, closed: pollClosed(record) });
    }
    return out;
  } catch {
    return null;
  }
}

/** Deletes one person's answers to the list's polls (lib/person-erasure.ts). */
export async function forgetPollPerson(listId: string | null, email: string): Promise<number> {
  if (!listId || !isRedisConfigured()) return 0;
  const voter = voterOf(listId, email);
  // Without the secret no link could be signed, so no answer was ever kept.
  if (!voter) return 0;
  const [ids] = await redisPipeline([["ZREVRANGE", indexKey(listId), 0, -1]]);
  const list = (Array.isArray(ids) ? ids.map(String) : []).filter((id) => POLL_ID.test(id));
  if (!list.length) return 0;
  const gone = await redisPipeline(list.map((id) => ["HDEL", votesKey(listId, id), voter]));
  return gone.reduce<number>((sum, n) => sum + (Number(n) || 0), 0);
}

/**
 * One person's answers to the list's polls, for the copy of their data
 * (lib/person-copy.ts). Only reads. A poll or an answer it cannot read fails
 * the copy, so a copy is never handed over with an answer silently missing.
 */
export async function pollAnswersOf(listId: string | null, email: string): Promise<{ question: string; answer: string }[]> {
  if (!listId || !isRedisConfigured()) return [];
  const voter = voterOf(listId, email);
  if (!voter) return [];
  const [ids] = await redisPipeline([["ZREVRANGE", indexKey(listId), 0, -1]]);
  const list = (Array.isArray(ids) ? ids.map(String) : []).filter((id) => POLL_ID.test(id));
  if (!list.length) return [];
  const rows = await redisPipeline(list.flatMap((id) => [["GET", recordKey(listId, id)], ["HGET", votesKey(listId, id), voter]]));
  const out: { question: string; answer: string }[] = [];
  list.forEach((_, i) => {
    const record = parseRecord(rows[i * 2]);
    const raw = rows[i * 2 + 1];
    if (record === "bad") throw new Error("A poll could not be read for the copy.");
    if (raw === null || raw === undefined) return;
    const answer = record ? record.answers[Number(raw)] : undefined;
    // An answer kept for a poll that is gone, or past its answers, is one that cannot be read.
    if (answer === undefined) throw new Error("An answer to a poll could not be read for the copy.");
    out.push({ question: record!.question, answer });
  });
  return out;
}
