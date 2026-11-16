/**
 * CX-123 rule 24 (C4-20261106-0750-TODOS-35; Codex G's proof 65557d01 on #2781): dropEnrollment (lib/learn.ts) takes a
 * course off an address's ledger for a refunded gift, pre-order, group place or PayPal sale. Its two replies are read
 * exactly: the HDEL and the DEL each answer 0 or 1. Any other reply (none, too few, too many, null, "QUEUED", text)
 * throws, so its callers keep the refund to be tried again instead of reading "access taken away".
 */
import { dropEnrollment } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let reply: unknown = undefined;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (reply !== undefined && commands[0]?.[0] === "HDEL") return reply;
  return pipeline(commands);
}) as typeof redis.pipeline;

const store = { handle: "dropexact", sid: "st_dropexact000001", statsId: "dropexact" } as never;
const outcome = async (): Promise<string> => {
  try {
    await dropEnrollment(store, "buyer@example.test", "prod_1");
    return "done";
  } catch (error) {
    return error instanceof Error && error.name === "UnknownReplyError" ? "unknown" : `threw ${String(error)}`;
  }
};

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  part("only the exact replies count as done");
  for (const [label, value] of [
    ["no reply", []],
    ["one reply", [1]],
    ["three replies", [1, 1, 1]],
    ["a null HDEL", [null, 1]],
    ["a queued HDEL", ["QUEUED", 1]],
    ["a count as text", ["1", 1]],
    ["a DEL of 2", [1, 2]],
    ["a fraction", [0.5, 1]],
    ["not a list", { result: 1 }],
  ] as [string, unknown][]) {
    reply = value;
    is(`${label}: unknown, never "taken away"`, await outcome(), "unknown");
  }
  for (const value of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    reply = value;
    is(`HDEL ${value[0]}, DEL ${value[1]}: done`, await outcome(), "done");
  }
  part("the real commands");
  reply = undefined;
  await redis.pipeline([["HSET", "probe", "f", "1"]]);
  is("the stand-in Redis answers and it is done", await outcome(), "done");
  done();
}

void main();
