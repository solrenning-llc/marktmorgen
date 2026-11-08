import { MemoryRedis } from "@/lib/redis-memory";

export const store = new MemoryRedis();
export const commands: (string | number)[][] = [];
export const isRedisConfigured = () => true;
let change: ((reply: unknown[]) => unknown[]) | null = null;
let changeKeys: ((reply: unknown[]) => unknown[]) | null = null;

export function reset() {
  store.clear();
  commands.length = 0;
  change = null;
  changeKeys = null;
}

export function changeReading(transform: (reply: unknown[]) => unknown[]) {
  change = transform;
}

export function changeKeyReading(transform: (reply: unknown[]) => unknown[]) {
  changeKeys = transform;
}

export async function redisPipeline(batch: (string | number)[][]): Promise<unknown[]> {
  commands.push(...batch);
  const reply = await store.pipeline(batch);
  if (batch[0]?.[0] === "HKEYS" && changeKeys) return changeKeys(reply);
  return batch[0]?.[0] === "HGETALL" && change ? change(reply) : reply;
}
