import { redisPipeline as memoryPipeline } from "./redis-stub";
export * from "./redis-stub";
let reply: unknown;
let override = false;
export function cachedReply(value?: unknown): void { reply = value; override = arguments.length > 0; }
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  const result = await memoryPipeline(commands);
  if (override && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:member:status:")) return reply as unknown[];
  return result;
}
