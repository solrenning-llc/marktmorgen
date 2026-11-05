import { MemoryRedis } from "@/lib/redis-memory";
import { noteRead } from "@/lib/read-meter";
export const store = new MemoryRedis();
export const isRedisConfigured = () => true;
export const redisPipeline = async (commands: (string | number)[][]) => {
  const answers = await store.pipeline(commands);
  noteRead(commands.length, answers);
  return answers;
};
/** Moves the test clock, for a cooldown that has to be outlasted. */
export const advance = (ms: number) => store.advance(ms);
/**
 * lib/redis.ts redisPipelineBase64, as the REST API's "Upstash-Encoding: base64" answers: every string base64
 * (its bytes as UTF-8 here, the stand-in's values being text), "OK" as it is, numbers and nulls as they are.
 */
export const redisPipelineBase64 = async (commands: (string | number)[][]) => {
  const encode = (value: unknown): unknown =>
    typeof value === "string" ? (value === "OK" ? value : Buffer.from(value, "utf8").toString("base64")) : Array.isArray(value) ? value.map(encode) : value;
  return (await store.pipeline(commands)).map(encode);
};
