import { MemoryRedis } from "@/lib/redis-memory";
// Keep the actual signature verifier; only configuration and provider helpers are synthetic.
export { believed } from "../lib/stream";

export const readKey = "synthetic-stream-signature-fixture";
export const redis = new MemoryRedis();
export const state = { inject: false, reply: undefined as unknown, throws: false, commit: false, configured: true, result: "looked", providerThrows: false, commands: [] as (string | number)[][], heard: 0, captions: 0, inputBytes: 0 };
export function reset() {
  redis.clear();
  Object.assign(state, { inject: false, reply: undefined, throws: false, commit: false, configured: true, result: "looked", providerThrows: false, commands: [], heard: 0, captions: 0, inputBytes: 0 });
}
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  state.commands.push(...commands);
  if (state.inject && String(commands[0]?.[1]).startsWith("nl:rl:stream-hook:")) {
    if (state.commit) await redis.pipeline(commands);
    if (state.throws) throw new Error("Synthetic lost counter acknowledgement");
    return state.reply as unknown[];
  }
  return redis.pipeline(commands);
}
export const isStreamConfigured = () => state.configured;
export const streamConfig = () => state.configured ? { library: "123", key: "synthetic", tokenKey: "synthetic", readKey } : null;
/** Attempts/argument bytes at the provider-helper boundary, not live network costs. */
export async function heard(body: unknown) {
  state.heard++; state.inputBytes += Buffer.byteLength(JSON.stringify(body));
  if (state.providerThrows) throw new Error("Synthetic video lookup failure");
  return state.result;
}
export async function syncAutoCaptions(id: string) { state.captions++; state.inputBytes += Buffer.byteLength(id); }
