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
 *   nl:crm:taskrecount:<statsId>     one paid recount of the store's tasks at a time (lib/redis-lock.ts), thirty seconds at the most
 *
 * A value is kept under the person's key, never the address (as a note
 * about them is), one hash a field, so the list's file reads each field once
 * however long the list is.
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { STORE_ID_PATTERN, storeIdExists } from "@/lib/store";
import { type DataStore, giveData, needData, noteData } from "@/lib/store-data";
import { dataBytes, dataBytesOfLength, utf8Length } from "@/lib/store-data-rules";
import { type Held, LockBusyError, holdLock, withLock } from "@/lib/redis-lock";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { type DueTask, MAX_PERSON_TASKS, MAX_STORE_TASKS, type PersonTask, type TaskResult, parseTasks } from "@/lib/person-tasks";
import {
  type CrmField,
  CRM_ID,
  type Deal,
  DEFAULT_STAGES,
  DEAL_ID,
  MAX_DEALS,
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

export class CrmSchemaReadUnavailable extends Error {
  constructor() { super("CRM configuration preflight could not be confirmed"); this.name = "CrmSchemaReadUnavailable"; }
}
export class CrmSchemaWriteUnconfirmed extends Error {
  constructor() { super("CRM configuration change could not be confirmed"); this.name = "CrmSchemaWriteUnconfirmed"; }
}
/** Somebody else changed (or removed) the deal between this change's read and its write: nothing was written. */
export class CrmDealConflict extends Error {
  constructor() { super("CRM deal changed meanwhile"); this.name = "CrmDealConflict"; }
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
 * The store's fields exactly as saved, for a decision that writes: none only
 * when none were ever saved. A reply in an unknown shape, or a saved list
 * with an entry that does not read, throws CrmSchemaReadUnavailable, never
 * "no fields" (CX-123 rules 24 and 30): a sequence's field step is never
 * turned away, saved or ended as "removed" against fields that are not the
 * store's.
 */
export async function readFieldsWhole(statsId: string | null): Promise<CrmField[]> {
  if (!statsId || !isRedisConfigured()) return [];
  try {
    const response = await redisPipeline([["GET", fieldsKey(statsId)]]);
    if (!Array.isArray(response) || response.length !== 1) throw new CrmSchemaReadUnavailable();
    if (response[0] === null) return [];
    if (typeof response[0] !== "string") throw new CrmSchemaReadUnavailable();
    const raw: unknown = JSON.parse(response[0]);
    if (!Array.isArray(raw)) throw new CrmSchemaReadUnavailable();
    const fields = parseFields(raw);
    if (fields.length !== raw.length) throw new CrmSchemaReadUnavailable();
    return fields;
  } catch { throw new CrmSchemaReadUnavailable(); }
}

/**
 * Saves the fields; the answers kept for a field that is gone go with it.
 * With `keepAll`, nothing is written when a field kept now would be gone
 * (CrmFieldsKept). The fields are read just before the write, not in the
 * same step: a field another session adds in between is left off the list
 * but its answers are never deleted, since only fields read as gone are.
 */
export async function writeFields(statsId: string, fields: CrmField[], keepAll = false): Promise<CrmField[]> {
  const before = await readFieldsWhole(statsId);
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

/** Sets one value for one person; "" clears it. False when it is not a value the field keeps. */
export async function setValue(statsId: string, person: string, field: CrmField, raw: unknown, room: DataStore): Promise<boolean> {
  if (!PERSON.test(person)) return false;
  const value = fieldValue(field, raw);
  if (value === null) return false;
  // A value takes room in the store's data room first (DataRoomError when it does not fit); one cleared gives it back.
  const [before] = await redisPipeline([["HGET", valuesKey(statsId, field.id), person]]);
  const weight = (v: unknown) => (typeof v === "string" && v ? dataBytes([person, v], 1) : 0);
  const grown = weight(value) - weight(before);
  if (grown > 0) await needData(room, [{ slot: VALUES_SLOT, bytes: grown }]);
  else if (grown < 0) await giveData(room, [{ slot: VALUES_SLOT, bytes: -grown }]);
  try {
    const response = await redisPipeline([value ? ["HSET", valuesKey(statsId, field.id), person, value] : ["HDEL", valuesKey(statsId, field.id), person]]);
    if (!Array.isArray(response) || response.length !== 1 || (response[0] !== 0 && response[0] !== 1)) throw new CrmValueWriteUnconfirmed();
  } catch { throw new CrmValueWriteUnconfirmed(); }
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
 * and until then the board it always had, as the first pipeline. A reply in
 * an unknown shape, or a saved record that does not read, throws
 * CrmSchemaReadUnavailable, never the default pipeline in its place (CX-123
 * rules 24 and 30): a teammate's access, a deal's stage or a workflow step
 * is never decided against pipelines that are not the store's.
 */
export async function readPipelines(statsId: string | null): Promise<Pipeline[]> {
  if (!statsId || !isRedisConfigured()) return [firstPipeline(DEFAULT_STAGES)];
  return (await pipelineSnapshot(statsId)).pipelines;
}

/** Every stage of every pipeline, in order: what a deal's stage is read against. */
export async function readStages(statsId: string | null): Promise<Stage[]> {
  return allStages(await readPipelines(statsId));
}

/**
 * The pipelines as saved, for a change made from them (639 [GL7](7), a teammate's access). Since main's
 * readPipelines reads exactly too (CX-123 rules 24 and 30), this is the same reader under the name its callers use.
 */
export const readPipelinesExact = readPipelines;

/** The pipelines exactly as saved, for a change: an unreadable or malformed record never stands in for the defaults. */
async function pipelineSnapshot(statsId: string): Promise<{ raw: string; pipelines: Pipeline[] }> {
  try {
    const response = await redisPipeline([["GET", pipesKey(statsId)], ["GET", stagesKey(statsId)]]);
    if (!Array.isArray(response) || response.length !== 2) throw new CrmSchemaReadUnavailable();
    const [pipes, legacy] = response;
    if (pipes !== null) {
      if (typeof pipes !== "string") throw new CrmSchemaReadUnavailable();
      const pipelines = parsePipelines(json(pipes), true);
      if (!pipelines) throw new CrmSchemaReadUnavailable();
      return { raw: pipes, pipelines };
    }
    // Before any pipeline was saved, the board's own stages, as the board has always read them; the defaults only
    // when that record was never saved either. A board record that does not read whole is unknown (rule 30).
    if (legacy === null) return { raw: "", pipelines: [firstPipeline(DEFAULT_STAGES)] };
    if (typeof legacy !== "string") throw new CrmSchemaReadUnavailable();
    const board = json(legacy);
    const stages = parseStages(board);
    if (!Array.isArray(board) || !stages || stages.length !== board.length) throw new CrmSchemaReadUnavailable();
    return { raw: "", pipelines: [firstPipeline(stages)] };
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
export async function savePipelineChange(statsId: string, change: { pipeline?: unknown; remove?: string }, moves: unknown, limit: number, room: DataStore, mayEdit: (pipelineId: string) => boolean = () => true, sees: (pipelineId: string) => boolean = () => true): Promise<PipelineChange> {
  const deals = await dealSnapshot(statsId);
  const { raw, pipelines: current } = await pipelineSnapshot(statsId);
  const counts = new Map<string, number>();
  for (const d of deals) counts.set(String(d.record.stage), (counts.get(String(d.record.stage)) ?? 0) + 1);
  const result = changePipeline(current, change, moves, counts, limit, sees);
  if (!result.ok) return result;
  const kept = new Set(allStages(result.pipelines).map((s) => s.id));
  const fallback = result.pipelines[0].stages.find((s) => s.kind === "open")!.id;
  // A deal whose stage was already in no pipeline (written by an older board) is brought back to the first
  // pipeline's first open stage, only by someone who may change that pipeline (`mayEdit`, 639 [GL7](7));
  // anyone else leaves it where it is.
  const adopt = mayEdit(result.pipelines[0].id);
  const moved = deals
    .filter((d) => !kept.has(String(d.record.stage)) && (Object.hasOwn(result.moves, String(d.record.stage)) || adopt))
    .map((d) => ({ ...d, record: { ...d.record, stage: Object.hasOwn(result.moves, String(d.record.stage)) ? result.moves[String(d.record.stage)] : fallback } }));
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
 * the first open one of them. With `firstId` (the pipeline whose access was
 * checked), the stages are written only while that pipeline is still the
 * first one, in the same snapshot that is written over: otherwise
 * CrmSchemaConflict and nothing is written.
 */
export async function writeStages(statsId: string, stages: Stage[], room: DataStore, firstId?: string): Promise<Stage[]> {
  const first = stages.find(s => s.kind === "open");
  if (!first) throw new CrmSchemaReadUnavailable();
  const deals = await dealSnapshot(statsId);
  const { raw, pipelines: current } = await pipelineSnapshot(statsId);
  if (firstId !== undefined && current[0].id !== firstId) throw new CrmSchemaConflict();
  const next = parsePipelines([{ ...current[0], stages }, ...current.slice(1)], true);
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
      pipelines = parsePipelines(json(replies[2]), true);
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

/** Removes a deal only while it is the exact record read when the removal was checked: 1 removed, 0 already gone, -1 changed meanwhile. */
export const DROP_CRM_DEAL = `-- marktmorgen:crm-deal-drop:v1
local current = redis.call("HGET", KEYS[1], ARGV[1])
if not current then return 0 end
if current ~= ARGV[2] then return -1 end
redis.call("HDEL", KEYS[1], ARGV[1])
return 1`;

/**
 * Removes a deal. With `expected` (the record read when the removal was
 * checked with readDealExact, 639 [GL7](7)), one changed since, moved into a pipeline the
 * person may not change for instance, is never removed: CrmDealConflict.
 */
export async function dropDeal(statsId: string, id: string, room: DataStore, expected?: string): Promise<boolean> {
  if (!DEAL_ID.test(id)) return false;
  let removed: unknown;
  try {
    removed = await redisPipeline([expected === undefined ? ["HDEL", dealsKey(statsId), id] : ["EVAL", DROP_CRM_DEAL, 1, dealsKey(statsId), id, expected]]);
  } catch { throw new CrmDealWriteUnconfirmed(); }
  if (Array.isArray(removed) && removed.length === 1 && removed[0] === -1 && expected !== undefined) throw new CrmDealConflict();
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
    // A record that cannot be read whole (keptTasks) is deleted all the same,
    // and the count dropped, to be made again, rather than moved by a guess:
    // "" as what was read never matches a value that is there.
    const [read] = await redisPipeline([["HGET", tasksKey(statsId), person]]);
    const readable = keptTasks(read);
    const reply = await redisPipeline([["EVAL", FORGET_PERSON_TASKS, 1, tasksKey(statsId), person, readable && typeof read === "string" ? read : "", readable ? readable.length : 0, TASK_COUNT_FIELD]]);
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
 * that is there is moved by the change.
 */
export const WRITE_PERSON_TASKS = `-- marktmorgen:crm-tasks-write:v1
local before = redis.call("HGET", KEYS[1], ARGV[1]) or ""
if before ~= ARGV[2] then return -1 end
if ARGV[3] == "" then redis.call("HDEL", KEYS[1], ARGV[1]) else redis.call("HSET", KEYS[1], ARGV[1], ARGV[3]) end
local kept = redis.call("HGET", KEYS[1], ARGV[6])
local n = kept and string.match(kept, "^%d+$") and tonumber(kept)
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

/**
 * One person's tasks could not be read whole (CX-123 rule 24): the reply was
 * missing or of another shape, or what is kept is not a list of tasks, every
 * entry one. Nothing is said about them (never "no tasks") and nothing is
 * written over them; the routes answer 503 with TASKS_NOT_READ or
 * TASKS_NOT_CHANGED (lib/person-tasks.ts).
 */
export class TasksUnreadable extends UnknownReplyError {
  constructor(what = "a person's tasks") {
    super(what);
    this.name = "TasksUnreadable";
  }
}

/**
 * One person's tasks as kept, read whole, or null when they cannot be: none
 * only for Redis's own null (no field) or the empty string; otherwise a
 * string of a JSON list each of whose entries is a task parseTasks keeps
 * (an entry it would drop, a repeated id or more than MAX_PERSON_TASKS make
 * the whole record unknown, so a list written back from it never erases
 * one). A list that is not a string, a number, an object or anything else
 * is unknown. The write path never stores "" (WRITE_PERSON_TASKS deletes the
 * field instead), so "" stays none only as what an empty list was.
 */
function keptTasks(raw: unknown): PersonTask[] | null {
  if (raw === null || raw === "") return [];
  if (typeof raw !== "string") return null;
  const value = json(raw);
  if (!Array.isArray(value)) return null;
  const tasks = parseTasks(value);
  return tasks.length === value.length ? tasks : null;
}

/** keptTasks, or TasksUnreadable: what every reader and change of tasks reads them through. */
function tasksOf(raw: unknown): PersonTask[] {
  const tasks = keptTasks(raw);
  if (!tasks) throw new TasksUnreadable();
  return tasks;
}

/**
 * One person's tasks, open and done, in the order they were written (639
 * [GL7](6)). Throws TasksUnreadable when the reply or what is kept cannot be
 * read whole: never "no tasks" from a reply it could not read.
 */
export async function readPersonTasks(statsId: string | null, person: string): Promise<PersonTask[]> {
  if (!statsId || !PERSON.test(person) || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["HGET", tasksKey(statsId), person]]), 1);
  if (!replies) throw new TasksUnreadable("a person's tasks reply");
  return tasksOf(replies[0]);
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

/**
 * Everyone's tasks, by person: what the agenda groups (lib/person-tasks.ts,
 * tasksDue) and what the store's count is made from. At most
 * MAX_STORE_TASKS. Throws TasksUnreadable when the reply is missing or of
 * another shape, or when any one person's tasks cannot be read whole: an
 * unreadable person is never counted as no tasks, so the agenda never says
 * nothing is due and the count is never made short of the cap.
 */
export async function readAllTasks(statsId: string | null): Promise<DueTask[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["HGETALL", tasksKey(statsId)]]), 1);
  if (!replies) throw new TasksUnreadable("the store's tasks reply");
  const raw = replies[0];
  const pairs: [string, unknown][] = [];
  if (Array.isArray(raw)) {
    if (raw.length % 2 !== 0) throw new TasksUnreadable("the store's tasks");
    for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]), raw[i + 1]]);
  } else if (raw && typeof raw === "object") pairs.push(...Object.entries(raw as Record<string, unknown>));
  else throw new TasksUnreadable("the store's tasks");
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
 * a change that cannot take it within TASKS_LOCK_WAIT_MS throws
 * LockBusyError, with nothing written or counted.
 */
export async function changePersonTasks(
  statsId: string,
  person: string,
  room: DataStore,
  change: (tasks: PersonTask[]) => TaskResult,
  pay: (units: number) => Promise<{ ok: true } | { ok: false; reason: string; message: string }> = async () => ({ ok: false, reason: "used", message: "" }),
): Promise<TaskResult> {
  if (!PERSON.test(person)) return { ok: false, error: "unknown" };
  const first = await withLock(tasksLockKey(statsId), TASKS_LOCK_SECONDS, TASKS_LOCK_WAIT_MS, (held) => changeOnce(statsId, person, room, change, 0, held));
  if ("result" in first) return first.result;
  // A recount: one at a time for the store, so two changes never both pay.
  // Its first pass looks again, and pays nothing when the one before made it.
  return withLock(recountLockKey(statsId), RECOUNT_LOCK_SECONDS, RECOUNT_WAIT_MS, async (recount) => {
    let paid = 0;
    // At most three passes: the second after paying, the third only when
    // more people were added meanwhile than were paid for. The last one
    // never pays: nothing would read after it.
    for (let pass = 0; pass < RECOUNT_PASSES; pass += 1) {
      const outcome = await withLock(tasksLockKey(statsId), TASKS_LOCK_SECONDS, TASKS_LOCK_WAIT_MS, (held) => changeOnce(statsId, person, room, change, paid, held));
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
async function changeOnce(statsId: string, person: string, room: DataStore, change: (tasks: PersonTask[]) => TaskResult, paid: number, held: Held): Promise<{ result: TaskResult } | { units: number }> {
  // A change that waited while the store was deleted writes nothing back:
  // its tasks are gone with it (forgetCrm). One EXISTS of the store's id
  // key; a store whose id is not of today's form (none is made any more)
  // relies on forgetCrm's second deletion under this lock instead.
  if (room.sid && STORE_ID_PATTERN.test(room.sid) && !(await storeIdExists(room.sid))) return { result: { ok: false, error: "unknown" } };
  const replies = repliesFor(await redisPipeline([["HGET", tasksKey(statsId), person], ["HGET", tasksKey(statsId), TASK_COUNT_FIELD], ["HLEN", tasksKey(statsId)]]), 3);
  if (!replies) throw new TasksUnreadable("a person's tasks reply");
  const [before, kept, fields] = replies;
  // Read whole or not at all (TasksUnreadable): a list built from tasks it
  // could not read, or from some of them, is never written over what is kept.
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
  // A lock that ran out meanwhile (a stalled request) may have let another
  // change in: what was read may be stale, so nothing is counted or written.
  if (!(await holdLock(held))) throw new LockBusyError();
  // Room is taken before a write that grows, and given back only after a
  // write that shrinks is confirmed: one that may not have landed keeps it.
  if (grown > 0) await needData(room, [{ slot: TASKS_SLOT, bytes: grown }]);
  let written: unknown;
  try {
    const response = await redisPipeline([["EVAL", WRITE_PERSON_TASKS, 1, tasksKey(statsId), person, typeof before === "string" ? before : "", value, added, start, TASK_COUNT_FIELD]]);
    if (!Array.isArray(response) || response.length !== 1 || (response[0] !== 1 && response[0] !== 2 && response[0] !== -1)) throw new CrmValueWriteUnconfirmed();
    written = response[0];
  } catch {
    throw new CrmValueWriteUnconfirmed();
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
