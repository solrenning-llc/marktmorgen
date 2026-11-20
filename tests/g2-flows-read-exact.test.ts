/**
 * The store's sequences, read for erasure and for a person's copy, are never "none" on a reply that was not read
 * (CX-123 rule 24). readFlows answered [] for a missing, extra, wrongly typed or garbled reply, so a closed store's
 * sequence ids were left out of what is erased (lib/closed-store-data.ts marksOf, whose own comment says a failed
 * read is never "nothing"), and a person's copy said they were in no sequence. Only an exact nil is "none".
 */
import { readFlows } from "@/lib/flows";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const pipeline = redis.pipeline.bind(redis);
const LIST = "list000001";
let reply: unknown = undefined;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (reply !== undefined && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).includes(LIST)) return reply as never;
  return pipeline(commands);
}) as typeof redis.pipeline;

const outcome = async (): Promise<unknown> => {
  try {
    return await readFlows(LIST);
  } catch (error) {
    return error instanceof Error ? error.name : "threw";
  }
};

async function main(): Promise<void> {
  part("An exact answer reads as it is");
  reply = [null];
  is("nil: no sequences", await outcome(), []);
  const flow = { id: "flow000001", active: true, steps: [{ id: "s1", kind: "email" }] };
  reply = [JSON.stringify([flow])];
  is("a stored list: read", JSON.stringify(await outcome()), JSON.stringify([flow]));

  part("Anything else is unknown, never none");
  for (const [label, value] of [
    ["no reply", []],
    ["an extra reply", [null, null]],
    ["a number", [7]],
    ["garbled text", ["{"]],
    ["an object, not a list", ["{}"]],
    ["a list of something else", ["[1]"]],
  ] as const) {
    reply = value;
    is(`${label}: unknown`, await outcome(), "UnknownReplyError");
  }
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
