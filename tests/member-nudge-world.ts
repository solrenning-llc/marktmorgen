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
let tokensRead: (() => Promise<void>) | undefined;
/** Work run right after the list's tokens are read, as an erasure finishing then would (#4764). */
export const afterTokens = (work: () => Promise<void>) => { tokensRead = work; };
export const tokensFor = async () => {
  const tokens = new Map([["member@example.com", "synthetic-stop-token"]]);
  if (tokensRead) await tokensRead();
  return tokens;
};
export const readListings = async () => [{ id: "prod000001", title: "The course", course: "course1" }];
export const storeBase = () => "https://marktmorgen.com/@club";
export const fromLine = () => "club@example.com";
export const render = (_store: unknown, subject: string, text: string) => ({ subject, text, headers: {} });
// Only so lib/suppression (through lib/auth) bundles against this world: the nudge never calls them.
export const NIMBUS_FROM = "Marktmorgen <synthetic@example.com>";
export const normaliseHandle = (raw: string) => raw;
export const newAddressProblem = () => null;
export let sent = 0;
export const sendEmail = async () => { sent += 1; return true; };

let response: unknown;
let override = false;
let countFails = false;
export function reset(reply?: unknown): void {
  memory.clear(); sent = 0; response = reply; override = arguments.length > 0; countFails = false; tokensRead = undefined;
}
/** The monthly count's INCR throws, as a lost Redis answer would. */
export function failCount(): void { countFails = true; }
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  if (countFails && commands[0]?.[0] === "INCR") throw new Error("synthetic lost count reply");
  const results = await memory.pipeline(commands);
  // The period's claim, one EVAL whose first key is the period's mark (NUDGE_CLAIM, #4764).
  if (override && commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][3]).startsWith("nl:nudge:")) {
    return response as unknown[];
  }
  return results;
}
