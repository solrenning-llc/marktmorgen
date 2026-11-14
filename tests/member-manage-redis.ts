import { redisPipeline as memoryPipeline } from "./redis-stub";
export * from "./redis-stub";

let injected: { reply: unknown; at: number } | null = null;
let limits = 0;
export function limitReply(reply: unknown, at = 1): void {
  injected = { reply, at };
  limits = 0;
}
export function clearLimitReply(): void { injected = null; limits = 0; }

/** Apply the real memory commands, then lose or corrupt only their reply. */
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  const result = await memoryPipeline(commands);
  if (commands.length === 2 && commands[0][0] === "SET" && commands[1][0] === "INCR" &&
      /nl:(rl:manage:|manage:opens:)/.test(String(commands[0][1]))) {
    limits += 1;
    if (injected && limits === injected.at) return injected.reply as unknown[];
  }
  return result;
}
