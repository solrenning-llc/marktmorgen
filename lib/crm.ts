/**
 * Where a store's own fields and deals are kept (lib/crm-rules.ts has the
 * rules).
 *
 *   nl:crm:fields:<statsId>          the fields (JSON)
 *   nl:crm:v:<statsId>:<field id>    hash  person (lib/buyer-profile.ts, personKey) -> value
 *   nl:crm:stages:<statsId>          the first pipeline's stages (JSON), as the board had them
 *                                    before pipelines; kept as a copy of the first pipeline's
 *   nl:crm:pipes:<statsId>           the pipelines and their stages (JSON, lib/crm-rules.ts);
 *                                    absent until the creator first changes one, and then it wins
 *   nl:crm:deals:<statsId>           hash  deal id -> deal (JSON)
 *   nl:crm:tasks:<statsId>           hash  person -> their tasks (JSON, lib/person-tasks.ts), gone with the person;
 *                                    and TASK_COUNT_FIELD -> how many tasks the store keeps in all
 *   nl:crm:tasklock:<statsId>        one change of the store's tasks at a time (lib/redis-lock.ts), ten seconds at the most
 *   nl:crm:erased:<statsId>:<person> a person deleted and not come back (server time), ERASED_MARK_SECONDS: no value is set
 *   nl:crm:gen:<statsId>:<person>    a person's generation, one more at each deletion: a page read before one is refused
 *   nl:crm:taskrecount:<statsId>     one paid recount of the store's tasks at a time (lib/redis-lock.ts), thirty seconds at the most
 *
 * A value is kept under the person's key, never the address (as a note
 * about them is), one hash a field, so the list's file reads each field once
 * however long the list is.
 */
import { createHash } from "node:crypto";
import { personKey } from "@/lib/person-key";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { STORE_ID_PATTERN, storeIdExists } from "@/lib/store";
import { type DataStore, giveData, needData, noteData } from "@/lib/store-data";
import { dataBytes, dataBytesOfLength, utf8Length } from "@/lib/store-data-rules";
import { type Held, LockBusyError, holdLock, withLock } from "@/lib/redis-lock";
import { type DueTask, MAX_PERSON_TASKS, MAX_STORE_TASKS, type PersonTask, type TaskResult, parseTasks } from "@/lib/person-tasks";
import {
  type CrmField,
  CRM_ID,
  type Deal,
  DEFAULT_STAGES,
  DEAL_ID,
  MAX_DEALS,
  MAX_FIELD_OPTION,
  MAX_FIELD_OPTIONS,
  MAX_FIELD_VALUE,
  type Pipeline,
  type PipelineChange,
  type Stage,
  allStages,
  changePipeline,
  fieldValue,
  firstPipeline,
  parsePipelines,
  parseDeal,
  parseFields,
  parseStages,
} from "@/lib/crm-rules";

export class CrmDealReadUnavailable extends Error {
  constructor() { super("CRM deal preflight could not be confirmed"); this.name = "CrmDealReadUnavailable"; }
}
export class CrmDealWriteUnconfirmed extends Error {
  constructor() { super("CRM deal change could not be confirmed"); this.name = "CrmDealWriteUnconfirmed"; }
}

export class CrmValueWriteUnconfirmed extends Error {
  constructor() { super("CRM contact value change could not be confirmed"); this.name = "CrmValueWriteUnconfirmed"; }
}
/** The person was deleted from the store (forgetCrmPerson): nothing about them is written, and the room taken is given back. */
export class CrmPersonGone extends Error {
  constructor() { super("This person was deleted from the store"); this.name = "CrmPersonGone"; }
}

export class CrmSchemaReadUnavailable extends Error {
  constructor() { super("CRM configuration preflight could not be confirmed"); this.name = "CrmSchemaReadUnavailable"; }
}
export class CrmSchemaWriteUnconfirmed extends Error {
  constructor() { super("CRM configuration change could not be confirmed"); this.name = "CrmSchemaWriteUnconfirmed"; }
}
/** A field would be taken away, with its answers, by a write that may not take any. */
export class CrmFieldsKept extends Error {
  constructor() { super("CRM fields may not be taken away here"); this.name = "CrmFieldsKept"; }
}
/** Somebody else changed the pipelines between this change's read and its write: nothing was written. */
export class CrmSchemaConflict extends Error {
  constructor() { super("CRM configuration changed meanwhile"); this.name = "CrmSchemaConflict"; }
}

const fieldsKey = (statsId: string) => `nl:crm:fields:${statsId}`;
const valuesKey = (statsId: string, field: string) => `nl:crm:v:${statsId}:${field}`;
const stagesKey = (statsId: string) => `nl:crm:stages:${statsId}`;
const dealsKey = (statsId: string) => `nl:crm:deals:${statsId}`;
const pipesKey = (statsId: string) => `nl:crm:pipes:${statsId}`;
const tasksKey = (statsId: string) => `nl:crm:tasks:${statsId}`;
const TASKS_SLOT = "crm:tasks";
/**
 * One change of a store's tasks at a time: each one reads a person's list,
 * changes it and writes it back whole, so two at once (two quick clicks, two
 * teammates) would each write what they read and one change would be lost.
 * The whole store, not one person, so the store's cap is counted exactly too.
 */
const tasksLockKey = (statsId: string) => `nl:crm:tasklock:${statsId}`;
const TASKS_LOCK_SECONDS = 10;
/** How long a change waits for the one before it, before it is refused (LockBusyError). */
export const TASKS_LOCK_WAIT_MS = 2_000;
/** How long deleting a person waits for a change of their tasks, before it reports failure. */
const TASKS_FORGET_WAIT_MS = 5_000;
/**
 * The field of the store's tasks hash that keeps how many tasks the store
 * has in all, so an add checks MAX_STORE_TASKS by reading one number instead
 * of every task (the review of #1959: 980 tasks were 356,672 bytes read for
 * one add). Never a person's key (those are 32 hex characters), so nothing
 * that reads people takes it for one. Changed only under the tasks' lock, in
 * the same script as the write it counts; made again from every task, once,
 * paid for first (TASKS_RECOUNT_UNITS), when a store kept tasks before it.
 */
export const TASK_COUNT_FIELD = "count";
/**
 * One paid recount of a store's tasks at a time: a second change that needs
 * one waits for the first, then finds the count made and pays nothing. Held
 * while the studio is asked to pay (which may read Stripe), so longer than
 * the tasks' lock, which is never held while paying.
 */
const recountLockKey = (statsId: string) => `nl:crm:taskrecount:${statsId}`;
const RECOUNT_LOCK_SECONDS = 30;
const RECOUNT_WAIT_MS = 5_000;
/** Passes of a change that needs a recount, under the recount's lock: one to look, one after paying, one more when people were added meanwhile. */
const RECOUNT_PASSES = 3;
/** What the count takes in the store's data room: its field at the largest it can be. */
export const TASK_COUNT_WEIGHT = dataBytes([TASK_COUNT_FIELD, String(MAX_STORE_TASKS)], 1);
/**
 * The most one task weighs as kept (JSON): its words at three bytes a
 * character at the most (MAX_TASK_TEXT; control characters are taken out, so
 * none is written as an escape, and a pair of characters is four bytes), the
 * teammate's address, which came in a request of at most 2,000 bytes
 * (app/api/store/person-tasks/route.ts), and its id, date, two times and
 * names; tests/person-tasks.test.ts holds the worst one under it.
 */
export const TASK_KEPT_BYTES = 2_800;
/** What a person's record adds besides their tasks, counted once a task (each person has one at least): their key, the list's marks and the reply's framing. */
const TASK_PERSON_BYTES = 64;
/** What one studio request pays to read from the database (tests/plan-cost-registry.ts, UNIT_COST.studio). */
const STUDIO_REQUEST_BYTES = 50_000;
/**
 * Studio requests taken before every task of a store is read to make its
 * count again: what `people` people can keep, at most MAX_STORE_TASKS tasks
 * at their heaviest, at STUDIO_REQUEST_BYTES a request
 * (tests/plan-cost-registry.test.ts holds it above what the read costs).
 */
export function tasksRecountUnits(people: number): number {
  const tasks = Math.min(Math.max(0, Math.floor(people)) * MAX_PERSON_TASKS, MAX_STORE_TASKS);
  return Math.max(1, Math.ceil((tasks * (TASK_KEPT_BYTES + TASK_PERSON_BYTES)) / STUDIO_REQUEST_BYTES));
}
/** At the most: a store with as many tasks as it may keep. */
export const TASKS_RECOUNT_UNITS = tasksRecountUnits(MAX_STORE_TASKS);
/** The most bytes a recount reads. */
export const TASKS_RECOUNT_BYTES = MAX_STORE_TASKS * (TASK_KEPT_BYTES + TASK_PERSON_BYTES);
const PERSON = /^[0-9a-f]{32}$/;
/**
 * A person deleted from the store (forgetCrmPerson): one key under their
 * person key (lib/person-key.ts, a one-way hash, never the address), holding
 * only the server's time of the deletion. While it is there, nothing is set
 * about them (SET_CRM_VALUE refuses, whatever a request says). Only the
 * server takes it away, when the person comes back on their own: a paid
 * order, a confirmed sign-up or waitlist place, a free product claimed
 * through the emailed link (personReturned). A request's own word never
 * does (C3-125), nor an address typed into a form, which anybody can type.
 */
export const erasedKey = (statsId: string, person: string) => `nl:crm:erased:${statsId}:${person}`;
/**
 * The person's generation: 0 until they are first deleted, one more at each
 * deletion. A page reads it with the person, and a save from it carries it:
 * one read before a deletion differs, and is refused, even after the person
 * came back (SET_CRM_VALUE). Kept ERASED_MARK_SECONDS from the last deletion.
 */
export const generationKey = (statsId: string, person: string) => `nl:crm:gen:${statsId}:${person}`;
/**
 * How long the mark and the generation are kept: at least the longest a page
 * read before the deletion can still save, which is the longest of
 *   - a studio page opened before the deletion and saved while its session
 *     lasts: SESSION_TTL_SECONDS, 30 days (lib/auth.ts);
 *   - a workflow step already taken when the deletion removed the person's
 *     queued and waiting steps (lib/flows.ts, forgetWorkflowPerson): its
 *     lease, LEASE_SECONDS, 15 minutes; it is never tried again after.
 * Thirty days, and one more: 31 days (tests/crm-person-room.test.ts holds it
 * above each). A mark left there that long (they never came back) goes by
 * itself, and a value set after it is a new one, as for anyone.
 */
export const ERASED_MARK_SECONDS = 31 * 86_400;

/**
 * The first lines of every script that writes something about a person (a
 * value, their tasks, a note: SET_CRM_VALUE, WRITE_PERSON_TASKS,
 * lib/buyer-profile.ts ADD_PERSON_NOTE): `refuse`, with nothing written,
 * while their deletion mark (KEYS[k]) is there, or when the write carries
 * another generation (ARGV[p]) than theirs (KEYS[g]): a page read, or a
 * workflow step started, before a deletion. It never takes the mark away
 * (personReturned does, on the server's own paths). Inside: the mark and the
 * generation read (ERASED_GUARD_CALLS).
 */
export function erasedGuard(k: number, g: number, p: number, refuse: string): string {
  return `if redis.call("EXISTS", KEYS[${k}]) == 1 then return ${refuse} end
if tonumber(redis.call("GET", KEYS[${g}]) or "0") ~= tonumber(ARGV[${p}]) then return ${refuse} end`;
}
/** What erasedGuard runs inside its script, which Upstash bills one by one beside the EVAL. */
export const ERASED_GUARD_CALLS = 2;
/**
 * A generation a write carries, as a script compares it: one the person can
 * have (0 or more), or -1, none they can, which is refused wherever they were
 * deleted (and written for no one: a person never deleted is at 0).
 */
export function carriedGeneration(generation: number | undefined): number {
  return typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0 ? generation : -1;
}

/** The person's generation as it is now (generationKey): what a page reads with them, and a save from it carries. */
export async function readGeneration(statsId: string | null, person: string): Promise<number> {
  if (!statsId || !PERSON.test(person) || !isRedisConfigured()) return 0;
  const [raw] = await redisPipeline([["GET", generationKey(statsId, person)]]);
  const n = Number(raw ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** Several people's generations at once, in one trip: what a workflow step reads when it starts, before it sets their values. */
export async function readGenerations(statsId: string, persons: string[]): Promise<number[]> {
  if (!persons.length || !isRedisConfigured()) return persons.map(() => 0);
  const replies = await redisPipeline(persons.map((person) => ["GET", generationKey(statsId, person)]));
  return persons.map((_, i) => {
    const n = Number(replies[i] ?? 0);
    return Number.isSafeInteger(n) && n >= 0 ? n : -1;
  });
}

/**
 * The person came back on their own (a paid order, a confirmed sign-up or
 * place, a free product claimed through the emailed link; never an address
 * typed into a form, Revisor 2 on #2287): the mark of their deletion goes,
 * so the store may keep fields about them again. Their generation stays, so
 * a page read before the deletion is still refused. Server paths only; never
 * throws (a mark that stays only refuses more).
 *
 * `at` is when the person did it, in milliseconds, from the server's own
 * record of the act (the payment's time, when the sign-up, the place or the
 * copy was asked for), never from a request. The mark goes
 * only when that is after the deletion, compared in one step with the mark
 * as it is (MARK_RETURNED): an order paid before the deletion and listed only
 * after it (a late job, a thanks page opened again), or an old link used
 * again, is not a return (Codex D, #2287). An unknown time keeps the mark.
 */
export async function personReturned(statsId: string | null, email: string, at: number): Promise<void> {
  if (!statsId || !email || !Number.isSafeInteger(at) || at <= 0 || !isRedisConfigured()) return;
  await redisPipeline([["EVAL", MARK_RETURNED, 1, erasedKey(statsId, personKey(statsId, email)), String(at)]]).catch((error: unknown) => console.error("clearing a deletion mark failed", error));
}

/**
 * Takes a deletion mark away only when the act that brought the person back
 * (ARGV[1], milliseconds) came after the deletion it records. A mark that is
 * not a time is kept. Modelled by lib/redis-memory.ts.
 */
export const MARK_RETURNED = `-- marktmorgen:crm-erased-returned:v1
local mark = tonumber(redis.call('GET', KEYS[1]) or '')
if mark == nil then return 0 end
if mark < tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0`;
/** Where people's field values are counted in the store's data room (lib/store-data.ts). */
const VALUES_SLOT = "crm:v";
/** Where the pipelines are counted in it: one slot, at what their record weighs. */
const PIPES_SLOT = "crm:pipes";

const json = (raw: unknown): unknown => {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export async function readFields(statsId: string | null): Promise<CrmField[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["GET", fieldsKey(statsId)]]);
  return parseFields(json(raw));
}

/**
 * Saves the fields; the answers kept for a field that is gone go with it.
 * With `keepAll`, nothing is written when a field kept now would be gone
 * (CrmFieldsKept). The fields are read just before the write, not in the
 * same step: a field another session adds in between is left off the list
 * but its answers are never deleted, since only fields read as gone are.
 */
export async function writeFields(statsId: string, fields: CrmField[], keepAll = false): Promise<CrmField[]> {
  let before: CrmField[];
  try {
    const response = await redisPipeline([["GET", fieldsKey(statsId)]]);
    if (!Array.isArray(response) || response.length !== 1) throw new CrmSchemaReadUnavailable();
    if (response[0] === null) before = [];
    else {
      if (typeof response[0] !== "string") throw new CrmSchemaReadUnavailable();
      const raw: unknown = JSON.parse(response[0]);
      if (!Array.isArray(raw)) throw new CrmSchemaReadUnavailable();
      before = parseFields(raw);
      if (before.length !== raw.length) throw new CrmSchemaReadUnavailable();
    }
  } catch { throw new CrmSchemaReadUnavailable(); }
  const gone = before.filter(f => !fields.some(n => n.id === f.id));
  if (keepAll && gone.length) throw new CrmFieldsKept();
  try {
    const response = await redisPipeline([["SET", fieldsKey(statsId), JSON.stringify(fields)], ...gone.map(f => ["DEL", valuesKey(statsId, f.id)])]);
    if (!Array.isArray(response) || response.length !== 1 + gone.length || response[0] !== "OK" || Array.from(response).slice(1).some(value => value !== 0 && value !== 1)) throw new CrmSchemaWriteUnconfirmed();
  } catch { throw new CrmSchemaWriteUnconfirmed(); }
  return fields;
}

/** One person's values, by field id. */
export async function readValues(statsId: string | null, person: string, fields: CrmField[]): Promise<Record<string, string>> {
  if (!statsId || !PERSON.test(person) || !fields.length || !isRedisConfigured()) return {};
  const got = await redisPipeline(fields.map((f) => ["HGET", valuesKey(statsId, f.id), person]));
  return Object.fromEntries(fields.flatMap((f, i) => (typeof got[i] === "string" && got[i] ? [[f.id, got[i] as string]] : [])));
}

/**
 * The most a value takes, in UTF-8: the longest a field keeps (a text, an address
 * or a number at MAX_FIELD_VALUE; every choice of a field of several, one a
 * line), at three bytes a UTF-16 unit, the most any takes.
 */
export const CRM_VALUE_MOST_BYTES = 3 * Math.max(MAX_FIELD_VALUE, MAX_FIELD_OPTIONS * MAX_FIELD_OPTION + MAX_FIELD_OPTIONS - 1);
/** What SET_CRM_VALUE runs inside, at the most, which Upstash bills one by one beside the EVAL: the mark and the generation read, a workflow run's lease read, the value read and written. */
export const CRM_VALUE_SCRIPT_CALLS = ERASED_GUARD_CALLS + 3;
/**
 * A field saved from the studio (app/api/store/crm/route.ts, "value"), at the
 * most, measured through the real route in tests/crm-contact-writes.test.ts
 * as the studio sends it (the store named by every request,
 * components/studio-store-pin.tsx): the trips to the database one after
 * another (the session, the store and its team, the studio's count with
 * both its requests, a teammate's line in the log, the fields, the room
 * taken, the write, the room given back: 9 for the owner, 12 for a
 * teammate), the commands sent with what the scripts run inside, and the
 * bytes.
 */
export const CRM_VALUE_SAVE_TRIPS = 12;
export const CRM_VALUE_SAVE_COMMANDS = 30;
export const CRM_VALUE_SAVE_BYTES = 2 * CRM_VALUE_MOST_BYTES + 16_384;
/**
 * Studio requests a field saved from the studio is counted as, all taken
 * with the first, before anything else is read (guardStoreWrite's `units`):
 * its trips at the review ceiling of a trip do not fit in one studio
 * request's 1.5 s, and never more than two (C3-123, C3-125;
 * tests/plan-cost-registry.test.ts holds the figures).
 */
export const CRM_VALUE_SAVE_UNITS = 2;

/**
 * Sets one person's value of one field, or clears it with "", in one step on
 * the Redis side: 2, and nothing written, while the person's deletion mark is
 * there (KEYS[2]) or when the save carries another generation than theirs
 * (KEYS[3], ARGV[3]: the page was read before a deletion); otherwise the
 * value is written, and the answer is {1, before} with what it replaced, or
 * {1}. It never takes the mark away. Inside: the mark and the generation
 * read, the value read and written (CRM_VALUE_SCRIPT_CALLS).
 */
export const SET_CRM_VALUE = `-- marktmorgen:crm-value-set:v5
${erasedGuard(2, 3, 3, "2")}
if KEYS[4] and not redis.call("ZSCORE", KEYS[4], ARGV[4]) then return 2 end
local before = redis.call("HGET", KEYS[1], ARGV[1])
if ARGV[2] == "" then redis.call("HDEL", KEYS[1], ARGV[1]) else redis.call("HSET", KEYS[1], ARGV[1], ARGV[2]) end
if before then return {1, before} end
return {1}`;

/**
 * Sets one value for one person; "" clears it. False when it is not a value the field keeps.
 *
 * `generation` is the person's generation as the page read it (readGeneration), or as a workflow step read it when
 * it started. A workflow step also gives its run's `lease` (lib/flows.ts, LEASE): a deletion takes the run out of it
 * (forgetWorkflowPerson), so a run already under way when the person was deleted writes nothing, in the same step as
 * the write, even if they came back before its generation was read (Codex G, #2287). While the person's deletion mark is there, or for a save that carries another generation (a page read
 * before a deletion, even if they came back since), nothing is written (CrmPersonGone, with the room taken given
 * back), in the same step as the write. The deletion leaves its mark before it takes the values away, and each value
 * is taken in one script that answers what it removed, so a write is either refused or deleted with the rest. The new
 * value's whole room is taken first (DataRoomError, and nothing written, when it does not fit); the write answers what
 * it replaced, in the same step, and that room is given back after. So what is counted is exactly what is kept.
 *
 * From the studio it is counted as CRM_VALUE_SAVE_UNITS studio requests, taken before anything is read
 * (app/api/store/crm/route.ts; tests/plan-cost-registry.ts, CRM_VALUE_SAVE).
 */
export async function setValue(statsId: string, person: string, field: CrmField, raw: unknown, room: DataStore, generation: number, lease?: { key: string; member: string }): Promise<boolean> {
  if (!PERSON.test(person)) return false;
  const value = fieldValue(field, raw);
  if (value === null) return false;
  // Not a generation: none the person can have, so refused wherever they were deleted, and written for anyone else
  // only when they were never deleted (0).
  const carried = carriedGeneration(generation);
  const weight = (v: unknown) => (typeof v === "string" && v ? dataBytes([person, v], 1) : 0);
  const charged = weight(value);
  if (charged > 0) await needData(room, [{ slot: VALUES_SLOT, bytes: charged }]);
  let answer: unknown;
  try {
    const keys = [valuesKey(statsId, field.id), erasedKey(statsId, person), generationKey(statsId, person), ...(lease ? [lease.key] : [])];
    const response = await redisPipeline([["EVAL", SET_CRM_VALUE, keys.length, ...keys, person, value, carried, ...(lease ? [lease.member] : [])]]);
    answer = Array.isArray(response) && response.length === 1 ? response[0] : undefined;
  } catch { throw new CrmValueWriteUnconfirmed(); }
  if (answer === 2) {
    // The person was deleted (and has not come back), or the page was read before a deletion: nothing was written, so
    // the room taken goes back.
    if (charged > 0) await giveData(room, [{ slot: VALUES_SLOT, bytes: charged }]).catch(() => {});
    throw new CrmPersonGone();
  }
  // Any other answer may or may not have landed: the room taken stays counted, never less than what is kept.
  if (!Array.isArray(answer) || answer[0] !== 1 || answer.length > 2 || (answer.length === 2 && typeof answer[1] !== "string")) throw new CrmValueWriteUnconfirmed();
  const freed = weight(answer[1]);
  // The value replaced gives its room back; one that cannot be given back now stays counted (more, never less, than kept).
  if (freed > 0) await giveData(room, [{ slot: VALUES_SLOT, bytes: freed }]).catch(() => {});
  return true;
}

/** Every value of every field, by field id and then by person: for the list's file. */
export async function allValues(statsId: string | null, fields: CrmField[]): Promise<Record<string, Record<string, string>>> {
  if (!statsId || !fields.length || !isRedisConfigured()) return {};
  const got = await redisPipeline(fields.map((f) => ["HGETALL", valuesKey(statsId, f.id)]));
  return Object.fromEntries(
    fields.map((f, i) => {
      const raw = got[i];
      const map: Record<string, string> = {};
      if (Array.isArray(raw)) for (let k = 0; k + 1 < raw.length; k += 2) map[String(raw[k])] = String(raw[k + 1]);
      else if (raw && typeof raw === "object") Object.assign(map, raw as Record<string, string>);
      return [f.id, map];
    }),
  );
}

/**
 * The store's pipelines: the saved ones once the creator has changed one,
 * and until then the board it always had, as the first pipeline.
 */
export async function readPipelines(statsId: string | null): Promise<Pipeline[]> {
  if (!statsId || !isRedisConfigured()) return [firstPipeline(DEFAULT_STAGES)];
  const [pipes, legacy] = await redisPipeline([["GET", pipesKey(statsId)], ["GET", stagesKey(statsId)]]);
  return parsePipelines(json(pipes)) ?? [firstPipeline(parseStages(json(legacy)) ?? DEFAULT_STAGES)];
}

/** Every stage of every pipeline, in order: what a deal's stage is read against. */
export async function readStages(statsId: string | null): Promise<Stage[]> {
  return allStages(await readPipelines(statsId));
}

/** The pipelines exactly as saved, for a change: an unreadable or malformed record never stands in for the defaults. */
async function pipelineSnapshot(statsId: string): Promise<{ raw: string; pipelines: Pipeline[] }> {
  try {
    const response = await redisPipeline([["GET", pipesKey(statsId)], ["GET", stagesKey(statsId)]]);
    if (!Array.isArray(response) || response.length !== 2) throw new CrmSchemaReadUnavailable();
    const [pipes, legacy] = response;
    if (pipes !== null) {
      if (typeof pipes !== "string") throw new CrmSchemaReadUnavailable();
      const pipelines = parsePipelines(json(pipes));
      if (!pipelines) throw new CrmSchemaReadUnavailable();
      return { raw: pipes, pipelines };
    }
    // Before any pipeline was saved, the board's own stages, as the board has always read them.
    if (legacy !== null && typeof legacy !== "string") throw new CrmSchemaReadUnavailable();
    return { raw: "", pipelines: [firstPipeline(parseStages(json(legacy)) ?? DEFAULT_STAGES)] };
  } catch { throw new CrmSchemaReadUnavailable(); }
}

/** Every deal as saved, whole, for a change of stages: an incomplete read never authorizes one. */
async function dealSnapshot(statsId: string): Promise<{ id: string; before: string; record: Record<string, unknown> }[]> {
  const out: { id: string; before: string; record: Record<string, unknown> }[] = [];
  try {
    const response = await redisPipeline([["HGETALL", dealsKey(statsId)]]);
    if (!Array.isArray(response) || response.length !== 1 || !Array.isArray(response[0]) || response[0].length % 2 !== 0) throw new CrmSchemaReadUnavailable();
    const flat: unknown[] = response[0];
    const seen = new Set<string>();
    for (let i = 0; i < flat.length; i += 2) {
      const id = flat[i];
      if (typeof id !== "string" || !DEAL_ID.test(id) || seen.has(id) || typeof flat[i + 1] !== "string") throw new CrmSchemaReadUnavailable();
      const raw: unknown = JSON.parse(flat[i + 1] as string);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CrmSchemaReadUnavailable();
      const record = raw as Record<string, unknown>;
      if (record.id !== id || typeof record.stage !== "string" || !CRM_ID.test(record.stage)) throw new CrmSchemaReadUnavailable();
      seen.add(id);
      out.push({ id, before: flat[i + 1] as string, record });
    }
  } catch { throw new CrmSchemaReadUnavailable(); }
  return out;
}

/** Saves the pipelines only over the exact record read before (one key, compare and set): a concurrent change is never overwritten. */
export const SAVE_CRM_PIPELINES = `-- marktmorgen:crm-pipelines-save:v2
local current = redis.call("GET", KEYS[1])
if (current or "") ~= ARGV[1] then
  if current then return {-1, string.len(current)} end
  return {-1}
end
redis.call("SET", KEYS[1], ARGV[2])
return 1`;

/**
 * Writes pipelines over the snapshot read, then the first pipeline's copy
 * for the board's old key, then moves each deal whose stage went to the
 * stage `target` names, over its exact record (MOVE_CRM_DEAL).
 */
async function writePipelines(statsId: string, snapshotRaw: string, pipelines: Pipeline[], moved: { id: string; before: string; record: Record<string, unknown> }[], room: DataStore): Promise<void> {
  const record = JSON.stringify(pipelines);
  // Their room in the store's data room first (DataRoomError when they do not fit, and nothing is written).
  await needData(room, [{ slot: PIPES_SLOT, bytes: dataBytes([record], 1), set: true }]);
  let saved: unknown;
  try {
    saved = await redisPipeline([["EVAL", SAVE_CRM_PIPELINES, 1, pipesKey(statsId), snapshotRaw, record]]);
  } catch { throw new CrmSchemaWriteUnconfirmed(); }
  const lost = changedLength(Array.isArray(saved) && saved.length === 1 ? saved[0] : undefined);
  if (lost !== undefined) {
    // Nothing was written: the room goes back to what the record kept there now weighs, as the script measured it in
    // the same step (the write that changed it meanwhile sized the room to itself, never to the snapshot read here).
    await giveData(room, [{ slot: PIPES_SLOT, bytes: lost === null ? 0 : dataBytesOfLength(lost, 1), set: true }]).catch(() => {});
    throw new CrmSchemaConflict();
  }
  if (!Array.isArray(saved) || saved.length !== 1 || saved[0] !== 1) throw new CrmSchemaWriteUnconfirmed();
  try {
    const copied = await redisPipeline([["SET", stagesKey(statsId), JSON.stringify(pipelines[0].stages)]]);
    if (!Array.isArray(copied) || copied.length !== 1 || copied[0] !== "OK") throw new CrmSchemaWriteUnconfirmed();
    if (moved.length) {
      const response = await redisPipeline(moved.map(({ id, before, record }) => ["EVAL", MOVE_CRM_DEAL, 1, dealsKey(statsId), id, before, JSON.stringify(record)]));
      if (!Array.isArray(response) || response.length !== moved.length || Array.from(response).some(value => value !== 0 && value !== 1)) throw new CrmSchemaWriteUnconfirmed();
    }
  } catch { throw new CrmSchemaWriteUnconfirmed(); }
}

/**
 * Saves one pipeline, adds one, or removes one (lib/crm-rules.ts,
 * changePipeline), with the deals of every stage that goes moved where
 * `moves` says. A refusal writes nothing. Moves made here start no
 * workflow: a stage removed is not a deal entering a stage.
 */
export async function savePipelineChange(statsId: string, change: { pipeline?: unknown; remove?: string }, moves: unknown, limit: number, room: DataStore): Promise<PipelineChange> {
  const deals = await dealSnapshot(statsId);
  const { raw, pipelines: current } = await pipelineSnapshot(statsId);
  const counts = new Map<string, number>();
  for (const d of deals) counts.set(String(d.record.stage), (counts.get(String(d.record.stage)) ?? 0) + 1);
  const result = changePipeline(current, change, moves, counts, limit);
  if (!result.ok) return result;
  const kept = new Set(allStages(result.pipelines).map((s) => s.id));
  const fallback = result.pipelines[0].stages.find((s) => s.kind === "open")!.id;
  // A deal whose stage was already in no pipeline (written by an older board) is brought back to the first pipeline's first open stage.
  const moved = deals.filter((d) => !kept.has(String(d.record.stage))).map((d) => ({ ...d, record: { ...d.record, stage: result.moves[String(d.record.stage)] ?? fallback } }));
  await writePipelines(statsId, raw, result.pipelines, moved, room);
  return result;
}

/**
 * A compare-and-set script's "changed" answer (SAVE_CRM_PIPELINES, MOVE_CRM_DEAL): the UTF-8 length of the record
 * there now, null when there is none, undefined for any other answer.
 */
function changedLength(answer: unknown): number | null | undefined {
  if (!Array.isArray(answer) || answer[0] !== -1) return undefined;
  if (answer.length === 1) return null;
  return answer.length === 2 && Number.isSafeInteger(answer[1]) && answer[1] >= 0 ? answer[1] : undefined;
}

/** Move only the exact snapshot reviewed; never resurrect a deleted opportunity. */
export const MOVE_CRM_DEAL = `-- marktmorgen:crm-deal-move:v2
local current = redis.call("HGET", KEYS[1], ARGV[1])
if not current then return 0 end
if current ~= ARGV[2] then return {-1, string.len(current)} end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[3])
return 1`;

/**
 * Saves the first pipeline's stages, as the board did before pipelines (the
 * studio's older "stages" request): a deal in a stage that is gone moves to
 * the first open one of them.
 */
export async function writeStages(statsId: string, stages: Stage[], room: DataStore): Promise<Stage[]> {
  const first = stages.find(s => s.kind === "open");
  if (!first) throw new CrmSchemaReadUnavailable();
  const deals = await dealSnapshot(statsId);
  const { raw, pipelines: current } = await pipelineSnapshot(statsId);
  const next = parsePipelines([{ ...current[0], stages }, ...current.slice(1)]);
  if (!next) throw new CrmSchemaReadUnavailable();
  const kept = new Set(allStages(next).map(s => s.id));
  // Preserve every saved field; moving stages must not normalize away unrelated data.
  const moved = deals.filter(d => !kept.has(String(d.record.stage))).map(d => ({ ...d, record: { ...d.record, stage: first.id } }));
  await writePipelines(statsId, raw, next, moved, room);
  return stages;
}

/** Every deal, newest change first. `stages` reads a deal in a stage the store still has. */
export async function readDeals(statsId: string | null, stages: readonly Stage[]): Promise<Deal[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HVALS", dealsKey(statsId)]]);
  return (Array.isArray(raw) ? raw : [])
    .map((value) => parseDeal(json(value), stages))
    .filter((d): d is Deal => d !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * A deal's version: a hash of its exact stored record, so any change to it,
 * a stage moved by a pipeline change included (which leaves updatedAt as it
 * was), gives another one. The board sends it back with an edit, and the
 * edit lands only over that record (635 [GL3]). Server only.
 */
export function dealVersion(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/** `versions` holds each deal's version (dealVersion) by id, read in the same step as the deals. */
export type OpportunityReviewData = { available: boolean; stages: Stage[]; deals: Deal[]; pipelines: Pipeline[]; versions: Record<string, string> };

/** A complete link/contact review read; unknown storage never means no opportunities. */
export async function readOpportunityReview(statsId: string | null): Promise<OpportunityReviewData> {
  const unavailable: OpportunityReviewData = { available: false, stages: [], deals: [], pipelines: [], versions: {} };
  if (!statsId || !isRedisConfigured()) return unavailable;
  try {
    const replies = await redisPipeline([["GET", stagesKey(statsId)], ["HGETALL", dealsKey(statsId)], ["GET", pipesKey(statsId)]]);
    if (!Array.isArray(replies) || replies.length !== 3 || !Array.isArray(replies[1]) || replies[1].length % 2 !== 0) return unavailable;
    let stages: Stage[];
    let pipelines: Pipeline[] | null = null;
    if (replies[2] !== null) {
      if (typeof replies[2] !== "string") return unavailable;
      pipelines = parsePipelines(json(replies[2]));
      if (!pipelines) return unavailable;
      stages = allStages(pipelines);
    } else if (replies[0] === null) stages = DEFAULT_STAGES;
    else {
      if (typeof replies[0] !== "string") return unavailable;
      const raw = json(replies[0]);
      const parsed = parseStages(raw);
      if (!Array.isArray(raw) || !parsed || parsed.length !== raw.length) return unavailable;
      stages = parsed;
    }
    const deals: Deal[] = [], seen = new Set<string>(), versions: Record<string, string> = {};
    const pairs: unknown[] = replies[1];
    for (let i = 0; i < pairs.length; i += 2) {
      const id = pairs[i], value = pairs[i + 1];
      if (typeof id !== "string" || !DEAL_ID.test(id) || seen.has(id) || typeof value !== "string") return unavailable;
      const record = json(value);
      const deal = parseDeal(record, stages);
      if (!deal || deal.id !== id || !record || typeof record !== "object" || Array.isArray(record)) return unavailable;
      const raw = record as Record<string, unknown>;
      const ref = raw.formResponseRef;
      if (ref !== undefined && ref !== null && ref !== "" && (typeof ref !== "string" || !/^[a-f0-9]{64}$/.test(ref))) return unavailable;
      if (raw.email !== undefined && (typeof raw.email !== "string" || (raw.email.trim() && !deal.email))) return unavailable;
      seen.add(id);
      deals.push(deal);
      versions[id] = dealVersion(value);
    }
    return { available: true, stages, deals: deals.sort((a, b) => b.updatedAt - a.updatedAt), pipelines: pipelines ?? [firstPipeline(stages)], versions };
  } catch { return unavailable; }
}

/**
 * Capacity and save share one Redis operation, including alongside form
 * conversions. An edit (ARGV[4] "edit") writes only a deal that is still
 * there: one deleted since it was read (by its person's deletion, or by
 * someone else) answers 2 and is never written back.
 */
export const SAVE_CRM_DEAL = `-- marktmorgen:crm-deal-save:v2
local there = redis.call("HEXISTS", KEYS[1], ARGV[1])
if there == 0 and ARGV[4] == "edit" then return 2 end
if there == 0 and redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return 1`;

/** Where a deal is counted in the store's data room (lib/store-data.ts): one slot a deal, at what it weighs. */
export const dealSlot = (id: string) => `dl:${id}`;
export const dealBytes = (deal: Deal) => dataBytes([deal.id, JSON.stringify(deal)], 1);

/**
 * Saves a deal. False when the store already has as many as it may and this
 * one is new. Its room in the store's data room is taken first: DataRoomError
 * when it does not fit, and nothing is written. With `edit`, the deal is
 * written only if it is still there: "gone" when it was deleted since it was
 * read, with its room given back, so a deleted person's deal never comes back.
 */
export async function writeDeal(statsId: string, deal: Deal, room: DataStore): Promise<boolean>;
export async function writeDeal(statsId: string, deal: Deal, room: DataStore, edit: "edit"): Promise<boolean | "gone">;
export async function writeDeal(statsId: string, deal: Deal, room: DataStore, edit?: "edit"): Promise<boolean | "gone"> {
  let preflight: unknown;
  try {
    preflight = await redisPipeline([["HEXISTS", dealsKey(statsId), deal.id], ["HLEN", dealsKey(statsId)]]);
  } catch { throw new CrmDealReadUnavailable(); }
  if (!Array.isArray(preflight) || preflight.length !== 2 || (preflight[0] !== 0 && preflight[0] !== 1) || typeof preflight[1] !== "number" || !Number.isSafeInteger(preflight[1]) || preflight[1] < preflight[0]) throw new CrmDealReadUnavailable();
  // An edit of a deal deleted since it was read is "gone", full board or not, and its room is not touched.
  if (preflight[0] === 0 && edit) return "gone";
  if (preflight[0] === 0 && preflight[1] >= MAX_DEALS) return false;
  await needData(room, [{ slot: dealSlot(deal.id), bytes: dealBytes(deal), set: true }]);
  try {
    const saved = await redisPipeline([["EVAL", SAVE_CRM_DEAL, 1, dealsKey(statsId), deal.id, JSON.stringify(deal), MAX_DEALS, edit ?? ""]]);
    if (!Array.isArray(saved) || saved.length !== 1 || (saved[0] !== 0 && saved[0] !== 1 && !(edit && saved[0] === 2))) throw new CrmDealWriteUnconfirmed();
    // Full after all, or deleted since it was read: the deal's room goes back.
    if (saved[0] !== 1) await giveData(room, [{ slot: dealSlot(deal.id), bytes: 0, set: true }]);
    return saved[0] === 2 ? "gone" : saved[0] === 1;
  } catch { throw new CrmDealWriteUnconfirmed(); }
}

/**
 * One deal as it is kept now, with its exact record, so a write lands over
 * that record only (writeDealOver). A read that fails throws
 * CrmDealReadUnavailable; a deal that is gone reads as null.
 */
export async function readDealExact(statsId: string, id: string, stages: readonly Stage[]): Promise<{ deal: Deal | null; raw: string | null }> {
  if (!DEAL_ID.test(id)) return { deal: null, raw: null };
  let reply: unknown;
  try {
    reply = await redisPipeline([["HGET", dealsKey(statsId), id]]);
  } catch { throw new CrmDealReadUnavailable(); }
  if (!Array.isArray(reply) || reply.length !== 1 || (reply[0] !== null && typeof reply[0] !== "string")) throw new CrmDealReadUnavailable();
  const raw = reply[0] as string | null;
  return { deal: raw === null ? null : parseDeal(json(raw), stages), raw };
}

/**
 * Saves a deal over the exact record read (readDealExact), in one step on the
 * Redis side (MOVE_CRM_DEAL): "changed", and nothing written, when the record
 * is not that one any more or is gone, so a step never lands a stale copy
 * over what the creator did on the board meanwhile. Its room is taken first,
 * and put back as it was when nothing was written.
 */
export async function writeDealOver(statsId: string, deal: Deal, before: string, room: DataStore): Promise<"saved" | "changed"> {
  await needData(room, [{ slot: dealSlot(deal.id), bytes: dealBytes(deal), set: true }]);
  let saved: unknown;
  try {
    saved = await redisPipeline([["EVAL", MOVE_CRM_DEAL, 1, dealsKey(statsId), deal.id, before, JSON.stringify(deal)]]);
  } catch { throw new CrmDealWriteUnconfirmed(); }
  const answer = Array.isArray(saved) && saved.length === 1 ? saved[0] : undefined;
  const lost = changedLength(answer);
  if (answer !== 1 && answer !== 0 && typeof lost !== "number") throw new CrmDealWriteUnconfirmed();
  if (answer === 1) return "saved";
  // Nothing written: its room put back to what the record kept there now weighs (the board's own write sized it to
  // that), as the script measured it in the same step, or none when it is gone. So a record the board made bigger is
  // never counted at its old size, and no second read can fail in between.
  await giveData(room, [{ slot: dealSlot(deal.id), bytes: typeof lost === "number" ? dataBytesOfLength(utf8Length(deal.id) + lost, 1) : 0, set: true }]);
  return "changed";
}

export async function readDeal(statsId: string, id: string, stages: readonly Stage[]): Promise<Deal | null> {
  if (!DEAL_ID.test(id)) return null;
  const [raw] = await redisPipeline([["HGET", dealsKey(statsId), id]]);
  return parseDeal(json(raw), stages);
}

export async function dropDeal(statsId: string, id: string, room: DataStore): Promise<boolean> {
  if (!DEAL_ID.test(id)) return false;
  let removed: unknown;
  try {
    removed = await redisPipeline([["HDEL", dealsKey(statsId), id]]);
  } catch { throw new CrmDealWriteUnconfirmed(); }
  if (!Array.isArray(removed) || removed.length !== 1 || (removed[0] !== 0 && removed[0] !== 1)) throw new CrmDealWriteUnconfirmed();
  if (removed[0] === 1) await giveData(room, [{ slot: dealSlot(id), bytes: 0, set: true }]);
  return removed[0] === 1;
}

/**
 * Everything kept here for a store that is being deleted: its fields,
 * pipelines, deals and values, and then its tasks about people (639
 * [GL7](6)). The tasks go at once, with the rest, and again under the
 * tasks' lock, so a change read before cannot write them back after; a lock
 * still taken after the wait throws (LockBusyError), with everything already
 * deleted once. A change that reaches the lock after the store is gone finds
 * no store and writes nothing (changePersonTasks).
 */
export async function forgetCrm(statsId: string | null): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const fields = await readFields(statsId);
  await redisPipeline([["DEL", fieldsKey(statsId), stagesKey(statsId), pipesKey(statsId), dealsKey(statsId), tasksKey(statsId), ...fields.map((f) => valuesKey(statsId, f.id))]]);
  await withLock(tasksLockKey(statsId), TASKS_LOCK_SECONDS, TASKS_FORGET_WAIT_MS, () => redisPipeline([["DEL", tasksKey(statsId)]]));
}

/** One person's value of a field deleted, answered with what it was (null when there was none). */
const TAKE_CRM_VALUE = `-- marktmorgen:crm-value-take:v1
local value = redis.call("HGET", KEYS[1], ARGV[1])
if value then redis.call("HDEL", KEYS[1], ARGV[1]) end
return value`;

/**
 * Deletes one person from the store's fields, deals and tasks
 * (lib/person-erasure.ts): every value kept under their key, every deal with
 * them, by the address a deal names, and the team's tasks about them; the
 * room all of these took goes back to `room` when it is given. Answers how many records went.
 */
export async function forgetCrmPerson(statsId: string | null, person: string, email: string, room?: DataStore): Promise<number> {
  if (!statsId || !PERSON.test(person) || !isRedisConfigured()) return 0;
  // First the mark that they were deleted, and their next generation, before anything is taken away: a value set from
  // here on is refused until they come back on their own, and from a page read before now for good (SET_CRM_VALUE); one
  // written before is taken away below. An erasure whose mark is not confirmed fails, to be run again.
  const marked = await redisPipeline([
    ["SET", erasedKey(statsId, person), String(Date.now()), "EX", ERASED_MARK_SECONDS],
    ["INCR", generationKey(statsId, person)],
    ["EXPIRE", generationKey(statsId, person), ERASED_MARK_SECONDS],
  ]);
  if (!Array.isArray(marked) || marked.length !== 3 || marked[0] !== "OK" || typeof marked[1] !== "number" || marked[2] !== 1) throw new CrmValueWriteUnconfirmed();
  const fields = await readFields(statsId);
  const address = email.trim().toLowerCase();
  const [raw] = await redisPipeline([["HGETALL", dealsKey(statsId)]]);
  const pairs: [string, string][] = [];
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]), String(raw[i + 1])]);
  else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw as Record<string, string>)) pairs.push([k, String(v)]);
  const theirs = pairs.filter(([, value]) => {
    const deal = json(value) as { email?: unknown } | null;
    return typeof deal?.email === "string" && deal.email.trim().toLowerCase() === address;
  }).map(([id]) => id);
  // Each value taken out in one script that answers what it deleted, each deal
  // deleted on its own: what goes back to the store's data room is exactly
  // what was removed, even with a change of the same value at the same time.
  const commands: (string | number)[][] = [
    ...fields.map((f) => ["EVAL", TAKE_CRM_VALUE, 1, valuesKey(statsId, f.id), person]),
    ...theirs.map((id) => ["HDEL", dealsKey(statsId), id]),
  ];
  const replies = commands.length ? await redisPipeline(commands) : [];
  let records = 0;
  let valuesFreed = 0;
  fields.forEach((_, i) => {
    const taken = replies[i];
    if (typeof taken !== "string") return;
    records += 1;
    if (taken) valuesFreed += dataBytes([person, taken], 1);
  });
  const dealsGone = theirs.filter((_, i) => replies[fields.length + i] === 1);
  records += dealsGone.length;
  if (room && (valuesFreed > 0 || dealsGone.length)) {
    await giveData(room, [
      ...(valuesFreed > 0 ? [{ slot: VALUES_SLOT, bytes: valuesFreed }] : []),
      ...dealsGone.map((id) => ({ slot: dealSlot(id), bytes: 0, set: true })),
    ]);
  }
  // Their tasks (639 [GL7](6)) go with them, under the tasks' lock, so a
  // change read before the deletion cannot write them back after it; their
  // values and deals above never wait on it. A lock still taken after the
  // wait throws (LockBusyError): the deletion fails and says so, never skips
  // them.
  records += await withLock(tasksLockKey(statsId), TASKS_LOCK_SECONDS, TASKS_FORGET_WAIT_MS, async () => {
    // Read first, for how many tasks the store's count loses; then one
    // script deletes them and answers what it deleted, so what is given back
    // is what the deletion removed. Should their tasks have changed between
    // the two (a lock that ran out), the count is dropped, to be made again.
    const [read] = await redisPipeline([["HGET", tasksKey(statsId), person]]);
    const reply = await redisPipeline([["EVAL", FORGET_PERSON_TASKS, 1, tasksKey(statsId), person, typeof read === "string" ? read : "", tasksOf(read).length, TASK_COUNT_FIELD]]);
    const [taken] = reply;
    if (!Array.isArray(taken) || taken.length !== 2 || typeof taken[0] !== "string" || (taken[1] !== 0 && taken[1] !== 1)) throw new CrmValueWriteUnconfirmed();
    const freed = taskWeight(person, taken[0]) + (taken[1] === 1 ? TASK_COUNT_WEIGHT : 0);
    if (freed > 0 && room) await giveData(room, [{ slot: TASKS_SLOT, bytes: freed }]);
    return taken[0] ? 1 : 0;
  });
  return records;
}

/**
 * A person's tasks deleted, answered as { what was deleted ("" for none),
 * 1 when the count was dropped }. ARGV: the person, their tasks as read
 * before, how many those were, the count's field. The count loses that many
 * when what is deleted is what was read (and it is a whole number);
 * otherwise it is dropped, and made again from every task by the next add
 * that needs it.
 */
export const FORGET_PERSON_TASKS = `-- marktmorgen:crm-tasks-forget:v1
local value = redis.call("HGET", KEYS[1], ARGV[1])
if not value then return {"", 0} end
redis.call("HDEL", KEYS[1], ARGV[1])
local kept = redis.call("HGET", KEYS[1], ARGV[4])
local n = kept and string.match(kept, "^%d+$") and tonumber(kept)
if n and value == ARGV[2] then
  redis.call("HSET", KEYS[1], ARGV[4], tostring(math.max(0, n - tonumber(ARGV[3]))))
  return {value, 0}
end
return {value, redis.call("HDEL", KEYS[1], ARGV[4])}`;

/**
 * One person's tasks written, and the store's count with them, in one step.
 * ARGV: the person; their tasks as read under the lock ("" for none); the new
 * tasks ("" deletes the record); how many tasks that adds (negative when it
 * takes some away); the count to start from when there is none yet ("" to
 * leave it absent); the count's field. Answers -1, with nothing written, when
 * the person's tasks are no longer what was read (a lock that ran out let
 * another change in); 1 once written; 2 once written when a count that was
 * not a whole number was dropped or replaced, whose room goes back. A count
 * that is there is moved by the change. KEYS[2] and KEYS[3] are the person's
 * deletion mark and generation, ARGV[7] the generation the change carries:
 * 3, with nothing written, while they are deleted or for a page read before a
 * deletion (erasedGuard). ARGV[8] is MAX_STORE_TASKS: 4, with nothing
 * written, for a change that adds past it, checked against the count as it is
 * in the same step. With the person's tasks compared to what was read, nothing
 * a change read can be stale when it writes, so the lock is not held again
 * before it. Inside: the mark and the generation read, the tasks and the
 * count read, the tasks and the count written (WRITE_TASKS_CALLS).
 */
export const WRITE_PERSON_TASKS = `-- marktmorgen:crm-tasks-write:v2
${erasedGuard(2, 3, 7, "3")}
local before = redis.call("HGET", KEYS[1], ARGV[1]) or ""
if before ~= ARGV[2] then return -1 end
local kept = redis.call("HGET", KEYS[1], ARGV[6])
local n = kept and string.match(kept, "^%d+$") and tonumber(kept)
if n and tonumber(ARGV[4]) > 0 and n + tonumber(ARGV[4]) > tonumber(ARGV[8]) then return 4 end
if ARGV[3] == "" then redis.call("HDEL", KEYS[1], ARGV[1]) else redis.call("HSET", KEYS[1], ARGV[1], ARGV[3]) end
if n then
  redis.call("HSET", KEYS[1], ARGV[6], tostring(math.max(0, n + tonumber(ARGV[4]))))
elseif ARGV[5] ~= "" then
  redis.call("HSET", KEYS[1], ARGV[6], ARGV[5])
  if kept then return 2 end
elseif kept then
  redis.call("HDEL", KEYS[1], ARGV[6])
  return 2
end
return 1`;
/** What WRITE_PERSON_TASKS runs inside, at the most, which Upstash bills one by one beside the EVAL. */
export const WRITE_TASKS_CALLS = ERASED_GUARD_CALLS + 4;

/**
 * The store's count saved on its own, once every task was read to make it:
 * 0 when a whole number is there already (nothing written), 1 when written
 * where there was none, 2 when written over one that was not a whole number.
 */
export const SAVE_TASK_COUNT = `-- marktmorgen:crm-tasks-count-save:v1
local kept = redis.call("HGET", KEYS[1], ARGV[1])
if kept and string.match(kept, "^%d+$") then return 0 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
if kept then return 2 end
return 1`;

/** The count as kept: a whole number, or null when there is none (or it is not one). */
function countOf(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/** A change that needs every task of the store read to make its count again, and the studio would not pay for it. */
export class TasksRecountRefused extends Error {
  /** What the studio said when it refused, for the person who asked. */
  readonly words: string;
  /** Why: "unknown" when it could not be counted just now (try again), else the figure or its pool used. */
  readonly reason: string;
  constructor(words: string, reason = "used") {
    super("The store's tasks were not counted: the studio requests for it were refused");
    this.name = "TasksRecountRefused";
    this.words = words;
    this.reason = reason;
  }
}

/** What one person's tasks take in the store's data room, as kept. */
const taskWeight = (person: string, value: unknown) => (typeof value === "string" && value ? dataBytes([person, value], 1) : 0);

function tasksOf(raw: unknown): PersonTask[] {
  if (typeof raw !== "string" || !raw) return [];
  return parseTasks(json(raw));
}

/** One person's tasks, open and done, in the order they were written (639 [GL7](6)). */
export async function readPersonTasks(statsId: string | null, person: string): Promise<PersonTask[]> {
  if (!statsId || !PERSON.test(person) || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HGET", tasksKey(statsId), person]]);
  return tasksOf(raw);
}

/**
 * How many people have tasks in the store: one HLEN and one HEXISTS, never
 * the tasks themselves. What reading every task is paid for by
 * (tasksRecountUnits), before it is read: the agenda and the recount.
 */
export async function taskPeople(statsId: string | null): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [fields, counted] = await redisPipeline([["HLEN", tasksKey(statsId)], ["HEXISTS", tasksKey(statsId), TASK_COUNT_FIELD]]);
  return Math.max(0, (Number(fields) || 0) - (counted === 1 ? 1 : 0));
}

/** Everyone's tasks, by person: what the agenda groups (lib/person-tasks.ts, tasksDue). At most MAX_STORE_TASKS. */
export async function readAllTasks(statsId: string | null): Promise<DueTask[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HGETALL", tasksKey(statsId)]]);
  const pairs: [string, unknown][] = [];
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]), raw[i + 1]]);
  else if (raw && typeof raw === "object") pairs.push(...Object.entries(raw as Record<string, unknown>));
  const out: DueTask[] = [];
  for (const [person, value] of pairs) {
    if (!PERSON.test(person)) continue;
    for (const task of tasksOf(value)) if (out.length < MAX_STORE_TASKS) out.push({ person, task });
  }
  return out;
}

/**
 * Changes one person's tasks: `change` gets their tasks and answers the new
 * list or a refusal. A list that grows past MAX_STORE_TASKS across the store
 * is refused ("store_full"), checked against the store's count of its tasks
 * (TASK_COUNT_FIELD), one number, never every task. A store whose count is
 * not there yet while it keeps tasks (it kept them before the count) has it
 * made once from every task, when a change first grows its tasks: `pay` is
 * asked for tasksRecountUnits(people) studio requests first, outside the
 * tasks' lock and one recount at a time (a second change waits, then finds
 * the count made), and a refusal throws TasksRecountRefused with nothing
 * written. The count is saved as soon as it is made, before the change is
 * checked against the cap and the room, so a change refused after it never
 * loses what was paid for. Room
 * in the store's data room is taken before writing (DataRoomError when it
 * does not fit); a shorter list gives it back. The read, the change, the
 * room and the write happen under the store's tasks lock, the write and the
 * count in one script, so each real change is kept and counted exactly once;
 * a change about a person who is deleted, or from a page read before a
 * deletion (`generation`, as the page read it: lib/crm.ts readGeneration;
 * a page that sends none is read as 0), is refused "gone" in that script,
 * with nothing written (erasedGuard);
 * a change that cannot take it within TASKS_LOCK_WAIT_MS throws
 * LockBusyError, with nothing written or counted.
 */
export async function changePersonTasks(
  statsId: string,
  person: string,
  room: DataStore,
  change: (tasks: PersonTask[]) => TaskResult,
  pay: (units: number) => Promise<{ ok: true } | { ok: false; reason: string; message: string }> = async () => ({ ok: false, reason: "used", message: "" }),
  generation = 0,
): Promise<TaskResult> {
  if (!PERSON.test(person)) return { ok: false, error: "unknown" };
  const carried = carriedGeneration(generation);
  const first = await withLock(tasksLockKey(statsId), TASKS_LOCK_SECONDS, TASKS_LOCK_WAIT_MS, (held) => changeOnce(statsId, person, room, change, 0, held, carried));
  if ("result" in first) return first.result;
  // A recount: one at a time for the store, so two changes never both pay.
  // Its first pass looks again, and pays nothing when the one before made it.
  return withLock(recountLockKey(statsId), RECOUNT_LOCK_SECONDS, RECOUNT_WAIT_MS, async (recount) => {
    let paid = 0;
    // At most three passes: the second after paying, the third only when
    // more people were added meanwhile than were paid for. The last one
    // never pays: nothing would read after it.
    for (let pass = 0; pass < RECOUNT_PASSES; pass += 1) {
      const outcome = await withLock(tasksLockKey(statsId), TASKS_LOCK_SECONDS, TASKS_LOCK_WAIT_MS, (held) => changeOnce(statsId, person, room, change, paid, held, carried));
      if ("result" in outcome) return outcome.result;
      if (pass === RECOUNT_PASSES - 1) break;
      const answer = await pay(outcome.units - paid);
      if (!answer.ok) throw new TasksRecountRefused(answer.message, answer.reason);
      paid = outcome.units;
      // Paying may have taken longer than the recount's lock (a Stripe
      // read): lost, another change may be recounting too, so nothing is read.
      if (!(await holdLock(recount))) throw new LockBusyError();
    }
    throw new LockBusyError();
  });
}

/** One pass of changePersonTasks, under the lock: its answer, or the studio requests a recount needs before it can be made. */
async function changeOnce(statsId: string, person: string, room: DataStore, change: (tasks: PersonTask[]) => TaskResult, paid: number, held: Held, carried: number): Promise<{ result: TaskResult } | { units: number }> {
  // A change that waited while the store was deleted writes nothing back:
  // its tasks are gone with it (forgetCrm). One EXISTS of the store's id
  // key; a store whose id is not of today's form (none is made any more)
  // relies on forgetCrm's second deletion under this lock instead.
  if (room.sid && STORE_ID_PATTERN.test(room.sid) && !(await storeIdExists(room.sid))) return { result: { ok: false, error: "unknown" } };
  const [before, kept, fields] = await redisPipeline([["HGET", tasksKey(statsId), person], ["HGET", tasksKey(statsId), TASK_COUNT_FIELD], ["HLEN", tasksKey(statsId)]]);
  const tasks = tasksOf(before);
  const result = change(tasks);
  if (!result.ok) return { result };
  const added = result.tasks.length - tasks.length;
  let count = countOf(kept);
  let start = "";
  if (added > 0 && count === null) {
    // No count yet: none is needed for a store with no tasks; one that has
    // some has every task read, once, paid for first.
    const people = Math.max(0, (Number(fields) || 0) - (kept === null || kept === undefined ? 0 : 1));
    if (people > 0) {
      const units = tasksRecountUnits(people);
      if (units > paid) return { units };
      count = (await readAllTasks(statsId)).length;
      // Saved at once, before the cap and the room are checked, so what was
      // paid for is kept whatever this change comes to. Its field is counted
      // as written (noteData, never refused): the count stands for tasks
      // already kept, and a full room must not throw the recount away.
      if (!(await holdLock(held))) throw new LockBusyError();
      let saved: unknown;
      try {
        [saved] = await redisPipeline([["EVAL", SAVE_TASK_COUNT, 1, tasksKey(statsId), TASK_COUNT_FIELD, String(count)]]);
      } catch {
        throw new CrmValueWriteUnconfirmed();
      }
      if (saved !== 0 && saved !== 1 && saved !== 2) throw new CrmValueWriteUnconfirmed();
      // 0: a whole number was there after all, which only a change let in by a
      // lost lock could have saved: nothing is written and the change is
      // refused as busy; trying again reads that count, and pays nothing.
      if (saved === 0) throw new LockBusyError();
      if (saved === 1) await noteData(room, [{ slot: TASKS_SLOT, bytes: TASK_COUNT_WEIGHT }]);
    } else {
      count = 0;
      start = String(added);
    }
  }
  if (added > 0 && (count ?? 0) + added > MAX_STORE_TASKS) return { result: { ok: false, error: "store_full" } };
  const value = result.tasks.length ? JSON.stringify(result.tasks) : "";
  const grown = taskWeight(person, value) - taskWeight(person, before) + (start ? TASK_COUNT_WEIGHT : 0);
  // A lock that ran out meanwhile (a stalled request) may have let another change in: the script writes only over the
  // tasks as read (-1 otherwise) and checks the cap against the count as it is (4), so nothing stale is counted or written.
  // Room is taken before a write that grows, and given back only after a
  // write that shrinks is confirmed: one that may not have landed keeps it.
  if (grown > 0) await needData(room, [{ slot: TASKS_SLOT, bytes: grown }]);
  let written: unknown;
  try {
    const response = await redisPipeline([["EVAL", WRITE_PERSON_TASKS, 3, tasksKey(statsId), erasedKey(statsId, person), generationKey(statsId, person), person, typeof before === "string" ? before : "", value, added, start, TASK_COUNT_FIELD, carried, MAX_STORE_TASKS]]);
    if (!Array.isArray(response) || response.length !== 1 || ![1, 2, 3, 4, -1].includes(response[0] as number)) throw new CrmValueWriteUnconfirmed();
    written = response[0];
  } catch {
    throw new CrmValueWriteUnconfirmed();
  }
  if (written === 3 || written === 4) {
    // The person is deleted, or the page was read before a deletion; or the store filled meanwhile: nothing written,
    // the room taken for it goes back.
    if (grown > 0) await giveData(room, [{ slot: TASKS_SLOT, bytes: grown }]);
    return { result: { ok: false, error: written === 3 ? "gone" : "store_full" } };
  }
  if (written === -1) {
    // Nothing was written: the room taken for it goes back, and the change is refused as busy.
    if (grown > 0) await giveData(room, [{ slot: TASKS_SLOT, bytes: grown }]);
    throw new LockBusyError();
  }
  // A count that was not a whole number, dropped or replaced: the room it took goes back.
  const freed = (grown < 0 ? -grown : 0) + (written === 2 ? TASK_COUNT_WEIGHT : 0);
  if (freed > 0) await giveData(room, [{ slot: TASKS_SLOT, bytes: freed }]);
  return { result };
}

/** How many deals the store keeps: what deleting a person reads (lib/person-erasure.ts). */
export async function dealCount(statsId: string | null): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["HLEN", dealsKey(statsId)]]);
  return Number(n) || 0;
}
