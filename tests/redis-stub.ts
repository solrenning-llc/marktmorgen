import { MemoryRedis } from "@/lib/redis-memory";
import { withTakeScripts } from "./redis-take-scripts";
import { isOrderAccounting, isStuckAccounting, orderAccounting, stuckAccounting } from "./order-accounting-memory";
export const store = withTakeScripts(new MemoryRedis());
store.pipeline = async commands => commands.map(command =>
  isOrderAccounting(command) ? orderAccounting(store, command) : isStuckAccounting(command) ? stuckAccounting(store, command) : store.run(command));
let configured = true;
export const isRedisConfigured = () => configured;
/** Only for a test of the "Redis not configured" branch; always put back to true in a finally. */
export function setRedisConfigured(on: boolean): void { configured = on; }
export const redisPipeline = (commands: (string | number)[][]) => store.pipeline(commands);
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
