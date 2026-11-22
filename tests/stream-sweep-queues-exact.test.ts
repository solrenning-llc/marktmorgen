/**
 * Issue #4287, item 7 (Codex U, `U-20261112-1836-stream-queue-read.md`; rule 24): the five-minute video job
 * (lib/stream.ts sweep) read its two queues loosely. A reply to the due queue's ZRANGEBYSCORE, or to the to-delete
 * set's SMEMBERS, that was not a list became [], and members that were not text were skipped, so the job answered
 * "nothing to do" (and the cron ok: true) while it had read nothing. Now each reply is read exactly: a list of text,
 * or UnknownReplyError, which the cron (app/api/cron/stream/route.ts) answers as a failed part.
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

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
