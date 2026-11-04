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
 *   nl:crm:tasks:<statsId>           hash  person -> their tasks (JSON, lib/person-tasks.ts), gone with the person
 *   nl:crm:tasklock:<statsId>        one change of the store's tasks, or of a person's value, at a time (lib/redis-lock.ts),
 *                                    ten seconds at the most
 *
 * A value is kept under the person's key, never the address (as a note
 * about them is), one hash a field, so the list's file reads each field once
 * however long the list is.
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { STORE_ID_PATTERN, storeIdExists } from "@/lib/store";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes, dataBytesOfLength, utf8Length } from "@/lib/store-data-rules";
import { LockBusyError, holdLock, withLock } from "@/lib/redis-lock";
import { type DueTask, MAX_STORE_TASKS, type PersonTask, type TaskResult, parseTasks } from "@/lib/person-tasks";
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
 * Setting a person's value takes it as well (setValue), and so does deleting
 * a person (forgetCrmPerson): a value set while its person is deleted is
 * always set first and deleted after, never left behind.
 */
const tasksLockKey = (statsId: string) => `nl:crm:tasklock:${statsId}`;
const TASKS_LOCK_SECONDS = 10;
/** How long a change waits for the one before it, before it is refused (LockBusyError). */
export const TASKS_LOCK_WAIT_MS = 2_000;
/** How long deleting a person waits for a change of their tasks, before it reports failure. */
const TASKS_FORGET_WAIT_MS = 5_000;
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
 * Sets one person's value of one field, or clears it with "", in one step on
 * the Redis side, and only while the store's people lock (tasksLockKey) is
 * still the caller's: 0, and nothing written, when it is not; {1, before}
 * with what it replaced, or {1} when there was nothing.
 */
export const SET_CRM_VALUE = `-- marktmorgen:crm-value-set:v1
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
local before = redis.call("HGET", KEYS[2], ARGV[2])
if ARGV[3] == "" then redis.call("HDEL", KEYS[2], ARGV[2]) else redis.call("HSET", KEYS[2], ARGV[2], ARGV[3]) end
if before then return {1, before} end
return {1}`;

/**
 * Sets one value for one person; "" clears it. False when it is not a value the field keeps.
 *
 * Under the store's people lock, which deleting a person takes too (forgetCrmPerson): a deletion that starts while a
 * value is being set waits for it and then deletes it, so a value set at the same time as its person's deletion never
 * outlives the deletion. The new value's whole room is taken first (DataRoomError, and nothing written, when it does
 * not fit); the write answers what it replaced, in the same step, and that room is given back after. So what is
 * counted is exactly what is kept, whatever ran before. LockBusyError, with nothing written, when the lock stays taken
 * past TASKS_LOCK_WAIT_MS or is lost before the write.
 */
export async function setValue(statsId: string, person: string, field: CrmField, raw: unknown, room: DataStore): Promise<boolean> {
  if (!PERSON.test(person)) return false;
  const value = fieldValue(field, raw);
  if (value === null) return false;
  const weight = (v: unknown) => (typeof v === "string" && v ? dataBytes([person, v], 1) : 0);
  await withLock(tasksLockKey(statsId), TASKS_LOCK_SECONDS, TASKS_LOCK_WAIT_MS, async (held) => {
    const charged = weight(value);
    if (charged > 0) await needData(room, [{ slot: VALUES_SLOT, bytes: charged }]);
    let answer: unknown;
    try {
      const response = await redisPipeline([["EVAL", SET_CRM_VALUE, 2, held.key, valuesKey(statsId, field.id), held.token, person, value]]);
      answer = Array.isArray(response) && response.length === 1 ? response[0] : undefined;
    } catch { throw new CrmValueWriteUnconfirmed(); }
    if (answer === 0) {
      // The lock ran out before the write (a stalled request): nothing was written, so the room taken goes back.
      if (charged > 0) await giveData(room, [{ slot: VALUES_SLOT, bytes: charged }]).catch(() => {});
      throw new LockBusyError();
    }
    // Any other answer may or may not have landed: the room taken stays counted, never less than what is kept.
    if (!Array.isArray(answer) || answer[0] !== 1 || answer.length > 2 || (answer.length === 2 && typeof answer[1] !== "string")) throw new CrmValueWriteUnconfirmed();
    const freed = weight(answer[1]);
    // The value replaced gives its room back; one that cannot be given back now stays counted (more, never less, than kept).
    if (freed > 0) await giveData(room, [{ slot: VALUES_SLOT, bytes: freed }]).catch(() => {});
  });
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
  // Each deal deleted on its own: what goes back to the store's data room is exactly what was removed.
  const dealReplies = theirs.length ? await redisPipeline(theirs.map((id) => ["HDEL", dealsKey(statsId), id])) : [];
  const dealsGone = theirs.filter((_, i) => dealReplies[i] === 1);
  let records = dealsGone.length;
  if (room && dealsGone.length) await giveData(room, dealsGone.map((id) => ({ slot: dealSlot(id), bytes: 0, set: true })));
  // Their values and their tasks (639 [GL7](6)) go under the store's people
  // lock, which setting a value and changing tasks take too: a value being set
  // when the deletion starts is set first and deleted here after, never left
  // behind, and a change of tasks read before the deletion cannot write them
  // back after it. Each value is taken out in one script that answers what it
  // deleted, so what goes back to the room is exactly what was removed. A lock
  // still taken after the wait throws (LockBusyError): the deletion fails and
  // says so, never skips them.
  records += await withLock(tasksLockKey(statsId), TASKS_LOCK_SECONDS, TASKS_FORGET_WAIT_MS, async () => {
    const replies = await redisPipeline([
      ...fields.map((f) => ["EVAL", TAKE_CRM_VALUE, 1, valuesKey(statsId, f.id), person]),
      ["HGET", tasksKey(statsId), person],
      ["HDEL", tasksKey(statsId), person],
    ]);
    let taken = 0;
    let valuesFreed = 0;
    fields.forEach((_, i) => {
      const value = replies[i];
      if (typeof value !== "string") return;
      taken += 1;
      if (value) valuesFreed += dataBytes([person, value], 1);
    });
    const [before, gone] = [replies[fields.length], replies[fields.length + 1]];
    const tasksFreed = gone === 1 ? taskWeight(person, before) : 0;
    if (room && (valuesFreed > 0 || tasksFreed > 0)) {
      await giveData(room, [
        ...(valuesFreed > 0 ? [{ slot: VALUES_SLOT, bytes: valuesFreed }] : []),
        ...(tasksFreed > 0 ? [{ slot: TASKS_SLOT, bytes: tasksFreed }] : []),
      ]);
    }
    return taken + (gone === 1 ? 1 : 0);
  });
  return records;
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
 * is refused ("store_full"). Room in the store's data room is taken before
 * writing (DataRoomError when it does not fit); a shorter list gives it back.
 * The read, the change, the room and the write happen under the store's
 * tasks lock, so each real change is kept and counted exactly once; a change
 * that cannot take it within TASKS_LOCK_WAIT_MS throws LockBusyError, with
 * nothing written or counted.
 */
export async function changePersonTasks(statsId: string, person: string, room: DataStore, change: (tasks: PersonTask[]) => TaskResult): Promise<TaskResult> {
  if (!PERSON.test(person)) return { ok: false, error: "unknown" };
  return withLock(tasksLockKey(statsId), TASKS_LOCK_SECONDS, TASKS_LOCK_WAIT_MS, async (held) => {
    // A change that waited while the store was deleted writes nothing back:
    // its tasks are gone with it (forgetCrm). One EXISTS of the store's id
    // key; a store whose id is not of today's form (none is made any more)
    // relies on forgetCrm's second deletion under this lock instead.
    if (room.sid && STORE_ID_PATTERN.test(room.sid) && !(await storeIdExists(room.sid))) return { ok: false, error: "unknown" };
    const [before] = await redisPipeline([["HGET", tasksKey(statsId), person]]);
    const tasks = tasksOf(before);
    const result = change(tasks);
    if (!result.ok) return result;
    if (result.tasks.length > tasks.length && (await readAllTasks(statsId)).length + result.tasks.length - tasks.length > MAX_STORE_TASKS) return { ok: false, error: "store_full" };
    const value = result.tasks.length ? JSON.stringify(result.tasks) : "";
    const grown = taskWeight(person, value) - taskWeight(person, before);
    // A lock that ran out meanwhile (a stalled request) may have let another
    // change in: what was read may be stale, so nothing is counted or written.
    if (!(await holdLock(held))) throw new LockBusyError();
    // Room is taken before a write that grows, and given back only after a
    // write that shrinks is confirmed: one that may not have landed keeps it.
    if (grown > 0) await needData(room, [{ slot: TASKS_SLOT, bytes: grown }]);
    try {
      const response = await redisPipeline([value ? ["HSET", tasksKey(statsId), person, value] : ["HDEL", tasksKey(statsId), person]]);
      if (!Array.isArray(response) || response.length !== 1 || (response[0] !== 0 && response[0] !== 1)) throw new CrmValueWriteUnconfirmed();
    } catch {
      throw new CrmValueWriteUnconfirmed();
    }
    if (grown < 0) await giveData(room, [{ slot: TASKS_SLOT, bytes: -grown }]);
    return result;
  });
}

/** How many deals the store keeps: what deleting a person reads (lib/person-erasure.ts). */
export async function dealCount(statsId: string | null): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["HLEN", dealsKey(statsId)]]);
  return Number(n) || 0;
}
