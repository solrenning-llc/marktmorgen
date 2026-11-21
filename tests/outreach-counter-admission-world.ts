import { MemoryRedis } from "@/lib/redis-memory";
import type { NextRequest } from "next/server";
import type { Store } from "@/lib/store";
import type { ServiceRefusal } from "@/lib/metered-limits";
export * from "../lib/outreach";
export { text } from "../lib/store-request";
export { serviceRefusedJson } from "../lib/metered-limits";

export const redis = new MemoryRedis();
const store = { sid: "a".repeat(32), statsId: "b".repeat(32), handle: "test-outreach" } as Store;
export const state = {
  override: false, reply: undefined as unknown, throws: false, authorized: true,
  commands: [] as (string | number)[][], reads: 0, drafts: 0, serviceCalls: 0,
  refusal: null as ServiceRefusal | null,
};
export function reset() {
  redis.clear();
  Object.assign(state, { override: false, reply: undefined, throws: false, authorized: true, commands: [], reads: 0, drafts: 0, serviceCalls: 0, refusal: null });
}
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  state.commands.push(...commands);
  if (state.throws) throw new Error("Synthetic outreach counter timeout");
  return state.override ? state.reply as unknown[] : redis.pipeline(commands);
}
export async function guardStoreWrite(request: NextRequest) {
  if (!state.authorized) return { ok: false as const, response: Response.json({ ok: false, error: "role" }, { status: 403 }) };
  return { ok: true as const, store, ref: "synthetic-ref", body: await request.json() as Record<string, unknown> };
}
/** Independent monthly/minute service admission is a controlled boundary.
 * The route's own daily and AI counters remain real, not mocked booleans.
 */
export async function withinServiceWhy() { state.serviceCalls += 1; return state.refusal; }
export async function readStoreSite() {
  state.reads += 1;
  return { ok: true as const, site: { url: "https://example.com", company: "Example" } };
}
export async function startPitch() {
  state.drafts += 1;
  return { ok: true as const, pitch: { id: "a".repeat(16) }, left: 9, replaced: null };
}
