/**
 * Audit proof, Claude 6 (rule 24 audit of lib/store-readings.ts), CX-123 rules 24 and 30.
 *
 * forgetReadingsPerson (lib/store-readings.ts) is the erasure part for the
 * studio's kept sales reading (which names the biggest buyers by address), the
 * kept memberships reading and the memberships' own cache (what members wrote
 * when they left): lib/person-erasure.ts. It read its DEL with Number(gone) || 0,
 * the shape already fixed next to it in forgetLedgerCopy (#2711): a reply of
 * another shape was reported as "0 copies removed, finished", so the erasure
 * said done while those copies, naming the person, might still be kept.
 * Expected: every bad reply rejects; [0] to [3] still count.
 */
import { forgetReadingsPerson } from "@/lib/store-readings";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const STATS = "3e762a4eb1d84c7ebe34c54b64158ce3";
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
  ["more than the three keys", [4]],
  ["true", [true]],
  ["empty reply", []],
  ["second reply", [1, 1]],
  ["not a list", { result: 1 }],
];

void (async () => {
  for (const [label, bad] of BAD) {
    reply = bad;
    const got = await outcome(() => forgetReadingsPerson(STATS));
    is(`forgetReadingsPerson, ${label}: never reported as a finished count`, typeof got === "string" && got.startsWith("rejected:"), true);
  }
  for (const n of [0, 1, 2, 3]) {
    reply = [n];
    is(`forgetReadingsPerson: ${n} removed is ${n}`, await forgetReadingsPerson(STATS), n);
  }
  // With the real stub: the three copies are there, and all go.
  reply = undefined;
  await redis.pipeline([["SET", `nl:reading:sales:${STATS}`, "{}"], ["SET", `nl:reading:members:${STATS}`, "{}"]]);
  is("forgetReadingsPerson: the kept copies there go, counted", await forgetReadingsPerson(STATS), 2);
  is("forgetReadingsPerson: none left is none", await forgetReadingsPerson(STATS), 0);
  done();
})();
