/**
 * Deleting a person is charged to the store's studio allowance by its size
 * (lib/person-erasure.ts, erasureSize, erasureUnits): the deals, the inbox's
 * conversations, the person's community messages and the community room are
 * counted first, and the rest of the allowance is taken for them before the
 * work runs. Before, each count read a reply in another shape as 0, so a big
 * erasure was charged as a small one and its Redis work ran past the
 * allowance. Each count now reads its reply exactly and throws
 * UnknownReplyError otherwise (erasePerson then answers "unavailable", nothing
 * deleted, nothing charged twice). Synthetic data only.
 */
import { conversationCount } from "@/lib/inbox";
import { dealCount } from "@/lib/crm";
import { roomSize } from "@/lib/community-chat";
import { dmCount } from "@/lib/community-dm";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const original = redis.pipeline.bind(redis) as Pipeline;

async function run(call: () => Promise<number>, swap?: (real: unknown[]) => unknown): Promise<unknown> {
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    const real = await original(commands);
    return (swap ? swap(real) : real) as unknown[];
  };
  try {
    return await call();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other error: ${String(error)}`;
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = original;
  }
}

const statsId = "erasuresizeexact00000000000001";
const counts: [string, () => Promise<number>, number][] = [
  ["the deals", () => dealCount(statsId), 1],
  ["the inbox's conversations", () => conversationCount(statsId), 1],
  ["the community room", () => roomSize("comm_erasesize01"), 1],
  ["the person's community messages", () => dmCount("comm_erasesize01", "learner_erasesize01"), 2],
];

async function main(): Promise<void> {
  redis.clear();
  part("Counts in their shape are read as they always were");
  for (const [what, call, n] of counts) {
    is(`${what}: nothing kept is an exact 0`, await run(call), 0);
    is(`${what}: a kept count is read`, await run(call, () => new Array(n).fill(3)), 3 * n);
  }

  part("A count in another shape is unknown, never 0");
  const shapes: [string, (n: number) => unknown][] = [
    ["an empty envelope", () => []],
    ["a missing reply", (n) => new Array(n).fill(undefined)],
    ["a text reply", (n) => new Array(n).fill("12")],
    ["a negative count", (n) => new Array(n).fill(-1)],
    ["a list reply", (n) => new Array(n).fill([1])],
    ["an envelope that is not a list", () => "OK"],
  ];
  for (const [what, call, n] of counts) {
    for (const [shape, reply] of shapes) is(`${what}: ${shape} throws UnknownReplyError`, await run(call, () => reply(n)), "unknown");
  }
  done();
}

void main();
