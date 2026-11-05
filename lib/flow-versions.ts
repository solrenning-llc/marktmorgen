/**
 * A workflow's earlier versions, and putting one back (639 [GL7](19); the
 * owner's HighLevel audit). The sales page already keeps what it was before
 * each save (lib/sales-page-store.ts); a workflow now does the same: every
 * save that changes what it does keeps the version before it, the newest
 * MAX_FLOW_VERSIONS of them, and the studio can put one back.
 *
 *   nl:wf:ver:<listId>:<flowId> -> list: the workflow before each of its last
 *                                  saves, newest first, "<ms>\n<json>"
 *
 * What is kept is the workflow only: its trigger, its steps and their emails,
 * its goal. Never who is in it, never a run. Switching it on or off is not a
 * change of what it does and keeps no version.
 *
 * Putting one back is an ordinary save (lib/flows.ts saveFlow) with that
 * version's content: it is checked whole again against the store as it is
 * now (a product, a form or a stage it named may be gone, and then it is
 * refused with the save's own reason), it keeps the workflow's on or off,
 * and it keeps the version it replaces, so putting one back can itself be
 * undone.
 *
 * The versions take room in the store's data room (slot wv:<flowId>), moved
 * by what each push or deletion changes, never set to a total (Codex G2 on
 * #1927: a total read after a refused push cut a newer list's room); one that
 * does not fit is not kept,
 * and the save goes ahead without it: a full room never stops a creator
 * saving their workflow. Putting a version back is the exception: it keeps
 * the version it replaces first, or puts nothing back (lib/flows.ts).
 *
 * Only Redis's exact answers count (Codex G2 on #1927): a list that cannot be
 * read whole keeps no version and is never an empty history; a version is
 * pushed only onto the list it was counted from (KEEP_FLOW_VERSION); room is
 * given back only once the list is confirmed deleted.
 */
import type { Flow } from "@/lib/flows";
import { parseFlowList } from "@/lib/flow-list";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { DataRoomError, type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes, dataBytesOfLength } from "@/lib/store-data-rules";
import { MAX_FLOW_VERSIONS } from "@/lib/flow-versions-rules";

export { MAX_FLOW_VERSIONS };

const versionsKey = (listId: string, flowId: string) => `nl:wf:ver:${listId}:${flowId}`;
const SLOT = (flowId: string) => `wv:${flowId}`;

/** What a workflow does, without whether it is on: two saves that differ only in that keep no version. */
function whatItDoes(flow: Flow): string {
  const { active: _active, ...rest } = flow;
  void _active;
  return JSON.stringify(rest);
}

/** Whether saving `after` over `before` changes what the workflow does. */
export function changesWhatItDoes(before: Flow, after: Flow): boolean {
  return whatItDoes(before) !== whatItDoes(after);
}

/**
 * Pushes a version only while the list is as it was counted from: as long
 * (up to ARGV[4]) and with the same newest entry. 1 when kept, 0 when it
 * changed in between. Modelled by lib/redis-memory.ts.
 */
export const KEEP_FLOW_VERSION = `-- marktmorgen:flow-version-keep:v1
local n = redis.call('LLEN', KEYS[1])
if n > tonumber(ARGV[4]) then n = tonumber(ARGV[4]) end
if n ~= tonumber(ARGV[1]) then return 0 end
if n > 0 and redis.call('LINDEX', KEYS[1], 0) ~= ARGV[2] then return 0 end
redis.call('LPUSH', KEYS[1], ARGV[3])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[4]) - 1)
return 1`;

/** A workflow's kept list, on Redis's exact answer only: null when it cannot be known. */
async function heldVersions(key: string): Promise<string[] | null> {
  const answer: unknown = await redisPipeline([["LRANGE", key, 0, MAX_FLOW_VERSIONS - 1]]);
  if (!Array.isArray(answer) || answer.length !== 1 || !Array.isArray(answer[0]) || answer[0].some((x) => typeof x !== "string")) return null;
  return answer[0] as string[];
}

/**
 * Keeps `before` as the newest earlier version of its workflow, when `after`
 * changes what it does: true once it is kept (or already the newest kept).
 * Best effort for an ordinary save: a room that is full, or a list that
 * cannot be read whole or changed meanwhile, keeps no version, and the save
 * goes on. Its room is counted for the list it will make before it is pushed.
 */
export async function keepFlowVersion(store: DataStore, listId: string, before: Flow, after: Flow, now = Date.now()): Promise<boolean> {
  if (!isRedisConfigured() || !changesWhatItDoes(before, after)) return false;
  const key = versionsKey(listId, before.id);
  const body = JSON.stringify(before);
  const entry = `${now}\n${body}`;
  try {
    const held = await heldVersions(key);
    if (!held) return false;
    // Tried again after the workflows changed under a save (lib/flows.ts): kept once, not twice.
    if (held.length && held[0].slice(held[0].indexOf("\n") + 1) === body) return true;
    const kept = [entry, ...held].slice(0, MAX_FLOW_VERSIONS);
    // The push lands only on the list it was counted from (KEEP_FLOW_VERSION), so what it changes is known here: the
    // room moves by that, taken first when it grows, and only this push's own taking goes back when it is refused.
    const grown = dataBytes(kept, kept.length) - dataBytes(held, held.length);
    if (grown > 0) await needData(store, [{ slot: SLOT(before.id), bytes: grown }]);
    const reply: unknown = await redisPipeline([["EVAL", KEEP_FLOW_VERSION, 1, key, held.length, held[0] ?? "", entry, MAX_FLOW_VERSIONS]]);
    const answer = Array.isArray(reply) && reply.length === 1 ? reply[0] : undefined;
    if (answer === 1) {
      if (grown < 0) await giveData(store, [{ slot: SLOT(before.id), bytes: -grown }]);
      return true;
    }
    // Changed meanwhile: nothing was pushed, and the room the newer push counted for itself is never touched.
    if (answer === 0 && grown > 0) await giveData(store, [{ slot: SLOT(before.id), bytes: grown }]);
    // Any other answer: the push may have landed, and what it took stays counted.
    return false;
  } catch (error) {
    if (!(error instanceof DataRoomError)) console.error("keeping a workflow's earlier version failed", error);
    return false;
  }
}

/** A workflow's earlier versions could not be read whole: unknown, never "none yet". */
export class FlowVersionsUnavailable extends Error {
  constructor() {
    super("A workflow's earlier versions could not be read");
    this.name = "FlowVersionsUnavailable";
  }
}

export type FlowVersion = { at: number; flow: Flow };

/**
 * A workflow's earlier versions, newest first, on Redis's exact answer only:
 * an empty list is none yet; a list that cannot be read whole, or holds an
 * entry that is not a version of this workflow, throws FlowVersionsUnavailable,
 * never a shorter or empty history (Codex G2 on #1927).
 */
export async function readFlowVersions(listId: string | null, flowId: string): Promise<FlowVersion[]> {
  if (!listId) return [];
  if (!isRedisConfigured()) throw new FlowVersionsUnavailable();
  const list = await heldVersions(versionsKey(listId, flowId));
  if (!list) throw new FlowVersionsUnavailable();
  return list.map((entry) => {
    const cut = entry.indexOf("\n");
    const at = Number(entry.slice(0, cut));
    if (cut < 1 || !Number.isSafeInteger(at) || at <= 0) throw new FlowVersionsUnavailable();
    let flow: Flow | undefined;
    try {
      [flow] = parseFlowList([JSON.parse(entry.slice(cut + 1))]) ?? [];
    } catch {
      throw new FlowVersionsUnavailable();
    }
    if (!flow || flow.id !== flowId) throw new FlowVersionsUnavailable();
    return { at, flow };
  });
}

/**
 * Deletes a workflow's earlier versions and answers, from the same step,
 * {records deleted (0 or 1), how many versions it held, their total length}:
 * the room given back is exactly what it removed. Modelled by lib/redis-memory.ts.
 */
export const DROP_FLOW_VERSIONS = `-- marktmorgen:flow-version-drop:v1
local items = redis.call('LRANGE', KEYS[1], 0, -1)
local length = 0
for _, item in ipairs(items) do length = length + string.len(item) end
return {redis.call('DEL', KEYS[1]), #items, length}`;

/**
 * Forgets the earlier versions of a workflow that is gone, and gives back
 * their room only once Redis confirms the list is deleted, by what it removed
 * as measured in the same step (never a total set later, which could undo a
 * newer push's room): an answer that is not its own keeps the room counted,
 * and throws.
 */
export async function dropFlowVersions(store: DataStore | null, listId: string, flowId: string): Promise<void> {
  if (!isRedisConfigured()) return;
  const reply: unknown = await redisPipeline([["EVAL", DROP_FLOW_VERSIONS, 1, versionsKey(listId, flowId)]]);
  const answer = Array.isArray(reply) && reply.length === 1 ? reply[0] : undefined;
  const whole = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!Array.isArray(answer) || answer.length !== 3 || (answer[0] !== 0 && answer[0] !== 1) || !whole(answer[1]) || !whole(answer[2]) || (answer[0] === 0 && (answer[1] !== 0 || answer[2] !== 0))) {
    throw new Error("a workflow's earlier versions could not be confirmed deleted");
  }
  const [deleted, count, length] = answer as [number, number, number];
  if (store && deleted === 1) await giveData(store, [{ slot: SLOT(flowId), bytes: dataBytesOfLength(length, count) }]);
}
