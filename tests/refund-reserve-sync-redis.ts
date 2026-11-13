// "@/lib/redis" for refund-reserve-sync.test.ts only: the in-memory Redis of
// every test, counting each command, with a hook that answers a command in
// another shape (CX-123 rule 24: such an answer is unknown, never empty).
import { MemoryRedis } from "@/lib/redis-memory";
export const store = new MemoryRedis();
export const counted = { commands: 0, garble: null as null | ((command: (string | number)[]) => unknown) };
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  counted.commands += commands.length;
  const replies = await store.pipeline(commands);
  if (!counted.garble) return replies;
  return replies.map((reply, i) => {
    const other = counted.garble!(commands[i]);
    return other === undefined ? reply : other;
  });
}
export const redisPipelineBase64 = redisPipeline;
