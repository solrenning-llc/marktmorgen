/**
 * Issue #4287, item 7 (Codex U, `U-20261112-1836-stream-queue-read.md`; rule 24): the five-minute video job
 * (lib/stream.ts sweep) read its two queues loosely, in three reads. A reply to the due queue's ZRANGEBYSCORE (the
 * first page, or the page past the videos whose move could not be confirmed), or to the to-delete set's SMEMBERS, that
 * was not a list became [], and members that were not text were skipped, so the job answered "nothing to do" (and the
 * cron ok: true) while it had read nothing. Now each reply is read exactly: a list of text, or UnknownReplyError,
 * which the cron (app/api/cron/stream/route.ts) answers as a failed part.
 *
 * Synthetic only: the in-memory Redis and a stand-in for the video service.
 */
import { sweep } from "@/lib/stream";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.BUNNY_STREAM_LIBRARY_ID = "123456";
process.env.BUNNY_STREAM_API_KEY = "synthetic-api-key-0000000000";
process.env.BUNNY_STREAM_TOKEN_KEY = "synthetic-token-key-000000000";
globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

const NOW = Date.UTC(2026, 10, 8, 12);
const original = redis.pipeline.bind(redis);
type Pipeline = typeof redis.pipeline;

/** Runs the job with `command`'s reply replaced by `reply`; what the job did. */
async function run(command: "ZRANGEBYSCORE" | "SMEMBERS", reply: unknown): Promise<string> {
  redis.pipeline = (async (commands) => {
    if (commands.length === 1 && commands[0]?.[0] === command) return reply as unknown[];
    return original(commands);
  }) as Pipeline;
  try {
    const counts = await sweep(Date.now() + 60_000, NOW);
    return `finished ${JSON.stringify(counts)}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  } finally {
    redis.pipeline = original;
  }
}

const DUE = "nl:stream:due";
const UNMOVED = "00000000-0000-4000-8000-0000000d0001";

/**
 * One due video whose record does not read and whose move to a later look is not confirmed (ZADD CH answers 0), so
 * the job reads a second page past it (LIMIT 0 41); that second page is answered `reply` (null: the real read).
 */
async function runPastUnmoved(reply: unknown): Promise<string> {
  redis.clear();
  await original([["ZADD", DUE, NOW - 60_000, UNMOVED]]);
  redis.pipeline = (async (commands) => {
    const [command] = commands;
    if (commands.length === 1 && command?.[0] === "GET" && command[1] === `nl:stream:v:${UNMOVED}`) return [1];
    if (commands.length === 1 && command?.[0] === "ZADD" && command[1] === DUE) return [0];
    if (commands.length === 1 && command?.[0] === "ZRANGEBYSCORE" && Number(command[command.length - 1]) === 41 && reply !== null) return reply as unknown[];
    return original(commands);
  }) as Pipeline;
  try {
    const counts = await sweep(Date.now() + 60_000, NOW);
    return `finished ${JSON.stringify(counts)}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  } finally {
    redis.pipeline = original;
    redis.clear();
  }
}

const SHAPES: [string, unknown][] = [
  ["no pipeline slot", []],
  ["a number", [1]],
  ["an object", [{}]],
  ["text", ["id"]],
  ["a list with a number", [[1]]],
  ["a list with nothing", [[null]]],
];

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("Control: empty queues read as lists finish with nothing to do");
  is("nothing due, nothing to delete", await run("SMEMBERS", [[]]), `finished ${JSON.stringify({ looked: 0, ready: 0, failed: 0, deleted: 0 })}`);

  for (const command of ["ZRANGEBYSCORE", "SMEMBERS"] as const) {
    part(`${command} answered in another shape: unknown, never "nothing to do"`);
    for (const [label, reply] of SHAPES) is(`${label}: unknown`, await run(command, reply), "unknown");
  }

  part("Control: the page past an unmoved video, read as a list, finishes");
  is("the unmoved video is not looked at again, nothing else is due", await runPastUnmoved(null), `finished ${JSON.stringify({ looked: 0, ready: 0, failed: 0, deleted: 0 })}`);

  part(`The page past the unmoved videos (ZRANGEBYSCORE ... LIMIT 0 41) answered in another shape: unknown, never "nothing to do"`);
  for (const [label, reply] of SHAPES) is(`${label}: unknown`, await runPastUnmoved(reply), "unknown");

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
