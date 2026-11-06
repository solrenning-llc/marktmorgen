import { MemoryRedis } from "@/lib/redis-memory";
import type { NextRequest } from "next/server";
import type { Store } from "@/lib/store";
import type { Need } from "@/lib/studio-route";
export * from "../lib/ai";
export { text } from "../lib/store-request";

const redis = new MemoryRedis();
const store = { sid: "a".repeat(32), handle: "test-ai", catalog: { head: [] } } as unknown as Store;
export const state = {
  configured: true, override: false, reply: undefined as unknown, throws: false,
  authorized: true, commands: [] as (string | number)[][], modelCalls: 0,
  permission: null as Need | null, bodyLimit: 0,
};
export function reset() {
  redis.clear();
  Object.assign(state, { configured: true, override: false, reply: undefined, throws: false, authorized: true, commands: [], modelCalls: 0, permission: null, bodyLimit: 0 });
}
export const isRedisConfigured = () => state.configured;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  state.commands.push(...commands);
  if (state.throws) throw new Error("Synthetic AI counter timeout");
  return state.override ? state.reply as unknown[] : redis.pipeline(commands);
}
/** Authentication is a controlled boundary; route and counter code are real. */
export async function guardStoreWrite(request: NextRequest, need: Need | ((body: Record<string, unknown>) => Need | null), maxBodyBytes = 4_000) {
  if (!state.authorized) return { ok: false as const, response: Response.json({ ok: false, error: "role" }, { status: 403 }) };
  const body = await request.json() as Record<string, unknown>;
  state.permission = typeof need === "function" ? need(body) : need;
  state.bodyLimit = maxBodyBytes;
  return { ok: true as const, store, body, email: "owner@example.com", ref: "synthetic-ref", role: "owner" as const };
}
/** A model-boundary spy, without credentials or an external request. */
export async function writeBio() {
  state.modelCalls += 1;
  return { ok: true as const, value: "A confirmed synthetic draft.", left: 9 };
}
