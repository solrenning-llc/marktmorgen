/**
 * A student's uploaded file passes the hand-in door once (lib/assignment.ts,
 * takeTaskUpload): the ZREM that takes it off the list of uploads never
 * handed in. It is this hand-in's only on exactly one reply of 1, refused on
 * exactly 0, and any other reply ("1", true, [1], none, two) is unknown and
 * throws, so a hand-in never keeps a file the nightly sweep may also have
 * taken and deleted (issue #4287; Codex V, hidden #4139).
 */
import { noteTaskUpload, takeTaskUpload } from "@/lib/assignment";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const PATH = "tasks/0123456789abcdef0123456789abcdef/lesson/who/file.pdf";
const original = redis.pipeline.bind(redis);
let zremReply: unknown[] | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (zremReply && commands.length === 1 && commands[0][0] === "ZREM") {
    const reply = zremReply;
    zremReply = null;
    await original(commands);
    return reply;
  }
  return original(commands);
}) as typeof redis.pipeline;

async function take(reply: unknown[] | null): Promise<string> {
  zremReply = reply;
  try {
    return String(await takeTaskUpload(PATH));
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  } finally {
    zremReply = null;
  }
}

async function main(): Promise<void> {
  redis.clear();
  part("Controls: Redis's own answers");
  await noteTaskUpload(PATH);
  is("let in through the door: taken", await take(null), "true");
  is("taken already: refused", await take(null), "false");

  for (const [label, reply] of [
    ["the string 1", ["1"]],
    ["true", [true]],
    ["a list holding 1", [[1]]],
    ["no reply", []],
    ["two replies", [1, 1]],
  ] as const) {
    part(`The ZREM answers ${label}`);
    await noteTaskUpload(PATH);
    is("unknown, never taken", await take([...reply] as unknown[]), "unknown");
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
