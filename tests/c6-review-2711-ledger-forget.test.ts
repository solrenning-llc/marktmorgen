/**
 * Review proof, Claude 6 on #2711 (head 5e88c15a), CX-123 rules 24 and 30.
 *
 * forgetLedgerCopy (lib/segments.ts) is the erasure part for the buyers' ledger
 * copy (lib/person-erasure.ts). It still reads its DEL with Number(gone) || 0, the
 * same shape #2711 fixes in forgetDiscordPerson: a reply of another shape is
 * reported as "0 records removed, finished", never as "could not finish".
 * Expected after a fix: every bad reply rejects; [1] and [0] still count.
 */
import { forgetLedgerCopy } from "@/lib/segments";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

let reply: unknown = undefined;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (reply !== undefined && commands.length === 1 && commands[0]?.[0] === "DEL") return reply as unknown[];
  return pipeline(commands);
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

const BAD: [string, unknown][] = [
  ["null", [null]],
  ["text", ["1"]],
  ["fractional", [0.5]],
  ["negative", [-1]],
  ["true", [true]],
  ["empty reply", []],
  ["second reply", [1, 1]],
  ["not a list", { result: 1 }],
];

void (async () => {
  for (const [label, bad] of BAD) {
    reply = bad;
    const got = await outcome(() => forgetLedgerCopy("3e762a4eb1d84c7ebe34c54b64158ce3"));
    is(`forgetLedgerCopy, ${label}: never reported as a finished count`, typeof got === "string" && got.startsWith("rejected:"), true);
  }
  reply = [1];
  is("forgetLedgerCopy: one removed is one", await forgetLedgerCopy("3e762a4eb1d84c7ebe34c54b64158ce3"), 1);
  reply = [0];
  is("forgetLedgerCopy: none there is none", await forgetLedgerCopy("3e762a4eb1d84c7ebe34c54b64158ce3"), 0);
  done();
})();
