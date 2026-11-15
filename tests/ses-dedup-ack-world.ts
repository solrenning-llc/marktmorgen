/** Only the authenticated notification boundary is simulated. POST and lib/sns-receipt.ts are real. */
import type { SesEvent, SnsMessage } from "../lib/sns";
import { MemoryRedis } from "../lib/redis-memory";
export { readSns, readSesEvent, snsUrl } from "../lib/sns";
export type SesConfig = { roleArn: string; key: null; region: string; configurationSet: string; topicArn: string };

/**
 * One Redis answer that does not read: for the first pipeline whose command is `on`, the stand-in applies the
 * commands when `applied` (Redis did the work and the answer was lost) and not otherwise, then answers `reply`, or
 * throws when `throws`.
 */
export type Fault = { on: string; reply?: unknown; throws?: boolean; applied: boolean };

export const world: {
  redis: MemoryRedis;
  faults: Fault[];
  commands: (string | number)[][];
  /** Commands billed, each script's inner commands counted at their most (a GET and one write). */
  billed: number;
  events: SesEvent[];
  confirmations: number;
  failRecord: boolean;
} = { redis: new MemoryRedis(), faults: [], commands: [], billed: 0, events: [], confirmations: 0, failRecord: false };

/** A fresh database and history, with these answers to lose. */
export function reset(...faults: Fault[]) {
  world.redis.clear();
  world.faults = faults;
  world.commands = [];
  world.billed = 0;
  world.events = [];
  world.confirmations = 0;
  world.failRecord = false;
}
/** A new history on the same database. */
export function again(...faults: Fault[]) {
  world.faults = faults;
  world.commands = [];
  world.billed = 0;
}
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  world.commands.push(...commands);
  world.billed += commands.reduce((sum, command) => sum + (command[0] === "EVAL" ? 3 : 1), 0);
  const at = world.faults.findIndex((fault) => fault.on === commands[0]?.[0]);
  const fault = at >= 0 ? world.faults.splice(at, 1)[0] : null;
  if (fault && !fault.applied) {
    if (fault.throws) throw new Error("Synthetic lost Redis response");
    return fault.reply as unknown[];
  }
  const real = await world.redis.pipeline(commands);
  if (!fault) return real;
  if (fault.throws) throw new Error("Synthetic lost Redis response");
  return fault.reply as unknown[];
}
export function sesConfig(): SesConfig {
  return { roleArn: "synthetic", key: null, region: "us-east-1", configurationSet: "synthetic", topicArn: "arn:aws:sns:us-east-1:000000000000:synthetic" };
}
export function isSesConfigured() { return true; }
/** Signature verification is synthetic; its cryptography is tested by sns.test.ts. */
export async function verifySns(message: SnsMessage, config: SesConfig) { void message; void config; return "ok" as const; }
export async function recordSesEvent(event: SesEvent) {
  if (world.failRecord) throw new Error("Synthetic failure while acting on the event");
  world.events.push(event);
  return "counted" as const;
}
export async function withinLimit(...args: unknown[]) { void args; return true; }
export function clientAddress(request: Request) { void request; return "synthetic-client"; }
export async function limited(request: Request, maxBytes: number) { void maxBytes; return request; }
