import { PATH_BOARD_KEY, PATH_BOARD_OWNERS_KEY } from "@/lib/path-board";
import { readPathBoard, pathBoardScore, type PathBoardEntry } from "@/lib/path-board-rules";
import { createHash, randomBytes } from "node:crypto";
import {readReturnStep,pathReturnMission,type PathReturnStep} from "@/lib/path-return-rules";
import { WRITE_PATH, FORGET_PATH, FORGET_PATH_HELD } from "@/lib/path-atomic";
import { LockBusyError } from "@/lib/redis-lock";
/**
 * Where a store's Marktmorgen Path is kept (lib/path-rules.ts says what it
 * is): one small record, counted in the store's data room like everything
 * else it keeps (lib/store-data.ts, slot "path"), written only when it
 * changes.
 *
 *   nl:path:<sid>   JSON {
 *                     v: 1,
 *                     a: the four answers and the time zone (PathAnswers),
 *                     at: when the path began, in milliseconds,
 *                     c: the days the owner opened it, in their own days, the latest KEPT_CHECKINS,
 *                     b: the best level ever reached (never lowered), bAt: when,
 *                     m: the last reading of the money (lib/path-facts.ts), reused PATH_MONEY_SECONDS,
 *                     n: the last reading of the counts (visits, links, leads), reused as long
 *                   }
 *
 * Reading the money and the counts again costs PATH_READ_UNITS of the
 * store's studio requests (lib/studio-route.ts, countStudio), taken before
 * anything is read: up to six pages of the creator's Stripe account waited
 * on one after another and the numbers' all-time record. When the studio's
 * figure has no room for it, the path shows the last reading it kept, with
 * when it was read, and never pauses the studio for it.
 *
 * What is never kept: a mission marked done. Missions are read from the
 * store's facts every time (lib/path-facts.ts), so a refund takes a sale
 * back off and nothing here can say otherwise. The best level is the one
 * thing remembered, because a level reached is never taken away.
 *
 * The record is the owner's own: their goal, their words about what they
 * make, their time zone. It goes with the store (forgetPath, from the
 * store's deletion and its closing) and is in the account's own data
 * (lib/person-data.ts, "account"). Answers and money remain private; only explicit\n * board consent shares a pseudonym, verified mission count and reading time.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { dataBytes, contentRoomFor } from "@/lib/store-data-rules";
import { dataKey, monthOf } from "@/lib/store-data";
import { type PathAnswers, AUDIENCES, LEVELS, MINUTES, cleanLine, MAX_SKILLS, MAX_SUBJECT, localDay, validTimeZone, hasPathReturnGap, withCheckin, levelKept, type PathFacts } from "@/lib/path-rules";
import { type PathCounts, type PathMoney, PATH_REFUND_PAGES, PATH_SALE_PAGES, countsFresh, factsFrom, moneyFresh, readPathCounts, readPathMoney } from "@/lib/path-facts";
import { countStudio } from "@/lib/studio-route";
import { readGoal } from "@/lib/sales-goal-rules";
import { isCurrency } from "@/lib/money";

const key = (sid: string) => `nl:path:${sid}`;
/** The store's data room's slot for the record. */
export const PATH_SLOT = "path";
const SID = /^[0-9a-f]{32}$/;

export type PathRecord = {
  /** Private baseline for one short return step; never a stored completion flag. */
  returnStep?:PathReturnStep;
  /** Present only after explicit consent to the mission board. */
  board?: PathBoardEntry;
  /** Opaque write token; absent on legacy records. Never reused after deletion. */
  revision?: string;
  answers: PathAnswers;
  startedAt: number;
  checkins: string[];
  best: number;
  bestAt: number;
  money: PathMoney | null;
  counts: PathCounts | null;
};

/**
 * Studio requests one reading of the money and the counts takes: its
 * PATH_SALE_PAGES and PATH_REFUND_PAGES pages of Stripe, waited on one list
 * after the other at EXPORT_PAGE_SECONDS each (lib/store-export.ts), at the
 * studio request's 1.5 seconds; tests/plan-cost-registry.test.ts holds it.
 */
export const PATH_READ_UNITS = Math.ceil(((PATH_SALE_PAGES + PATH_REFUND_PAGES) * 2) / 1.5);

function parseCounts(raw: unknown): PathCounts | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const at = Number(c.at);
  const whole = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const [social, visitors, links, leads] = [whole(c.social), whole(c.visitors), whole(c.links), whole(c.leads)];
  if (!Number.isFinite(at) || at <= 0 || social === null || visitors === null || links === null || leads === null) return null;
  return { at, social, visitors, links, leads };
}

function parseMoney(raw: unknown): PathMoney | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const at = Number(m.at);
  const real = Number(m.real);
  const cents = m.cents === null ? null : Number(m.cents);
  if (!Number.isFinite(at) || at <= 0 || !Number.isSafeInteger(real) || real < 0) return null;
  if (cents !== null && (!Number.isSafeInteger(cents) || cents < 0)) return null;
  if (typeof m.currency !== "string" || !isCurrency(m.currency)) return null;
  const g=m.growth&&typeof m.growth==="object"?m.growth as Record<string,unknown>:null;
  const validGrowth=g&&(g.repeatBuyer===null||typeof g.repeatBuyer==="boolean")&&(g.keptOrders===null||Number.isSafeInteger(g.keptOrders)&&Number(g.keptOrders)>=0);
  return { at, test: m.test === true, real, cents, currency: m.currency,...(validGrowth?{growth:{repeatBuyer:g.repeatBuyer as boolean|null,keptOrders:g.keptOrders as number|null}}:{}) };
}

/** A record as kept, made safe: null for anything that is not one. Pure. */
export function parsePath(raw: unknown): PathRecord | null {
  if (typeof raw !== "string" || !raw) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!value || value.v !== 1 || !value.a || typeof value.a !== "object") return null;
  const a = value.a as Record<string, unknown>;
  const minutes = Number(a.minutes);
  const goal = readGoal(a.goalCents ?? 0);
  if (!MINUTES.includes(minutes as PathAnswers["minutes"]) || goal === null) return null;
  if (typeof a.audience !== "string" || !(AUDIENCES as readonly string[]).includes(a.audience)) return null;
  const startedAt = Number(value.at);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  const best = Number(value.b);
  const returnStep=readReturnStep(value.w);
  return {
    ...(returnStep?{returnStep}:{}),
    revision: typeof value.r === "string" ? value.r : "",
    board: readPathBoard(value.g) ?? undefined,
    answers: {
      goalCents: goal,
      goalCurrency: typeof a.goalCurrency === "string" && isCurrency(a.goalCurrency) ? a.goalCurrency : "usd",
      skills: cleanLine(a.skills, MAX_SKILLS),
      subject: cleanLine(a.subject, MAX_SUBJECT),
      minutes: minutes as PathAnswers["minutes"],
      audience: a.audience as PathAnswers["audience"],
      timeZone: validTimeZone(a.timeZone) ? a.timeZone : "UTC",
    },
    startedAt,
    checkins: Array.isArray(value.c) ? value.c.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-60) : [],
    best: Number.isInteger(best) && best >= -1 && best < LEVELS.length ? best : -1,
    bestAt: Number(value.bAt) > 0 ? Number(value.bAt) : 0,
    money: parseMoney(value.m),
    counts: parseCounts(value.n),
  };
}

/** A fingerprint, not a duplicate of the store introduction. */
export const pathIntroHash=(intro:string):string=>createHash("sha256").update(intro.trim()).digest("hex");
/** Current own-store publication is the only witness; no button input is accepted. */
export function returnMissionFor(store:Pick<Store,"name"|"bio">,record:PathRecord,now=Date.now()){
 return pathReturnMission(record.returnStep,record.answers.timeZone,{introHash:pathIntroHash(store.bio),introPublished:Boolean(store.name.trim()&&store.bio.trim())},now);
}

/** The record as it is written. Pure. */
export function pathJson(record: PathRecord): string {
  return JSON.stringify({ v: 1, r: record.revision ?? "", a: record.answers, at: record.startedAt, c: record.checkins, b: record.best, bAt: record.bestAt, m: record.money, n: record.counts, g: record.board ?? null,...(record.returnStep?{w:record.returnStep}:{}) });
}

/**
 * The store's path, or null when it has not begun one. The GET answer is read exactly (rule 24): no reply, extra
 * replies or a value that is neither text nor null throws, never "not started". A record kept as text is read by
 * parsePath as before; kept text that parsePath does not take for a record throws too, because only this file
 * writes the key, always as pathJson. Only a GET of null (no key) is "not started".
 */
export async function readPath(store: Pick<Store, "sid">): Promise<PathRecord | null> {
  if (!SID.test(store.sid) || !isRedisConfigured()) return null;
  const reply = repliesFor(await redisPipeline([["GET", key(store.sid)]]), 1);
  if (!reply || (reply[0] !== null && typeof reply[0] !== "string")) throw new UnknownReplyError("a store's Path");
  if (reply[0] === null) return null;
  const record = parsePath(reply[0]);
  if (!record) throw new UnknownReplyError("a store's Path");
  return record;
}

/**
 * Compares the saved revision and changes the record and its data-room slot
 * atomically. A stale snapshot, full room or unreadable meter changes neither.
 */
type PathWriteResult = { ok: true; record: PathRecord } | { ok: false; reason: "full" | "unavailable" | "conflict" };
async function writePath(store: Store, record: PathRecord, now: number, expected: string | null): Promise<PathWriteResult> {
  const room = dataKey(store);
  if (!SID.test(store.sid) || !room || !isRedisConfigured()) return { ok: false, reason: "unavailable" };
  const next: PathRecord = { ...record, revision: randomBytes(16).toString("hex") };
  const json = pathJson(next);
  const [reply] = await redisPipeline([["EVAL", WRITE_PATH, 4, room, key(store.sid), PATH_BOARD_KEY, PATH_BOARD_OWNERS_KEY, contentRoomFor(store, now / 1000), monthOf(now), dataBytes(json), expected ?? "", expected === null ? "1" : "0", json, store.sid]]);
  const state = Array.isArray(reply) ? Number(reply[0]) : NaN;
  if (state === 1) return { ok: true, record: next };
  return { ok: false, reason: state === 0 ? "full" : state === -2 ? "conflict" : "unavailable" };
}

/**
 * Begins the path, or changes its answers: the day it began is kept when it
 * already had one, and so is everything it remembered.
 */
export async function startPath(store: Store, answers: PathAnswers, now = Date.now()): Promise<{ ok: true; record: PathRecord } | { ok: false; reason: "full" | "unavailable" | "conflict" }> {
  if (!SID.test(store.sid) || !isRedisConfigured()) return { ok: false, reason: "unavailable" };
  const before = await readPath(store);
  const record: PathRecord = before
    ? { ...before, answers }
    : { answers, startedAt: now, checkins: [localDay(answers.timeZone, now)], best: -1, bestAt: 0, money: null, counts: null };
  return writePath(store, record, now, before ? before.revision ?? "" : null);
}

/** Takes a reading's studio requests; false when the studio's figure has no room for it (the kept reading is shown then). */
export type Charge = (units: number) => Promise<boolean>;
export const chargeStudio = (store: Store): Charge => async (units) => (await countStudio(store, null, units).catch(() => ({ ok: false as const }))).ok;

/**
 * What the owner opening their path records: today among the days they
 * showed up, the money and the counts read again when the last reading is
 * stale (and its studio requests are taken), and the level kept if a higher
 * one is reached. Written once, only when something changed. Answers the
 * record as it now stands and the facts read from it.
 */
export async function visitPath(store: Store, record: PathRecord, now = Date.now(), charge: Charge = chargeStudio(store)): Promise<{ record: PathRecord; facts: PathFacts }> {
  let { money, counts } = record;
  let changed = false;
  if (!moneyFresh(money, store, now) || !countsFresh(counts, now)) {
    if (await charge(PATH_READ_UNITS)) {
      const [readMoney, readCounts] = await Promise.all([readPathMoney(store, now).catch(() => null), readPathCounts(store, now)]);
      if (readMoney) money = readMoney;
      if (readCounts) counts = readCounts;
      changed = Boolean(readMoney || readCounts);
    }
  }
  const read = factsFrom(store, counts, money);
  const today = localDay(record.answers.timeZone, now);
  const returning=hasPathReturnGap(record.checkins,record.answers.timeZone,now);
  const returnStep=returning?{day:today,introHash:pathIntroHash(store.bio)}:record.returnStep;
  const checkins = withCheckin(record.checkins, today);
  if (checkins.length !== record.checkins.length || checkins[checkins.length - 1] !== record.checkins[record.checkins.length - 1]) changed = true;
  const best = levelKept(record.best, read);
  const next: PathRecord = { ...record,returnStep, checkins, money, counts, best, bestAt: best > record.best ? now : record.bestAt };
  if (best !== record.best) changed = true;
  if(record.board && moneyFresh(money,store,now) && countsFresh(counts,now)) {
    const score=pathBoardScore(read,record.answers);
    const at=Math.min(money!.at,counts!.at,now);
    next.board={...record.board,score,at};
    if(score!==record.board.score || at!==record.board.at)changed=true;
  }
  if (changed) {
    const written = await writePath(store, next, now, record.revision ?? "").catch((error) => {
      console.error("keeping a store's path failed", store.handle, error);
      return { ok: false as const, reason: "unavailable" as const };
    });
    if (written.ok) return { record: written.record, facts: read };
    // A concurrent save, deletion or full room must not present an unkept level as kept.
    const kept = (await readPath(store).catch(() => null)) ?? record;
    return { record: kept, facts: factsFrom(store, kept.counts, kept.money) };
  }
  return { record: next, facts: read };
}

/**
 * Forgets the store's path: from its deletion and its closing. Safe to call twice. With `held`, only while that lock
 * is still its holder's, read in the same step (FORGET_PATH_HELD): the closing walk's, which forgets a closing store's
 * Path only while it holds the store's lock, and stops with LockBusyError, nothing forgotten, once it does not.
 */
export async function forgetPath(store: Store, held?: { key: string; token: string }): Promise<void> {
  if (!SID.test(store.sid) || !isRedisConfigured()) return;
  const room = dataKey(store);
  if (!room) return;
  const keys = [room, key(store.sid), PATH_BOARD_KEY, PATH_BOARD_OWNERS_KEY];
  const args = [monthOf(Date.now()), store.sid];
  const [reply] = await redisPipeline([held ? ["EVAL", FORGET_PATH_HELD, 5, ...keys, held.key, ...args, held.token] : ["EVAL", FORGET_PATH, 4, ...keys, ...args]]);
  if (held && Array.isArray(reply) && Number(reply[0]) === -9) throw new LockBusyError("a closing store's lock ran out before its Path was forgotten");
  if (!Array.isArray(reply) || Number(reply[0]) !== 1) throw new Error("the Path could not be forgotten");
}

/** Consent is explicit. No new facts are bought or inferred by joining. */
export async function joinPathBoard(store: Store, now=Date.now()): Promise<PathWriteResult | {ok:false;reason:"stale"|"not_started"}> {
  const record=await readPath(store);
  if(!record)return {ok:false,reason:"not_started"};
  if(record.board)return {ok:true,record};
  if(!moneyFresh(record.money,store,now) || !countsFresh(record.counts,now))return {ok:false,reason:"stale"};
  const board:PathBoardEntry={token:randomBytes(16).toString("hex"),score:pathBoardScore(factsFrom(store,record.counts,record.money),record.answers),at:Math.min(record.money!.at,record.counts!.at,now)};
  return writePath(store,{...record,board},now,record.revision??"");
}
/** An essential withdrawal: private answers, days and reached level are preserved. */
export async function leavePathBoard(store: Store, now=Date.now()): Promise<PathWriteResult> {
  const record=await readPath(store);
  if(!record)return {ok:false,reason:"unavailable"};
  if(!record.board)return {ok:true,record};
  return writePath(store,{...record,board:undefined},now,record.revision??"");
}
