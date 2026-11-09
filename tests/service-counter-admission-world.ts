import { MemoryRedis } from "@/lib/redis-memory";
import type { AllowanceStore, Taken } from "@/lib/store-allowance";
import type { AllowanceKind } from "@/lib/store-allowance-rules";

export const redis = new MemoryRedis();
export const state = {
  configured: true,
  reply: undefined as unknown,
  override: false,
  throws: false,
  commands: [] as (string | number)[][],
  quota: { ok: true, left: 9 } as Taken,
  quotaCalls: 0,
  publicCalls: 0,
  supplierCalls: 0,
};
export function reset() {
  redis.clear();
  Object.assign(state, { configured: true, reply: undefined, override: false, throws: false, commands: [], quota: { ok: true, left: 9 }, quotaCalls: 0, publicCalls: 0, supplierCalls: 0 });
}
export const isRedisConfigured = () => state.configured;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  state.commands.push(...commands);
  if (state.throws) throw new Error("Synthetic counter timeout");
  if (state.override) return state.reply as unknown[];
  return redis.pipeline(commands);
}
/** The monthly reservation is a confirmed stand-in, so it cannot hide a
 * permissive short-window gate. This fixture does not certify its funding.
 */
export async function takeAllowance(_store: AllowanceStore, kind: AllowanceKind): Promise<Taken> {
  if (kind !== "integration") throw new Error("Unexpected allowance kind");
  state.quotaCalls += 1;
  return state.quota;
}
export async function takePublicRequest() { state.publicCalls += 1; return true; }
export async function holdPublicRequests() { return true; }
