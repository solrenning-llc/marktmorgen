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
let mark: string | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  // Rule 23, changed with review L2 on #2998: the DEL now goes in one round trip after the GET of the
  // reminder mark (which second of the queue to read), so the stand-in answers that pipeline: no mark
  // (null), then the DEL reply under test. Every case below still tests the DEL reply alone.
  // Rule 23 again, with the review note on #2998 (the mark and the queue racing an erasure): the mark is
  // now read and deleted at once (GETDEL) and the DEL takes only the start, so the stand-in answers that
  // pipeline. "Both keys removed" is now the mark there ("1", written before it held a time) and the
  // start deleted; the bound on the DEL is one key, so 2 joins the replies of another shape.
  if (reply !== undefined && commands.length === 2 && commands[0]?.[0] === "GETDEL" && commands[1]?.[0] === "DEL") return (Array.isArray(reply) ? [mark, ...reply] : reply) as unknown[];
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
  ["more than the one key it deletes now", [2]],
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
  reply = [1];
  mark = "1";
  is("forgetWelcomePerson: both keys removed is two", await forgetWelcomePerson(STATS, EMAIL), 2);
  mark = null;
  reply = [1];
  is("forgetWelcomePerson: one removed is one", await forgetWelcomePerson(STATS, EMAIL), 1);
  reply = [0];
  is("forgetWelcomePerson: none there is none", await forgetWelcomePerson(STATS, EMAIL), 0);
  reply = undefined;
  is("forgetWelcomePerson: no store id, nothing asked", await forgetWelcomePerson(null, EMAIL), 0);
  done();
})();
