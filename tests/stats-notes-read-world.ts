import { MemoryRedis } from "@/lib/redis-memory";

export const store = new MemoryRedis();
export const commands: (string | number)[][] = [];
export const isRedisConfigured = () => true;
let change: ((reply: unknown[]) => unknown[]) | null = null;

export function reset() {
  store.clear();
  commands.length = 0;
  change = null;
}

export function changeReading(transform: (reply: unknown[]) => unknown[]) {
  change = transform;
}

export async function redisPipeline(batch: (string | number)[][]): Promise<unknown[]> {
  commands.push(...batch);
  const reply = await store.pipeline(batch);
  return batch[0]?.[0] === "HGETALL" && change ? change(reply) : reply;
}
