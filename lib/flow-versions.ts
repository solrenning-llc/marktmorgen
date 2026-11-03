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
 * The versions take room in the store's data room (slot wv:<flowId>), set to
 * what the list holds after each push; one that does not fit is not kept,
 * and the save goes ahead without it: a full room never stops a creator
 * saving their workflow.
 */
import type { Flow } from "@/lib/flows";
import { parseFlowList } from "@/lib/flow-list";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { DataRoomError, type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

/** How many earlier versions of one workflow are kept. */
export const MAX_FLOW_VERSIONS = 10;

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
 * Keeps `before` as the newest earlier version of its workflow, when `after`
 * changes what it does. Best effort by design: a room that is full or cannot
 * be read keeps no version, and the save it belongs to goes on.
 */
export async function keepFlowVersion(store: DataStore, listId: string, before: Flow, after: Flow, now = Date.now()): Promise<boolean> {
  if (!isRedisConfigured() || !changesWhatItDoes(before, after)) return false;
  const key = versionsKey(listId, before.id);
  const entry = `${now}\n${JSON.stringify(before)}`;
  try {
    const [held] = await redisPipeline([["LRANGE", key, 0, MAX_FLOW_VERSIONS - 2]]);
    const kept = [entry, ...(Array.isArray(held) ? held.filter((x): x is string => typeof x === "string") : [])];
    await needData(store, [{ slot: SLOT(before.id), bytes: dataBytes(kept, kept.length), set: true }]);
    await redisPipeline([["LPUSH", key, entry], ["LTRIM", key, 0, MAX_FLOW_VERSIONS - 1]]);
    return true;
  } catch (error) {
    if (!(error instanceof DataRoomError)) console.error("keeping a workflow's earlier version failed", error);
    return false;
  }
}

export type FlowVersion = { at: number; flow: Flow };

/** A workflow's earlier versions, newest first. One that cannot be read is left out, never shown half. */
export async function readFlowVersions(listId: string | null, flowId: string): Promise<FlowVersion[]> {
  if (!listId || !isRedisConfigured()) return [];
  const [list] = await redisPipeline([["LRANGE", versionsKey(listId, flowId), 0, MAX_FLOW_VERSIONS - 1]]);
  if (!Array.isArray(list)) return [];
  const out: FlowVersion[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const cut = entry.indexOf("\n");
    const at = Number(entry.slice(0, cut));
    if (cut < 1 || !Number.isSafeInteger(at)) continue;
    try {
      const [flow] = parseFlowList([JSON.parse(entry.slice(cut + 1))]) ?? [];
      if (flow && flow.id === flowId) out.push({ at, flow });
    } catch {
      // Left out.
    }
  }
  return out;
}

/** Forgets the earlier versions of a workflow that is gone, and gives back their room. */
export async function dropFlowVersions(store: DataStore, listId: string, flowId: string): Promise<void> {
  if (!isRedisConfigured()) return;
  await redisPipeline([["DEL", versionsKey(listId, flowId)]]);
  await giveData(store, [{ slot: SLOT(flowId), bytes: 0, set: true }]);
}
