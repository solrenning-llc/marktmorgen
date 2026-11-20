import { MemoryRedis } from "@/lib/redis-memory";
import type { NextRequest } from "next/server";
import type { Store } from "@/lib/store";

export const redis = new MemoryRedis();
export const CHAT_URL = "https://hooks.slack.com/services/synthetic/test-fixture-only";
const store = { sid: "e".repeat(32), statsId: "f".repeat(32), handle: "test-chat", name: "Synthetic Store" } as Store;
export const state = {
  configured: true, override: false, reply: undefined as unknown, throws: false,
  commitThenThrow: false, authorized: true, commands: [] as (string | number)[][],
  posts: 0, postBytes: 0, toggles: 0,
};
export function reset() {
  redis.clear();
  Object.assign(state, { configured: true, override: false, reply: undefined, throws: false,
    commitThenThrow: false, authorized: true, commands: [], posts: 0, postBytes: 0, toggles: 0 });
}
export const isRedisConfigured = () => state.configured;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  state.commands.push(...commands);
  if (String(commands[0][1]).startsWith("nl:rl:chat-summary:")) {
    if (state.throws) throw new Error("Synthetic counter timeout");
    if (state.commitThenThrow) {
      await redis.pipeline(commands);
      throw new Error("Synthetic lost counter acknowledgement");
    }
    if (state.override) return state.reply as unknown[];
  }
  return redis.pipeline(commands);
}
/** Authentication/store context and Redis transport are synthetic; the route, guard,
 * chat helper, sealing and provider request construction are the actual code. */
export async function guardStoreWrite(request: NextRequest) {
  return state.authorized
    ? { ok: true as const, store, ref: "synthetic-ref", body: await request.json() as Record<string, unknown> }
    : { ok: false as const, response: Response.json({ ok: false, error: "role" }, { status: 403 }) };
}
export async function ensureStatsId() { throw new Error("Fixture already has a statistics ID"); }
export async function setChatSales(_ref: string, value: boolean) { state.toggles++; return { chatSales: value }; }
