/**
 * The five-minute video job (lib/stream.ts, sweep) reads which videos are due
 * (ZRANGEBYSCORE) and which deleted videos are still to be taken off the
 * service (SMEMBERS). A reply to either that is not exactly one list of
 * strings is unknown, never "nothing to do": sweep throws UnknownReplyError,
 * so the cron answers ok: false instead of ok: true (issue #4287; Codex U,
 * stream queue read). Both read exactly as before when Redis answers lists.
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
let inject: { command: string; reply: unknown[] } | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (inject && commands.length === 1 && commands[0][0] === inject.command) {
    const reply = inject.reply;
    inject = null;
    return reply;
  }
  return original(commands);
}) as typeof redis.pipeline;

async function run(command: string | null, reply: unknown[] = []): Promise<string> {
  inject = command ? { command, reply } : null;
  try {
    await sweep(Date.now() + 30_000, NOW);
    return "done";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  } finally {
    inject = null;
  }
}

async function main(): Promise<void> {
  redis.clear();
  part("Control: Redis answers lists");
  is("the job runs through", await run(null), "done");

  for (const [command, what] of [["ZRANGEBYSCORE", "the due videos"], ["SMEMBERS", "the videos to delete"]] as const) {
    for (const [label, reply] of [
      ["no reply", []],
      ["a number", [7]],
      ["null", [null]],
      ["two replies", [[], []]],
      ["a list with a number in it", [["00000000-0000-4000-8000-000000000a01", 3]]],
    ] as const) {
      part(`${what} read as ${label}`);
      is("unknown, never nothing to do", await run(command, [...reply] as unknown[]), "unknown");
    }
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
