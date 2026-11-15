/**
 * The chat summary's Redis replies, read only in their exact shape (CX-123 rule 24, lib/chat-summary.ts).
 *
 * Stopping the posting (an empty address) is "removed" only when the DEL answered a whole 0 or 1; saving is
 * "saved" only when the SET answered "OK"; the kept address is read only from a string or a confirmed absent
 * key. Any other reply (none, a hole, "QUEUED", a negative or fractional count, a string count) throws
 * UnknownReplyError, so the creator is never told the channel stopped while the sealed webhook stays and the
 * weekly and monthly jobs keep posting the store's numbers to it. Synthetic store, synthetic webhook; no chat
 * is reached (fetch is a stand-in).
 */
import { chatAddress, setChatAddress } from "@/lib/chat-summary";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const SLACK = "https://hooks.slack.com/services/T0000/B0000/abcdefghijklmnopqrstuvwx";
const ID = "s0000000000000000001";
let posts = 0;
globalThis.fetch = (async () => {
  posts += 1;
  return new Response("ok", { status: 200 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** Answers `shape` in place of the first command named `name`; every other command reaches the stand-in. */
function answer(name: string, shape: unknown): void {
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === name ? shape : real(commands))) as typeof redis.pipeline;
}
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  }
}

// A hole: a list of length one whose only slot is missing.
const hole: unknown[] = [];
hole.length = 1;
const odd: [string, unknown][] = [
  ["[]", []],
  ["[undefined]", [undefined]],
  ["a hole", hole],
  ['["QUEUED"]', ["QUEUED"]],
  ["[null]", [null]],
  ["[-1]", [-1]],
  ["[1.5]", [1.5]],
  ['["1"]', ["1"]],
  ["[2]", [2]],
  ["{}", {}],
  ["null", null],
];

async function main(): Promise<void> {
  part("healthy and confirmed-empty controls");
  redis.clear();
  is("nothing kept: no address", await chatAddress(ID), null);
  is("stopping with nothing kept (DEL 0): removed", await setChatAddress(ID, "Harbor", ""), "removed");
  is("saved after a first message", await setChatAddress(ID, "Harbor", SLACK), "saved");
  is("the kept address opens", await chatAddress(ID), SLACK);
  is("stopping (DEL 1): removed", await setChatAddress(ID, "Harbor", ""), "removed");
  is("stopped: no address", await chatAddress(ID), null);
  answer("GET", ["QUEUED"]);
  is("a kept string that does not open: no address, as before", await chatAddress(ID), null);
  redis.pipeline = real;
  is("an address of neither kind: invalid, nothing posted", [await setChatAddress(ID, "Harbor", "https://example.com/hook"), posts], ["invalid", 1]);

  part("DEL in an unknown shape: never 'removed'");
  for (const [label, shape] of odd) {
    redis.pipeline = real;
    redis.clear();
    await setChatAddress(ID, "Harbor", SLACK);
    answer("DEL", shape);
    const said = await outcome(() => setChatAddress(ID, "Harbor", ""));
    redis.pipeline = real;
    is(`DEL answered ${label}: UnknownReplyError, not "removed"`, said, "unknown");
  }

  part("SET in an unknown shape: never 'saved'");
  for (const [label, shape] of [...odd, ['["ok"]', ["ok"]], ["[1]", [1]]] as [string, unknown][]) {
    redis.pipeline = real;
    redis.clear();
    answer("SET", shape);
    const said = await outcome(() => setChatAddress(ID, "Harbor", SLACK));
    redis.pipeline = real;
    is(`SET answered ${label}: UnknownReplyError, not "saved"`, said, "unknown");
  }

  // A confirmed absent key ([null]) is none, and a string that does not open (["QUEUED"], ["1"]) is one that can no
  // longer be read, as before: both stay null. Only a reply of no exact shape is unknown.
  part("GET in an unknown shape: unknown, never read as 'none'");
  for (const [label, shape] of odd.filter(([, shape]) => !(Array.isArray(shape) && shape.length === 1 && (shape[0] === null || typeof shape[0] === "string")))) {
    redis.pipeline = real;
    redis.clear();
    await setChatAddress(ID, "Harbor", SLACK);
    answer("GET", shape);
    const read = await outcome(() => chatAddress(ID));
    redis.pipeline = real;
    is(`GET answered ${label}: UnknownReplyError`, read, "unknown");
  }
  redis.pipeline = real;
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
