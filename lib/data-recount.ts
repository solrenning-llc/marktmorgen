import { isPathBoardSharedKey } from "@/lib/path-board";
/**
 * The one-time count of what every store already keeps in the database
 * (added 18 October 2026), run before paid plans open.
 *
 * Each store's data room (lib/store-data.ts) counts what is written from the
 * day it was made: products, pages and posts as they are saved, what an
 * order leaves as it is written (lib/order-data.ts). What a store wrote
 * before that day sits outside the room until it is next written or moved,
 * so its room looks emptier than it is (docs/funded-exposure-review.md). This
 * job measures it once.
 *
 * It walks the whole database a page at a time and, for every key of a
 * family the room counts (lib/data-families.ts), finds the store it belongs
 * to by the ids in its name (or, for a link kept under a token, in its
 * value), and measures it the way an order's write is charged: its name and
 * ORDER_KEY_BYTES, each field, member or item with ORDER_ENTRY_BYTES (a
 * board's ORDER_BOARD_ENTRY_BYTES and its score), a quarter more, in steps.
 * Once every page is read, each store's room gets a slot, "legacy", set to
 * what was measured beyond what the room already counts: never less than
 * nothing, so the room ends at least as full as what was measured, and never
 * emptier than it was.
 *
 *   nl:recount:state   hash: phase (ids, scan, apply, done), cursor, version, started, finished,
 *                      again (counts of a store that could not be confirmed since, lib/store-data.ts)
 *   nl:recount:ids     hash: an id a store's keys are named by -> the store; "*" when two share it
 *   nl:recount:sum     hash: a store -> what was measured of its keys
 *
 * Bounded per run (a deadline, and RECOUNT_PAGES pages of the database at the
 * most), so a large database is walked over several runs. Resumable: where a
 * run stopped is written with what it measured, in one script (RECOUNT_PAGE),
 * so a run that dies part way leaves nothing half-added and the next run
 * reads that page again. Idempotent: a store's slot is set, never added to,
 * so applying the same measure twice comes to the same room, and once done
 * the job does nothing until RECOUNT_VERSION changes, or until a count of a
 * store's data could not be confirmed (noteData, giveData): that asks for
 * every store to be counted again ("again" above), and the next run once
 * this one is done starts over, so a record written and not counted is in
 * its room after it.
 *
 * What it leaves out, said so: a key whose name and value carry no id of a
 * store (a mark under a payment's id, an address's library across stores) is
 * not anyone's room; those families are kept small by their own bounds
 * (tests/store-data-registry.ts). The job's own three keys are the
 * company's, and are deleted when it is done.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countedInRoom } from "@/lib/data-families";
import { ORDER_BOARD_ENTRY_BYTES, ORDER_ENTRY_BYTES, ORDER_KEY_BYTES } from "@/lib/order-data";
import { RECOUNT_AGAIN_FIELD, RECOUNT_STATE_KEY, dataKey, noteData } from "@/lib/store-data";
import { DATA_STEP_BYTES } from "@/lib/store-data-rules";
import { readAllListings } from "@/lib/catalog";
import { readFlows } from "@/lib/flows";
import { type Store, storeForEmail, storeRef, storesAfter } from "@/lib/store";

/** Changed to count every store again from the start. */
export const RECOUNT_VERSION = "2026-10-18";
/**
 * Runs of the count a UTC day at the most: one an hour (vercel.json, /api/cron/recount, "35 * * * *"), one at a
 * time under nl:recount:lock (app/api/cron/recount/route.ts). A count asked again (lib/store-data.ts) starts only
 * once the one running is done, however many asks there were, so it adds no run: its worst month is these runs,
 * every one of them working (NOT_A_COST.RECOUNT_RUNS_PER_DAY in tests/plan-cost-registry.ts, a company cost).
 */
export const RECOUNT_RUNS_PER_DAY = 24;
/** The most pages of the database one run reads. */
export const RECOUNT_PAGES = 40;
/** Keys asked for in one page of the database. */
export const RECOUNT_PAGE_KEYS = 500;
/** The slot of a store's room the count is kept in. */
export const LEGACY_SLOT = "legacy";

/** Kept with lib/store-data.ts, which asks for a count again under it. */
export const STATE_KEY = RECOUNT_STATE_KEY;
export const IDS_KEY = "nl:recount:ids";
export const SUM_KEY = "nl:recount:sum";

/**
 * KEYS[1] the job's state, KEYS[2] what each store measured. ARGV[1] the
 * cursor this page was read from, ARGV[2] the cursor after it, then (store,
 * bytes) two at a time. Adds the page's bytes and moves the cursor on only
 * if the state is still at the cursor the page was read from: answers 1 when
 * it was, 0 when another run moved it first (nothing added), -1 for what it
 * cannot read.
 */
export const RECOUNT_PAGE = `-- marktmorgen:recount-page:v1
if (#ARGV - 2) % 2 ~= 0 then return -1 end
local at = redis.call('HGET', KEYS[1], 'cursor')
if redis.call('HGET', KEYS[1], 'phase') ~= 'scan' or at ~= ARGV[1] then return 0 end
for i = 3, #ARGV, 2 do
  local n = tonumber(ARGV[i + 1])
  if not n or n < 0 or n ~= math.floor(n) then return -1 end
end
for i = 3, #ARGV, 2 do redis.call('HINCRBY', KEYS[2], ARGV[i], ARGV[i + 1]) end
redis.call('HSET', KEYS[1], 'cursor', ARGV[2])
if ARGV[2] == '0' then redis.call('HSET', KEYS[1], 'phase', 'apply', 'cursor', '0') end
return 1`;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const steps = (raw: number) => Math.ceil((raw * 5) / 4 / DATA_STEP_BYTES) * DATA_STEP_BYTES;

/** Ids a store's keys may be named by: every id-like word in its record, its products, and its sequences. */
export function idsIn(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    for (const word of text.split(/[^A-Za-z0-9_-]+/)) {
      // Long enough not to be a word, and with a digit or all hex: an id, a token, a hash.
      if (word.length >= 12 && word.length <= 80 && (/\d/.test(word) || /^[0-9a-f]{16,}$/.test(word))) out.add(word);
    }
  }
  return [...out];
}

/** `again`: the asks to count again (none when the field is absent), or null when it holds anything but a whole number. */
type State = { phase: string; cursor: string; version: string; again: number | null };

async function readState(): Promise<State> {
  const [raw] = await redisPipeline([["HMGET", STATE_KEY, "phase", "cursor", "version", RECOUNT_AGAIN_FIELD]]);
  const [phase, cursor, version] = Array.isArray(raw) ? raw.slice(0, 3).map((v) => (typeof v === "string" ? v : "")) : ["", "", ""];
  const asked: unknown = Array.isArray(raw) ? raw[3] : undefined;
  const again = asked === null || asked === undefined ? 0 : typeof asked === "string" && /^(0|[1-9][0-9]*)$/.test(asked) && Number.isSafeInteger(Number(asked)) ? Number(asked) : null;
  return { phase, cursor: cursor || "0", version, again };
}

export type RecountReport = { phase: string; stores: number; pages: number; measured: number; applied: number; done: boolean };

/** What one key weighs, measured the way an order's write is charged (lib/order-data.ts). Null when it is gone. */
export async function measureKey(key: string): Promise<number | null> {
  const [rawType] = await redisPipeline([["TYPE", key]]);
  const type = typeof rawType === "string" ? rawType : String((rawType as { ok?: string } | null)?.ok ?? "none");
  let raw = bytes(key) + ORDER_KEY_BYTES;
  const page = async (command: string, each: (flat: string[]) => number) => {
    let cursor = "0";
    for (let i = 0; i < 10_000; i += 1) {
      const [reply] = await redisPipeline([[command, key, cursor, "COUNT", 1000]]);
      if (!Array.isArray(reply) || reply.length < 2) return;
      cursor = String(reply[0]);
      raw += each(Array.isArray(reply[1]) ? (reply[1] as unknown[]).map(String) : []);
      if (cursor === "0") return;
    }
  };
  if (type === "none") return null;
  if (type === "string") {
    const [len] = await redisPipeline([["STRLEN", key]]);
    raw += Number(len) || 0;
  } else if (type === "hash") {
    await page("HSCAN", (flat) => flat.reduce((sum, piece, i) => sum + bytes(piece) + (i % 2 === 1 ? ORDER_ENTRY_BYTES : 0), 0));
  } else if (type === "set") {
    await page("SSCAN", (flat) => flat.reduce((sum, m) => sum + bytes(m) + ORDER_ENTRY_BYTES, 0));
  } else if (type === "zset") {
    await page("ZSCAN", (flat) => flat.reduce((sum, piece, i) => sum + (i % 2 === 0 ? bytes(piece) + 8 + ORDER_BOARD_ENTRY_BYTES : 0), 0));
  } else if (type === "list") {
    for (let at = 0; at < 1_000_000; at += 1000) {
      const [items] = await redisPipeline([["LRANGE", key, at, at + 999]]);
      const list = Array.isArray(items) ? items.map(String) : [];
      raw += list.reduce((sum, v) => sum + bytes(v) + ORDER_ENTRY_BYTES, 0);
      if (list.length < 1000) break;
    }
  } else {
    // A kind no family here makes: counted at its name, and at what a dump of it weighs.
    const [len] = await redisPipeline([["MEMORY", "USAGE", key]]).catch(() => [0]);
    raw += Number(len) || 0;
  }
  return steps(raw);
}

/** The ids each store's keys are named by, a page of stores at a time. Answers the cursor to go on from, "0" when every store is read. */
async function noteIds(cursor: string): Promise<{ next: string; stores: number }> {
  const { stores, next } = await storesAfter(cursor);
  for (const store of stores) {
    const ref = storeRef(store);
    const listings = await readAllListings(store).catch(() => []);
    const flows = store.listId ? await readFlows(store.listId).catch(() => []) : [];
    const ids = idsIn(JSON.stringify(store), JSON.stringify(listings), JSON.stringify(flows));
    if (!ids.length) continue;
    const [held] = await redisPipeline([["HMGET", IDS_KEY, ...ids]]);
    const writes: (string | number)[] = [];
    ids.forEach((id, i) => {
      const was = Array.isArray(held) ? held[i] : null;
      // An id two stores share names neither: what it names is nobody's to count.
      writes.push(id, typeof was === "string" && was !== ref ? "*" : ref);
    });
    await redisPipeline([["HSET", IDS_KEY, ...writes], ["EXPIRE", IDS_KEY, 30 * 86_400]]);
  }
  return { next, stores: stores.length };
}

/** Whose key this is: the store an id in its name (or, for a link under a token, in its value) belongs to. */
async function ownersOf(keys: string[]): Promise<Map<string, string>> {
  const segments = new Map<string, string[]>();
  for (const key of keys) segments.set(key, idsIn(key.replace(/:/g, " ")));
  const all = [...new Set([...segments.values()].flat())];
  const found = new Map<string, string>();
  if (all.length) {
    const [refs] = await redisPipeline([["HMGET", IDS_KEY, ...all]]);
    all.forEach((id, i) => {
      const ref = Array.isArray(refs) ? refs[i] : null;
      if (typeof ref === "string" && ref && ref !== "*") found.set(id, ref);
    });
  }
  const out = new Map<string, string>();
  const unnamed: string[] = [];
  for (const key of keys) {
    const ref = (segments.get(key) ?? []).map((id) => found.get(id)).find(Boolean);
    if (ref) out.set(key, ref);
    else unnamed.push(key);
  }
  // A link kept under a token names its store in what it holds.
  for (const key of unnamed) {
    const [type] = await redisPipeline([["TYPE", key]]);
    if (String(typeof type === "string" ? type : (type as { ok?: string } | null)?.ok) !== "string") continue;
    const [value] = await redisPipeline([["GET", key]]);
    if (typeof value !== "string") continue;
    const ids = idsIn(value);
    if (!ids.length) continue;
    const [refs] = await redisPipeline([["HMGET", IDS_KEY, ...ids]]);
    const ref = (Array.isArray(refs) ? refs : []).find((r): r is string => typeof r === "string" && r !== "" && r !== "*");
    if (ref) out.set(key, ref);
  }
  return out;
}

/** Sets each measured store's "legacy" slot, a page of stores at a time; true once every one is set. */
async function applySums(deadline: number): Promise<{ applied: number; done: boolean }> {
  let applied = 0;
  for (let round = 0; round < 1_000; round += 1) {
    if (Date.now() > deadline) return { applied, done: false };
    const [reply] = await redisPipeline([["HSCAN", SUM_KEY, "0", "COUNT", 100]]);
    const flat = Array.isArray(reply) && Array.isArray(reply[1]) ? (reply[1] as unknown[]).map(String) : [];
    if (!flat.length) return { applied, done: true };
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const ref = flat[i];
      const measured = Number(flat[i + 1]) || 0;
      const store: Store | null = await storeForEmail(ref).catch(() => null);
      const key = store ? dataKey(store) : null;
      if (store && key) {
        const [room] = await redisPipeline([["HMGET", key, "#", LEGACY_SLOT]]);
        const [total, legacy] = Array.isArray(room) ? room.map((v) => Number(v ?? 0) || 0) : [0, 0];
        // What the room counts without this slot, its own field included.
        const counted = Math.max(0, total - legacy - (legacy > 0 ? 64 : 0));
        await noteData(store, [{ slot: LEGACY_SLOT, bytes: Math.max(0, measured - counted), set: true }]);
        applied += 1;
      }
      await redisPipeline([["HDEL", SUM_KEY, ref]]);
    }
  }
  return { applied, done: false };
}

/**
 * One run of the count, until `deadline` (ms): reads the stores' ids, then
 * the database a page at a time, then sets each store's slot. Answers what
 * it did; `done` once every store is counted.
 */
export async function recountStep(deadline: number, now = Date.now()): Promise<RecountReport> {
  const report: RecountReport = { phase: "", stores: 0, pages: 0, measured: 0, applied: 0, done: false };
  if (!isRedisConfigured()) return report;
  let state = await readState();
  // Asked again (lib/store-data.ts): once the count is done, never in the middle of one, which might have read the store's keys before.
  const asked = state.phase === "done" && state.again !== 0;
  if (state.version !== RECOUNT_VERSION || asked) {
    // What was read is taken off, not the field set to none: an ask written meanwhile stays for the run after.
    // One that cannot be read is set back to none, as no ask could have been added to it (HINCRBY refuses it).
    const spent: (string | number)[][] = state.again === null ? [["HSET", STATE_KEY, RECOUNT_AGAIN_FIELD, 0]] : state.again > 0 ? [["HINCRBY", STATE_KEY, RECOUNT_AGAIN_FIELD, -state.again]] : [];
    await redisPipeline([["DEL", IDS_KEY, SUM_KEY], ["HSET", STATE_KEY, "phase", "ids", "cursor", "0", "version", RECOUNT_VERSION, "started", now], ["HDEL", STATE_KEY, "finished"], ...spent]);
    state = { phase: "ids", cursor: "0", version: RECOUNT_VERSION, again: 0 };
  }
  report.phase = state.phase;
  if (state.phase === "done") return { ...report, done: true };

  while (state.phase === "ids" && Date.now() < deadline) {
    const { next, stores } = await noteIds(state.cursor);
    report.stores += stores;
    await redisPipeline([["HSET", STATE_KEY, "cursor", next, ...(next === "0" ? ["phase", "scan"] : [])]]);
    state = { ...state, cursor: next, phase: next === "0" ? "scan" : "ids" };
  }

  while (state.phase === "scan" && Date.now() < deadline && report.pages < RECOUNT_PAGES) {
    const [reply] = await redisPipeline([["SCAN", state.cursor, "MATCH", "nl:*", "COUNT", RECOUNT_PAGE_KEYS]]);
    if (!Array.isArray(reply) || reply.length < 2) break;
    const next = String(reply[0]);
    const keys = (Array.isArray(reply[1]) ? (reply[1] as unknown[]).map(String) : []).filter((key) => !isPathBoardSharedKey(key) && countedInRoom(key) && !key.startsWith("nl:data:") && !key.startsWith("nl:recount:"));
    const owners = await ownersOf(keys);
    const sums = new Map<string, number>();
    for (const [key, ref] of owners) {
      const weight = await measureKey(key);
      if (weight === null) continue;
      sums.set(ref, (sums.get(ref) ?? 0) + weight);
      report.measured += 1;
    }
    const [moved] = await redisPipeline([["EVAL", RECOUNT_PAGE, 2, STATE_KEY, SUM_KEY, state.cursor, next, ...[...sums].flatMap(([ref, n]) => [ref, n])]]);
    if (Number(moved) !== 1) break;
    report.pages += 1;
    state = { ...state, cursor: next, phase: next === "0" ? "apply" : "scan" };
  }

  if (state.phase === "apply" && Date.now() < deadline) {
    const { applied, done } = await applySums(deadline);
    report.applied += applied;
    if (done) {
      await redisPipeline([["HSET", STATE_KEY, "phase", "done", "finished", Date.now()], ["DEL", IDS_KEY, SUM_KEY]]);
      state = { ...state, phase: "done" };
    }
  }
  return { ...report, phase: state.phase, done: state.phase === "done" };
}
