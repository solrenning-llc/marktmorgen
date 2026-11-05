/** Only the authenticated notification boundary is simulated. POST is real. */
import type { SesEvent } from "../lib/sns";
export { readSns, readSesEvent, snsUrl } from "../lib/sns";

export const world: {
  reply: unknown;
  throws: boolean;
  commands: (string | number)[][];
  events: SesEvent[];
  confirmations: number;
} = { reply: ["OK"], throws: false, commands: [], events: [], confirmations: 0 };

export function reset(reply: unknown, throws = false) {
  world.reply = reply;
  world.throws = throws;
  world.commands = [];
  world.events = [];
  world.confirmations = 0;
}
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  world.commands.push(...commands);
  if (world.throws) throw new Error("Synthetic lost claim response");
  return world.reply as unknown[];
}
export function sesConfig() {
  return { region: "us-east-1", topicArn: "arn:aws:sns:us-east-1:000000000000:synthetic" };
}
export function isSesConfigured() { return true; }
/** Signature verification is synthetic; its cryptography is tested by sns.test.ts. */
export async function verifySns() { return "ok" as const; }
export async function recordSesEvent(event: SesEvent) {
  world.events.push(event);
  return "counted" as const;
}
export async function withinLimit() { return true; }
export function clientAddress() { return "synthetic-client"; }
export async function limited(request: Request) { return request; }
