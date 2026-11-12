/**
 * Proof, Claude 5 (sweep app 3, CX-123 rules 24 and 30): forgetWelcomePerson
 * (lib/welcome-offer-send.ts) is the erasure part for when a person's welcome
 * offer began and that their reminder was set (lib/person-erasure.ts). It read
 * its DEL with Number(gone) || 0, so a reply of another shape was reported as
 * "0 records removed, finished", never as "could not finish".
 * Expected: every reply of another shape rejects, so the erasure lists this
 * part as not finished; an exact 0, 1 or 2 (two keys) still counts.
 */
import { forgetWelcomePerson } from "@/lib/welcome-offer-send";
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

const STATS = "3e762a4eb1d84c7ebe34c54b64158ce3";
const EMAIL = "buyer@example.com";

const BAD: [string, unknown][] = [
  ["null", [null]],
  ["text", ["1"]],
  ["fractional", [0.5]],
  ["negative", [-1]],
  ["more than the two keys", [3]],
  ["true", [true]],
  ["empty reply", []],
  ["second reply", [1, 1]],
  ["not a list", { result: 1 }],
];

void (async () => {
  for (const [label, bad] of BAD) {
    reply = bad;
    const got = await outcome(() => forgetWelcomePerson(STATS, EMAIL));
    is(`forgetWelcomePerson, ${label}: never reported as a finished count`, got, "rejected: UnknownReplyError");
  }
  reply = [2];
  is("forgetWelcomePerson: both keys removed is two", await forgetWelcomePerson(STATS, EMAIL), 2);
  reply = [1];
  is("forgetWelcomePerson: one removed is one", await forgetWelcomePerson(STATS, EMAIL), 1);
  reply = [0];
  is("forgetWelcomePerson: none there is none", await forgetWelcomePerson(STATS, EMAIL), 0);
  reply = undefined;
  is("forgetWelcomePerson: no store id, nothing asked", await forgetWelcomePerson(null, EMAIL), 0);
  done();
})();
