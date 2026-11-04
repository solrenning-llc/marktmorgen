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
 *
 * A value is kept under the person's key, never the address (as a note
 * about them is), one hash a field, so the list's file reads each field once
 * however long the list is.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
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
/** Somebody else changed the pipelines between this change's read and its write: nothing was written. */
export class CrmSchemaConflict extends Error {
  constructor() { super("CRM configuration changed meanwhile"); this.name = "CrmSchemaConflict"; }
}

const fieldsKey = (statsId: string) => `nl:crm:fields:${statsId}`;
const valuesKey = (statsId: string, field: string) => `nl:crm:v:${statsId}:${field}`;
const stagesKey = (statsId: string) => `nl:crm:stages:${statsId}`;
const dealsKey = (statsId: string) => `nl:crm:deals:${statsId}`;
const pipesKey = (statsId: string) => `nl:crm:pipes:${statsId}`;
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

/** Saves the fields; the answers kept for a field that is gone go with it. */
export async function writeFields(statsId: string, fields: CrmField[]): Promise<CrmField[]> {
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
export const SAVE_CRM_PIPELINES = `-- marktmorgen:crm-pipelines-save:v1
local current = redis.call("GET", KEYS[1])
if (current or "") ~= ARGV[1] then return -1 end
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
  if (Array.isArray(saved) && saved.length === 1 && saved[0] === -1) {
    // Nothing was written: the room goes back to what the saved record weighs.
    await giveData(room, [{ slot: PIPES_SLOT, bytes: snapshotRaw ? dataBytes([snapshotRaw], 1) : 0, set: true }]).catch(() => {});
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

/** Move only the exact snapshot reviewed; never resurrect a deleted opportunity. */
export const MOVE_CRM_DEAL = `-- marktmorgen:crm-deal-move:v1
local current = redis.call("HGET", KEYS[1], ARGV[1])
if not current then return 0 end
if current ~= ARGV[2] then return -1 end
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

export type OpportunityReviewData = { available: boolean; stages: Stage[]; deals: Deal[]; pipelines: Pipeline[] };

/** A complete link/contact review read; unknown storage never means no opportunities. */
export async function readOpportunityReview(statsId: string | null): Promise<OpportunityReviewData> {
  const unavailable: OpportunityReviewData = { available: false, stages: [], deals: [], pipelines: [] };
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
    const deals: Deal[] = [], seen = new Set<string>();
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
    }
    return { available: true, stages, deals: deals.sort((a, b) => b.updatedAt - a.updatedAt), pipelines: pipelines ?? [firstPipeline(stages)] };
  } catch { return unavailable; }
}

/** Capacity and save share one Redis operation, including alongside form conversions. */
export const SAVE_CRM_DEAL = `-- marktmorgen:crm-deal-save:v1
if redis.call("HEXISTS", KEYS[1], ARGV[1]) == 0 and redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return 1`;

/** Where a deal is counted in the store's data room (lib/store-data.ts): one slot a deal, at what it weighs. */
export const dealSlot = (id: string) => `dl:${id}`;
export const dealBytes = (deal: Deal) => dataBytes([deal.id, JSON.stringify(deal)], 1);

/**
 * Saves a deal. False when the store already has as many as it may and this
 * one is new. Its room in the store's data room is taken first: DataRoomError
 * when it does not fit, and nothing is written.
 */
export async function writeDeal(statsId: string, deal: Deal, room: DataStore): Promise<boolean> {
  let preflight: unknown;
  try {
    preflight = await redisPipeline([["HEXISTS", dealsKey(statsId), deal.id], ["HLEN", dealsKey(statsId)]]);
  } catch { throw new CrmDealReadUnavailable(); }
  if (!Array.isArray(preflight) || preflight.length !== 2 || (preflight[0] !== 0 && preflight[0] !== 1) || typeof preflight[1] !== "number" || !Number.isSafeInteger(preflight[1]) || preflight[1] < preflight[0]) throw new CrmDealReadUnavailable();
  if (preflight[0] === 0 && preflight[1] >= MAX_DEALS) return false;
  await needData(room, [{ slot: dealSlot(deal.id), bytes: dealBytes(deal), set: true }]);
  try {
    const saved = await redisPipeline([["EVAL", SAVE_CRM_DEAL, 1, dealsKey(statsId), deal.id, JSON.stringify(deal), MAX_DEALS]]);
    if (!Array.isArray(saved) || saved.length !== 1 || (saved[0] !== 0 && saved[0] !== 1)) throw new CrmDealWriteUnconfirmed();
    // Full after all: a new deal's room goes back.
    if (saved[0] === 0) await giveData(room, [{ slot: dealSlot(deal.id), bytes: 0, set: true }]);
    return saved[0] === 1;
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
  if (!Array.isArray(saved) || saved.length !== 1 || (saved[0] !== 1 && saved[0] !== 0 && saved[0] !== -1)) throw new CrmDealWriteUnconfirmed();
  if (saved[0] === 1) return "saved";
  // Nothing written: its room as the record still there weighs, or none when it is gone.
  await giveData(room, [{ slot: dealSlot(deal.id), bytes: saved[0] === -1 ? dataBytes([deal.id, before], 1) : 0, set: true }]);
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

/** Everything kept here for a store that is being deleted. */
export async function forgetCrm(statsId: string | null): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const fields = await readFields(statsId);
  await redisPipeline([["DEL", fieldsKey(statsId), stagesKey(statsId), pipesKey(statsId), dealsKey(statsId), ...fields.map((f) => valuesKey(statsId, f.id))]]);
}

/**
 * Deletes one person from the store's fields and deals (lib/person-erasure.ts):
 * every value kept under their key, and every deal with them, by the address
 * a deal names. Answers how many records went.
 */
export async function forgetCrmPerson(statsId: string | null, person: string, email: string): Promise<number> {
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
  const commands: (string | number)[][] = fields.map((f) => ["HDEL", valuesKey(statsId, f.id), person]);
  if (theirs.length) commands.push(["HDEL", dealsKey(statsId), ...theirs]);
  if (!commands.length) return 0;
  const replies = await redisPipeline(commands);
  return replies.reduce<number>((sum, n) => sum + (Number(n) || 0), 0);
}

/** How many deals the store keeps: what deleting a person reads (lib/person-erasure.ts). */
export async function dealCount(statsId: string | null): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["HLEN", dealsKey(statsId)]]);
  return Number(n) || 0;
}
