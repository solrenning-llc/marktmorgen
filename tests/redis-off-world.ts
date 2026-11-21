/**
 * The Redis stub with a switch: `setRedisConfigured(false)` makes `isRedisConfigured()` answer false, as a
 * deployment without its Redis settings would, and every pipeline throw, so a reader that still reached Redis is
 * seen. On by default, so a test sets up its world first.
 */
import { MemoryRedis } from "@/lib/redis-memory";

export const store = new MemoryRedis();
let configured = true;
export const setRedisConfigured = (on: boolean) => {
  configured = on;
};
export const isRedisConfigured = () => configured;
export const redisPipeline = async (commands: (string | number)[][]) => {
  if (!configured) throw new Error("Redis is not configured (test)");
  return store.pipeline(commands);
};
