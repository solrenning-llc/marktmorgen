import { MemoryRedis } from "@/lib/redis-memory";
import { spendCommands } from "@/lib/redis-ceiling";
export const store = new MemoryRedis();
export const isRedisConfigured = () => true;
/** Held to the command ceiling of the work it runs in (lib/redis-ceiling.ts), as lib/redis.ts is. */
export const redisPipeline = async (commands: (string | number)[][]) => {
  spendCommands(commands.length);
  return store.pipeline(commands);
};
/** Moves the test clock, for a cooldown that has to be outlasted. */
export const advance = (ms: number) => store.advance(ms);
/**
 * lib/redis.ts redisPipelineBase64, as the REST API's "Upstash-Encoding: base64" answers: every string base64
 * (its bytes as UTF-8 here, the stand-in's values being text), "OK" as it is, numbers and nulls as they are.
 */
export const redisPipelineBase64 = async (commands: (string | number)[][]) => {
  spendCommands(commands.length);
  const encode = (value: unknown): unknown =>
    typeof value === "string" ? (value === "OK" ? value : Buffer.from(value, "utf8").toString("base64")) : Array.isArray(value) ? value.map(encode) : value;
  return (await store.pipeline(commands)).map(encode);
};
