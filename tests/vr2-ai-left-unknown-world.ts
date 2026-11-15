/** VR2 world: every Redis answer is a transport error object (an unknown read), or the in-memory stand-in. Synthetic only. */
import { MemoryRedis } from "@/lib/redis-memory";
export const store = new MemoryRedis();
let unknown = true;
export const setUnknown = (on: boolean) => { unknown = on; };
export const isRedisConfigured = () => true;
export const redisPipeline = async (commands: (string | number)[][]) =>
  unknown ? commands.map(() => ({ error: "ERR synthetic timeout" })) : store.pipeline(commands);
