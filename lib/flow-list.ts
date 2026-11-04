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
  if (value.do === "start") return strings(value, ["flowId"]);
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
/** Studio-only read: confirmed absence is empty; failed or malformed reads throw. */
export async function readFlowListStrict(listId: string | null): Promise<Flow[]> {
  if (!listId) return [];
  if (!isRedisConfigured()) throw new Error("Sequence storage is unavailable");
  const rows = await redisPipeline([["GET", "nl:mail:flows:" + listId]]);
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Incomplete sequence list response");
  if (rows[0] === null) return [];
  if (typeof rows[0] !== "string") throw new Error("Invalid sequence list response");
  const flows = parseFlowList(JSON.parse(rows[0]));
  if (!flows) throw new Error("Invalid sequence list records");
  return flows;
}
