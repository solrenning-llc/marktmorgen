/**
 * Challenges inside a store's community (19 [E2], unit 1; TODOS-62 P4): the
 * creator puts one on with a title, a few words, a first and a last day and
 * one task for every day ("Write 200 words"); members join and check in once
 * a day; each member sees their own check-ins and streak, and the creator
 * sees how many joined and checked in. No points: they are unit 2.
 *
 * A day runs midnight to midnight UTC, for everyone: a community has no time
 * zone of its own, and the pages say so with every date.
 *
 * Kept under the community's own id, so nothing here reaches another store:
 *
 *   nl:cm:<id>:chs               every challenge kept, by when it ends (sorted set)
 *   nl:cm:<id>:ch:<ch>           one challenge (JSON)
 *   nl:cm:<id>:ch:<ch>:in        who joined: member key -> when, in seconds (hash)
 *   nl:cm:<id>:ch:<ch>:k         check-ins: "<member>|<day>" -> "1" (hash)
 *   nl:cm:<id>:ch:<ch>:n         counts: "all" and "d<day>" -> check-ins (hash)
 *   nl:cm:<id>:chlock            held while one is made, so two at once cannot pass the caps
 *   nl:cm:<id>:chw               the creator's changes this hour (an hour's key)
 *
 * Bounded: at most MAX_OPEN_CHALLENGES not yet over, MAX_KEPT_CHALLENGES kept
 * in all, MAX_CHALLENGE_DAYS days each, one join and one check-in a day per
 * member, and every member is one of the community's (MAX_MEMBERS). Each
 * write takes its room in the store's data room first (lib/store-data.ts),
 * in the challenge's own slot, and gives it back when it is not kept. A
 * challenge over for CHALLENGE_KEEP_DAYS leaves the members' pages; its keys
 * expire then by themselves, and the next one made lets its place and its
 * room go. Deleting a person (lib/community-erasure.ts) takes them out of
 * every challenge, their check-ins out of the counts and their room back;
 * the store's own erasure takes every key under nl:cm:<id>: with it.
 *
 * Every reply that decides something is read exactly (rule 24): an answer of
 * an unknown shape throws UnknownReplyError, never reads as "not joined" or
 * "not checked in".
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { withLock } from "@/lib/redis-lock";
import type { Store } from "@/lib/store";
import { newItemId } from "@/lib/community";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import {
  CHALLENGE_DAY_MS,
  challengeDay,
  challengeDays,
  challengeWindowState,
  dayDate,
  streakOf,
} from "@/lib/community-challenge-rules";
import {
  CHALLENGE_KEEP_DAYS,
  CHALLENGE_WRITES_PER_HOUR,
  ITEM_ID,
  MAX_CHALLENGE_ABOUT,
  MAX_CHALLENGE_AHEAD_DAYS,
  MAX_CHALLENGE_DAYS,
  MAX_CHALLENGE_TASK,
  MAX_CHALLENGE_TITLE,
  MAX_KEPT_CHALLENGES,
  MAX_OPEN_CHALLENGES,
  cleanLine,
  cleanText,
} from "@/lib/community-text";

export type Challenge = {
  id: string;
  title: string;
  about: string;
  /** The one thing to do each day. */
  task: string;
  /** Midnight UTC of its first day, in milliseconds. */
  start: number;
  /** Midnight UTC after its last day, in milliseconds: the first moment it is over. */
  end: number;
  /** When it was made, in seconds. */
  at: number;
};

export type ChallengeInput = Pick<Challenge, "title" | "about" | "task" | "start" | "end">;

const base = (id: string) => `nl:cm:${id}`;
const indexKey = (id: string) => `${base(id)}:chs`;
const challengeKey = (id: string, ch: string) => `${base(id)}:ch:${ch}`;
const joinedKey = (id: string, ch: string) => `${base(id)}:ch:${ch}:in`;
const checkKey = (id: string, ch: string) => `${base(id)}:ch:${ch}:k`;
const countKey = (id: string, ch: string) => `${base(id)}:ch:${ch}:n`;
const lockKey = (id: string) => `${base(id)}:chlock`;
const writesKey = (id: string) => `${base(id)}:chw`;

const KEEP_MS = CHALLENGE_KEEP_DAYS * CHALLENGE_DAY_MS;
const field = (member: string, day: number) => `${member}|${day}`;
/** When a challenge's keys go by themselves: its keep after the end, in seconds. */
const expiresAt = (c: Challenge) => Math.ceil((c.end + KEEP_MS) / 1000);

/** Now, for a page: a function of its own, so a page reads the clock where it means to. */
export function challengeClock(): number {
  return Date.now();
}

// ------------------------------------------------------------------ the room

/** The slot a challenge and everything its members write are counted in. */
const slotOf = (ch: string) => `cm:ch:${ch}`;

/** What a challenge weighs: its record, its place in the list, and a count for each day and the total. */
export function challengeBytes(c: Challenge): number {
  const days = challengeDays(c);
  const counts = Array.from({ length: days }, (_, d) => [`d${d}`, String(Number.MAX_SAFE_INTEGER)]).flat();
  return dataBytes([JSON.stringify(c), c.id, String(c.end)], 2) + dataBytes(["all", String(Number.MAX_SAFE_INTEGER), ...counts], days + 1);
}

/** What one member's place in a challenge weighs. */
export function joinBytes(member: string): number {
  return dataBytes([member, "9999999999"], 1);
}

/** What one check-in weighs. */
export function checkInBytes(member: string, day: number): number {
  return dataBytes([field(member, day), "1"], 1);
}

// ------------------------------------------------------------------ reading

function parseChallenge(raw: unknown): Challenge | null {
  if (typeof raw !== "string") return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const int = (n: unknown) => (typeof n === "number" && Number.isSafeInteger(n) ? n : null);
  const start = int(v.start);
  const end = int(v.end);
  const at = int(v.at);
  if (typeof v.id !== "string" || !ITEM_ID.test(v.id) || typeof v.title !== "string" || typeof v.task !== "string") return null;
  if (start === null || end === null || at === null || challengeWindowState(start, end, start) === "invalid") return null;
  return { id: v.id, title: v.title, about: typeof v.about === "string" ? v.about : "", task: v.task, start, end, at };
}

/** A challenge record's reply: text or nothing; any other shape is unknown (rule 24), never "gone". */
function recordReply(raw: unknown): string | null {
  if (raw !== null && typeof raw !== "string") throw new UnknownReplyError("a challenge");
  return raw;
}

/**
 * One challenge, or null when it is gone (deleted, or its keep is over) or
 * its record does not parse. A reply of an unknown shape throws.
 */
export async function readChallenge(id: string, ch: string): Promise<Challenge | null> {
  if (!ITEM_ID.test(ch)) return null;
  const [raw] = repliesFor(await redisPipeline([["GET", challengeKey(id, ch)]]), 1) ?? [undefined];
  return parseChallenge(recordReply(raw));
}

/** Whether a challenge is still in the community's list, read exactly. */
async function stillKept(id: string, ch: string): Promise<boolean> {
  const [score] = repliesFor(await redisPipeline([["ZSCORE", indexKey(id), ch]]), 1) ?? [undefined];
  if (score === null) return false;
  // ZSCORE answers a member's score as a numeric string (or null): anything that is not a finite number is unknown
  // (Codex Z's LOW on #3452), never read as "still kept".
  const value = typeof score === "number" ? score : typeof score === "string" && score.trim() !== "" ? Number(score) : NaN;
  if (!Number.isFinite(value)) throw new UnknownReplyError("whether a challenge is kept");
  return true;
}

/**
 * After a write to a challenge a delete may have overtaken (it lets the
 * challenge go between our read and our write): when it is no longer in the
 * list, what we wrote is taken away again and its slot stays empty, so
 * nothing is left outside the list and outside the room (Claude 6's review
 * of #3452, L2). Every writer checks after its own last write, so whichever
 * comes last, the delete or the check, clears it.
 */
async function overtaken(id: string, ch: string, room: DataStore, now: number): Promise<boolean> {
  if (await stillKept(id, ch)) return false;
  await redisPipeline([["DEL", joinedKey(id, ch), checkKey(id, ch), countKey(id, ch)]]);
  await giveData(room, [{ slot: slotOf(ch), bytes: 0, set: true }], now);
  return true;
}

/** The ids kept, with when each ends. */
async function keptIds(id: string, minEnd: number | "-inf"): Promise<string[]> {
  const [raw] = repliesFor(await redisPipeline([["ZRANGEBYSCORE", indexKey(id), minEnd, "+inf"]]), 1) ?? [undefined];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) throw new UnknownReplyError("a community's challenges");
  return (raw as string[]).filter((ch) => ITEM_ID.test(ch)).slice(0, MAX_KEPT_CHALLENGES * 2);
}

/**
 * The challenges members see now: every one not yet over and every one over
 * for less than CHALLENGE_KEEP_DAYS, by their first day.
 */
export async function keptChallenges(id: string, now = Date.now()): Promise<Challenge[]> {
  const ids = await keptIds(id, now - KEEP_MS);
  if (!ids.length) return [];
  const raws = repliesFor(await redisPipeline(ids.map((ch) => ["GET", challengeKey(id, ch)])), ids.length);
  if (!raws) throw new UnknownReplyError("a community's challenges");
  return ids
    .map((_, i) => parseChallenge(recordReply(raws[i])))
    .filter((c): c is Challenge => c !== null && c.end + KEEP_MS > now)
    .sort((a, b) => a.start - b.start || a.at - b.at);
}

// ------------------------------------------------------------------ the creator's side

export type InputProblem = "title" | "task" | "dates" | "too_long" | "past" | "too_far";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A YYYY-MM-DD date as midnight UTC, or null for one that is not a real date. */
function utcDate(raw: unknown): number | null {
  const m = typeof raw === "string" ? DATE.exec(raw.trim()) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = Date.UTC(y, mo - 1, d);
  const back = new Date(at);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? at : null;
}

/**
 * What the studio sent, read and checked: `title`, `about`, `task`, and the
 * first and last day as `from` and `to` (YYYY-MM-DD, UTC). Words are cut to
 * their limits, never refused for length; dates that do not make a challenge
 * of 1 to MAX_CHALLENGE_DAYS days, still to come and within
 * MAX_CHALLENGE_AHEAD_DAYS, are refused with the reason.
 */
export function readChallengeInput(body: Record<string, unknown>, now = Date.now()): ChallengeInput | InputProblem {
  const title = cleanLine(body.title, MAX_CHALLENGE_TITLE);
  if (!title) return "title";
  const task = cleanLine(body.task, MAX_CHALLENGE_TASK);
  if (!task) return "task";
  const about = cleanText(body.about, MAX_CHALLENGE_ABOUT).trim().slice(0, MAX_CHALLENGE_ABOUT);
  const start = utcDate(body.from);
  const last = utcDate(body.to);
  if (start === null || last === null || last < start) return "dates";
  const end = last + CHALLENGE_DAY_MS;
  if (end - start > MAX_CHALLENGE_DAYS * CHALLENGE_DAY_MS) return "too_long";
  if (end <= now) return "past";
  if (start > now + MAX_CHALLENGE_AHEAD_DAYS * CHALLENGE_DAY_MS) return "too_far";
  return { title, about, task, start, end };
}

/**
 * Whether the creator may make or delete another challenge this hour. An
 * answer of an unknown shape throws (rule 24): the route says "try again".
 */
export async function withinChallengeWrites(id: string): Promise<boolean> {
  const replies = repliesFor(await redisPipeline([
    ["SET", writesKey(id), "0", "EX", 3_600, "NX"],
    ["INCR", writesKey(id)],
  ]), 2);
  const count = replies && (replies[0] === "OK" || replies[0] === null) ? countOf(replies[1]) : null;
  if (count === null || count < 1) throw new UnknownReplyError("a count of changes to challenges");
  return count <= CHALLENGE_WRITES_PER_HOUR;
}

/**
 * Takes a challenge away, its members' places and check-ins with it, and
 * gives its room back. Off the list first, then its keys: a pipeline's
 * commands run one after another, so a join or a check-in that lands in
 * between already finds it unlisted and takes its own write back
 * (`overtaken`), never leaving a place outside the list and the room
 * (Claude 6's focal on #3452, A).
 */
async function letGo(id: string, ch: string, room: DataStore): Promise<void> {
  await redisPipeline([
    ["ZREM", indexKey(id), ch],
    ["DEL", challengeKey(id, ch), joinedKey(id, ch), checkKey(id, ch), countKey(id, ch)],
  ]);
  await giveData(room, [{ slot: slotOf(ch), bytes: 0, set: true }]);
}

export type CreateResult = { ok: true; challenge: Challenge } | { ok: false; reason: "full" };

/**
 * Puts a new challenge on. Under the community's challenge lock, so two made
 * at once cannot both pass the caps: the ones over for longer than their
 * keep are let go first; then refused past MAX_OPEN_CHALLENGES not yet over,
 * or MAX_KEPT_CHALLENGES kept. Its room is taken before anything is written
 * (DataRoomError when it does not fit). LockBusyError while another is being
 * made.
 */
export async function createChallenge(store: Store, input: ChallengeInput, now = Date.now()): Promise<CreateResult> {
  const id = store.community?.id as string;
  return withLock(lockKey(id), 10, 2_000, async () => {
    for (const ch of await keptOverIds(id, now)) await letGo(id, ch, store);
    const replies = repliesFor(await redisPipeline([["ZCOUNT", indexKey(id), `(${now}`, "+inf"], ["ZCARD", indexKey(id)]]), 2);
    const open = replies ? countOf(replies[0]) : null;
    const kept = replies ? countOf(replies[1]) : null;
    if (open === null || kept === null) throw new UnknownReplyError("how many challenges are kept");
    if (open >= MAX_OPEN_CHALLENGES || kept >= MAX_KEPT_CHALLENGES) return { ok: false as const, reason: "full" as const };
    const challenge: Challenge = { id: newItemId(), ...input, at: Math.floor(now / 1000) };
    await needData(store, [{ slot: slotOf(challenge.id), bytes: challengeBytes(challenge), set: true }], now);
    await redisPipeline([
      ["SET", challengeKey(id, challenge.id), JSON.stringify(challenge)],
      ["EXPIREAT", challengeKey(id, challenge.id), expiresAt(challenge)],
      ["ZADD", indexKey(id), challenge.end, challenge.id],
    ]);
    return { ok: true as const, challenge };
  });
}

/** The ids whose keep is over: ended more than CHALLENGE_KEEP_DAYS ago. */
async function keptOverIds(id: string, now: number): Promise<string[]> {
  const [raw] = repliesFor(await redisPipeline([["ZRANGEBYSCORE", indexKey(id), "-inf", now - KEEP_MS]]), 1) ?? [undefined];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) throw new UnknownReplyError("a community's challenges that are over");
  return (raw as string[]).filter((ch) => ITEM_ID.test(ch));
}

/** Takes a challenge away now, whatever its state: its members' places and check-ins go with it. */
export async function deleteChallenge(store: Store, ch: string): Promise<"deleted" | "gone"> {
  const id = store.community?.id as string;
  if (!ITEM_ID.test(ch)) return "gone";
  // Read exactly: a reply of an unknown shape throws, never deletes (rule 24; Claude 6's focal on #3452, B).
  if (!(await stillKept(id, ch))) return "gone";
  await letGo(id, ch, store);
  return "deleted";
}

// ------------------------------------------------------------------ the members' side

export type JoinResult = "joined" | "already" | "ended" | "gone";

/** Whether this member has joined, read exactly. */
async function hasJoined(id: string, ch: string, member: string): Promise<boolean> {
  const [raw] = repliesFor(await redisPipeline([["HEXISTS", joinedKey(id, ch), member]]), 1) ?? [undefined];
  if (raw !== 0 && raw !== 1) throw new UnknownReplyError("whether a member joined a challenge");
  return raw === 1;
}

/**
 * Joins a member to a challenge not yet over. Its room first (DataRoomError
 * when it does not fit), given back when the member was already in.
 */
export async function joinChallenge(id: string, c: Challenge, member: string, room: DataStore, now = Date.now()): Promise<JoinResult> {
  const state = challengeWindowState(c.start, c.end, now);
  if (state === "invalid") return "gone";
  if (state === "ended") return "ended";
  if (await hasJoined(id, c.id, member)) return "already";
  await needData(room, [{ slot: slotOf(c.id), bytes: joinBytes(member) }], now);
  const [added] = repliesFor(await redisPipeline([
    ["HSETNX", joinedKey(id, c.id), member, String(Math.floor(now / 1000))],
    ["EXPIREAT", joinedKey(id, c.id), expiresAt(c)],
  ]), 2) ?? [undefined];
  if (added !== 0 && added !== 1) throw new UnknownReplyError("a member joining a challenge");
  if (added === 0) {
    await giveData(room, [{ slot: slotOf(c.id), bytes: joinBytes(member) }], now);
    return "already";
  }
  if (await overtaken(id, c.id, room, now)) return "gone";
  return "joined";
}

export type CheckInResult = "checked" | "already" | "notyet" | "ended" | "gone";

/**
 * Checks a member in for today, joining them first when they had not. Once
 * a day: the day's field is written only when it is not there, so two
 * presses at once write it once and count it once. Never before the first
 * day or after the last.
 */
export async function checkIn(id: string, c: Challenge, member: string, room: DataStore, now = Date.now()): Promise<CheckInResult> {
  const state = challengeWindowState(c.start, c.end, now);
  if (state === "invalid") return "gone";
  if (state === "scheduled") return "notyet";
  if (state === "ended") return "ended";
  const joined = await joinChallenge(id, c, member, room, now);
  if (joined === "ended" || joined === "gone") return joined;
  const day = challengeDay(c.start, now);
  const [done] = repliesFor(await redisPipeline([["HEXISTS", checkKey(id, c.id), field(member, day)]]), 1) ?? [undefined];
  if (done !== 0 && done !== 1) throw new UnknownReplyError("whether a member checked in");
  if (done === 1) return "already";
  await needData(room, [{ slot: slotOf(c.id), bytes: checkInBytes(member, day) }], now);
  const [added] = repliesFor(await redisPipeline([
    ["HSETNX", checkKey(id, c.id), field(member, day), "1"],
    ["EXPIREAT", checkKey(id, c.id), expiresAt(c)],
  ]), 2) ?? [undefined];
  if (added !== 0 && added !== 1) throw new UnknownReplyError("a member checking in");
  if (added === 0) {
    await giveData(room, [{ slot: slotOf(c.id), bytes: checkInBytes(member, day) }], now);
    return "already";
  }
  // Counted only by the press that wrote the day: the field is the record, the count follows it.
  await redisPipeline([
    ["HINCRBY", countKey(id, c.id), "all", 1],
    ["HINCRBY", countKey(id, c.id), `d${day}`, 1],
    ["EXPIREAT", countKey(id, c.id), expiresAt(c)],
  ]);
  if (await overtaken(id, c.id, room, now)) return "gone";
  return "checked";
}

export type Progress = {
  joined: boolean;
  /** One for each day so far (all of them once it is over): checked in or not. */
  days: boolean[];
  checkIns: number;
  streak: number;
  /** Checked in today. */
  today: boolean;
};

/** Days so far, up to all of them. */
function daysSoFar(c: Challenge, now: number): number {
  return Math.min(challengeDays(c), challengeDay(c.start, now) + 1);
}

/** What a member sees of their own part in each challenge: one trip, two commands a challenge. */
export async function memberProgress(id: string, challenges: Challenge[], member: string, now = Date.now()): Promise<Map<string, Progress>> {
  const out = new Map<string, Progress>();
  if (!challenges.length) return out;
  const shown = challenges.map((c) => ({ c, n: Math.max(0, daysSoFar(c, now)) }));
  const commands = shown.flatMap(({ c, n }) => [
    ["HEXISTS", joinedKey(id, c.id), member],
    ...(n ? [["HMGET", checkKey(id, c.id), ...Array.from({ length: n }, (_, d) => field(member, d))]] : []),
  ]);
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  if (!replies) throw new UnknownReplyError("what a member did in the challenges");
  let i = 0;
  for (const { c, n } of shown) {
    const joined = replies[i++];
    if (joined !== 0 && joined !== 1) throw new UnknownReplyError("whether a member joined a challenge");
    let days: boolean[] = [];
    if (n) {
      const got = replies[i++];
      if (!Array.isArray(got) || got.length !== n || got.some((x) => x !== null && x !== "1")) throw new UnknownReplyError("a member's check-ins");
      days = got.map((x) => x === "1");
    }
    const today = challengeDay(c.start, now);
    out.set(c.id, {
      joined: joined === 1,
      days,
      checkIns: days.filter(Boolean).length,
      streak: streakOf(days, today),
      today: today >= 0 && today < days.length && days[today],
    });
  }
  return out;
}

export type Counts = { joined: number; checkIns: number; today: number };

/** What the creator sees of each challenge: how many joined, checked in in all, and today. */
export async function challengeCounts(id: string, challenges: Challenge[], now = Date.now()): Promise<Map<string, Counts>> {
  const out = new Map<string, Counts>();
  if (!challenges.length) return out;
  const commands = challenges.flatMap((c) => [
    ["HLEN", joinedKey(id, c.id)],
    ["HMGET", countKey(id, c.id), "all", `d${challengeDay(c.start, now)}`],
  ]);
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  if (!replies) throw new UnknownReplyError("a challenge's counts");
  challenges.forEach((c, i) => {
    const joined = countOf(replies[i * 2]);
    const pair = replies[i * 2 + 1];
    const num = (x: unknown) => (x === null ? 0 : typeof x === "string" && /^-?\d+$/.test(x) ? Math.max(0, Number(x)) : null);
    const all = Array.isArray(pair) && pair.length === 2 ? num(pair[0]) : null;
    const today = Array.isArray(pair) && pair.length === 2 ? num(pair[1]) : null;
    if (joined === null || all === null || today === null) throw new UnknownReplyError("a challenge's counts");
    const live = challengeWindowState(c.start, c.end, now) === "active";
    out.set(c.id, { joined, checkIns: all, today: live ? today : 0 });
  });
  return out;
}

// ------------------------------------------------------------------ one person

/** Every day field a person can have in any challenge: never more than MAX_CHALLENGE_DAYS. */
const personFields = (who: string) => Array.from({ length: MAX_CHALLENGE_DAYS }, (_, d) => field(who, d));

/** A person's check-ins in one challenge, read exactly: the days they did. */
function daysDone(got: unknown): number[] {
  if (!Array.isArray(got) || got.length !== MAX_CHALLENGE_DAYS || got.some((x) => x !== null && typeof x !== "string")) throw new UnknownReplyError("a person's check-ins");
  return got.flatMap((x, d) => (x === null ? [] : [d]));
}

/**
 * The challenges a person is in, with the days they checked in: for the copy
 * of their data (619 [SZ3]). Read from their place and their check-ins, not
 * from the challenge's record: a record that does not parse still shows
 * their part, with no title and the days by number (Claude 6's review of
 * #3452, M1); a reply of an unknown shape throws, never leaves one out.
 */
export async function challengesOf(id: string, who: string): Promise<{ challenge: string; title: string | null; joined: number; checkIns: string[] }[]> {
  if (!isRedisConfigured()) return [];
  const out: { challenge: string; title: string | null; joined: number; checkIns: string[] }[] = [];
  for (const ch of await keptIds(id, "-inf")) {
    const replies = repliesFor(await redisPipeline([
      ["GET", challengeKey(id, ch)],
      ["HGET", joinedKey(id, ch), who],
      ["HMGET", checkKey(id, ch), ...personFields(who)],
    ]), 3);
    if (!replies) throw new UnknownReplyError("a person's challenges");
    const c = parseChallenge(recordReply(replies[0]));
    const joined = replies[1];
    if (joined !== null && (typeof joined !== "string" || !/^\d+$/.test(joined))) throw new UnknownReplyError("a person's place in a challenge");
    const done = daysDone(replies[2]);
    if (joined === null && !done.length) continue;
    out.push({
      challenge: ch,
      title: c ? c.title : null,
      joined: joined === null ? 0 : Number(joined),
      checkIns: done.map((d) => (c ? dayDate(c.start, d) : `day ${d + 1}`)),
    });
  }
  return out;
}

/**
 * Takes a person out of every challenge: their place, their check-ins, and
 * their check-ins out of the counts; their room given back when the store is
 * known. Answers how many records went.
 */
export async function forgetChallengesPerson(id: string, who: string, room?: DataStore): Promise<number> {
  if (!isRedisConfigured()) return 0;
  let records = 0;
  // Not from the challenge's record: a record that does not read must not
  // keep a person in (Claude 6's review of #3452, M1). Every day field they
  // can have is at most MAX_CHALLENGE_DAYS, and the room each took is known
  // from the member and the day alone.
  for (const ch of await keptIds(id, "-inf")) {
    const [got] = repliesFor(await redisPipeline([["HMGET", checkKey(id, ch), ...personFields(who)]]), 1) ?? [undefined];
    const done = daysDone(got);
    const removed = repliesFor(await redisPipeline([
      ["HDEL", joinedKey(id, ch), who],
      ...done.map((d) => ["HDEL", checkKey(id, ch), field(who, d)]),
    ]), done.length + 1);
    // Rule 24: an erasure is never said done on a reply it cannot read.
    if (!removed || removed.some((n) => n !== 0 && n !== 1)) throw new UnknownReplyError("a person taken out of a challenge");
    const [left, ...rest] = removed;
    const gone = done.filter((_, i) => rest[i] === 1);
    if (gone.length) {
      await redisPipeline([
        ["HINCRBY", countKey(id, ch), "all", -gone.length],
        ...gone.map((d) => ["HINCRBY", countKey(id, ch), `d${d}`, -1]),
      ]);
      // A challenge deleted in between (its index entry goes first) would have its counts made again here, with no
      // TTL and outside its room: checked after, as the writers do, and its keys go (Claude 1 on #3452).
      if (!(await stillKept(id, ch))) await redisPipeline([["DEL", joinedKey(id, ch), checkKey(id, ch), countKey(id, ch)]]);
    }
    const joined = left === 1;
    records += (joined ? 1 : 0) + gone.length;
    if (room) {
      const bytes = (joined ? joinBytes(who) : 0) + gone.reduce((sum, d) => sum + checkInBytes(who, d), 0);
      if (bytes) await giveData(room, [{ slot: slotOf(ch), bytes }]);
    }
  }
  return records;
}
