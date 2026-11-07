import { MAX_STEP_NEXT_ACTION, MAX_STEP_NEXT_DAYS } from "@/lib/flow-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Flow } from "@/lib/flows";
import { FLOW_TRIGGERS } from "@/lib/flow-rules";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === "string");
function condition(value: unknown): boolean {
  if (!record(value) || typeof value.if !== "string") return false;
  if (["has", "lacks", "started", "unstarted", "finished", "unfinished"].includes(value.if)) return strings(value, ["productId"]);
  if (value.if === "tag" || value.if === "untagged") return strings(value, ["tag"]);
  return ["buyer", "lead", "clicked", "unclicked", "half-a", "half-b"].includes(String(value.if));
}
function action(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.do === "tag" || value.do === "untag") return strings(value, ["tag"]);
  if (value.do === "start" || value.do === "stop") return strings(value, ["flowId"]);
  if (value.do === "field") return strings(value, ["field", "value"]);
  if (value.do === "deal") return strings(value, ["stage", "title"]);
  if (value.do === "note") return strings(value, ["text"]);
  if (value.do === "assign") return strings(value, ["assignee"]);
  if (value.do === "next") return strings(value, ["text"]) && (value.text as string).length <= MAX_STEP_NEXT_ACTION && Number.isSafeInteger(value.days) && (value.days as number) >= 0 && (value.days as number) <= MAX_STEP_NEXT_DAYS;
  return value.do === "webhook" || value.do === "notify" || value.do === "wait" || value.do === "rotate";
}
/** Structural validation only: business/reference problems remain editable diagnostics. */
export function parseFlowList(raw: unknown): Flow[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = new Set<string>();
  for (const flow of raw) {
    if (!record(flow) || !strings(flow, ["id", "name"]) || !flow.id || ids.has(flow.id as string)) return null;
    ids.add(flow.id as string);
    if (typeof flow.trigger !== "string" || !(FLOW_TRIGGERS as readonly string[]).includes(flow.trigger as string) || typeof flow.active !== "boolean") return null;
    if (flow.productId !== null && typeof flow.productId !== "string") return null;
    if (typeof flow.createdAt !== "number" || !Number.isFinite(flow.createdAt)) return null;
    if ((flow.tag !== undefined && typeof flow.tag !== "string") || (flow.formId !== undefined && typeof flow.formId !== "string") || (flow.formOutcome !== undefined && typeof flow.formOutcome !== "string")) return null;
    if (flow.goal !== undefined && (!record(flow.goal) || ("any" in flow.goal ? flow.goal.any !== true : "tag" in flow.goal ? typeof flow.goal.tag !== "string" : typeof flow.goal.productId !== "string"))) return null;
    if (!Array.isArray(flow.steps)) return null;
    const steps = new Set<string>();
    for (const step of flow.steps) {
      if (!record(step) || !strings(step, ["id", "subject", "body"]) || !step.id || steps.has(step.id as string)) return null;
      steps.add(step.id as string);
      if (typeof step.delayHours !== "number" || !Number.isFinite(step.delayHours)) return null;
      if (step.action !== undefined && !action(step.action)) return null;
      if (step.when !== undefined && !condition(step.when)) return null;
      if (step.otherwise !== undefined && step.otherwise !== "skip" && step.otherwise !== "end" && step.otherwise !== "jump") return null;
      if ((step.jump !== undefined && typeof step.jump !== "string") || (step.next !== undefined && typeof step.next !== "string")) return null;
    }
  }
  return raw as Flow[];
}
/** The stored list's value as read: nothing is an empty list; anything else malformed throws. */
function flowListOf(raw: unknown): Flow[] {
  if (raw === null) return [];
  if (typeof raw !== "string") throw new Error("Invalid sequence list response");
  const flows = parseFlowList(JSON.parse(raw));
  if (!flows) throw new Error("Invalid sequence list records");
  return flows;
}

/** Studio-only read: confirmed absence is empty; failed or malformed reads throw. */
export async function readFlowListStrict(listId: string | null): Promise<Flow[]> {
  if (!listId) return [];
  if (!isRedisConfigured()) throw new Error("Sequence storage is unavailable");
  const rows = await redisPipeline([["GET", "nl:mail:flows:" + listId]]);
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Incomplete sequence list response");
  return flowListOf(rows[0]);
}

/**
 * Reads the list KEYS[1] only while it is no larger than ARGV[1] bytes:
 * {1, value} (nothing when it is not there), or {0, its size} with nothing
 * of it sent back. So a read never moves more of the list than was taken
 * for before it (lib/flows.ts, FlowMeter). Modelled by lib/redis-memory.ts.
 */
export const READ_FLOWS_WITHIN = `-- marktmorgen:flows-read-within:v1
local n = redis.call('STRLEN', KEYS[1])
if n > tonumber(ARGV[1]) then return {0, n} end
return {1, redis.call('GET', KEYS[1])}`;

/**
 * The studio's strict read of the list, within `most` bytes (READ_FLOWS_WITHIN):
 * the list, or the size it has grown to, nothing of it read. Failed or
 * malformed answers throw, as readFlowListStrict's.
 */
export async function readFlowListWithin(listId: string | null, most: number): Promise<{ flows: Flow[] } | { larger: number }> {
  if (!listId) return { flows: [] };
  if (!isRedisConfigured()) throw new Error("Sequence storage is unavailable");
  if (!Number.isSafeInteger(most) || most < 0) throw new Error("Invalid sequence list bound");
  const rows = await redisPipeline([["EVAL", READ_FLOWS_WITHIN, 1, "nl:mail:flows:" + listId, most]]);
  if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0])) throw new Error("Incomplete sequence list response");
  const reply = rows[0] as unknown[];
  if (reply[0] === 1 && (reply.length === 2 || reply.length === 1)) return { flows: flowListOf(reply.length === 2 ? reply[1] : null) };
  const larger = Number(reply[1]);
  if (reply[0] === 0 && reply.length === 2 && Number.isSafeInteger(larger) && larger > most) return { larger };
  throw new Error("Invalid sequence list response");
}
