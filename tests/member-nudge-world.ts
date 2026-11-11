import { MemoryRedis } from "@/lib/redis-memory";

export const memory = new MemoryRedis();
export const isRedisConfigured = () => true;
export const isSenderConfigured = () => true;
export const platformKey = () => "synthetic";
export const sellsMemberships = () => true;
export const storesAfter = async () => ({ stores: [], next: "0" });
export const runningMembers = async () => ({ rows: [] });
export const scoreMembers = async () => [{
  email: "member@example.com", sub: "sub_Member000001", product: "prod000001",
  periodEnd: 2_000_000_000, score: 30, factors: [{ reason: "course-never" }],
}];
export const tokensFor = async () => new Map([["member@example.com", "synthetic-stop-token"]]);
export const readListings = async () => [{ id: "prod000001", title: "The course", course: "course1" }];
export const storeBase = () => "https://marktmorgen.com/@club";
export const fromLine = () => "club@example.com";
export const render = (_store: unknown, subject: string, text: string) => ({ subject, text, headers: {} });
export let sent = 0;
export const sendEmail = async () => { sent += 1; return true; };

let response: unknown;
let override = false;
let countFails = false;
export function reset(reply?: unknown): void {
  memory.clear(); sent = 0; response = reply; override = arguments.length > 0; countFails = false;
}
/** The monthly count's INCR throws, as a lost Redis answer would. */
export function failCount(): void { countFails = true; }
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  if (countFails && commands[0]?.[0] === "INCR") throw new Error("synthetic lost count reply");
  const results = await memory.pipeline(commands);
  if (override && commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:nudge:") && commands[0].includes("NX")) {
    return response as unknown[];
  }
  return results;
}
