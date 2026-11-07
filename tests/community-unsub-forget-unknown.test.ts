/**
 * Proof, Claude 5 (CX-123 rules 24 and 30): forgetCommunityUnsub
 * (lib/community-mail.ts) is the erasure part for the record behind a deleted
 * member's unsubscribe link (lib/community-erasure.ts, lib/person-erasure.ts).
 * It read its DEL with Number(gone) || 0, so a reply of another shape was
 * reported as "0 records removed, finished", never as "could not finish".
 * Expected: every reply of another shape rejects, so the erasure lists this
 * part as not finished; an exact 0 or 1 (one key) still counts, and the real
 * delete on the stub still answers 1 then 0.
 */
import { forgetCommunityUnsub, unsubKey } from "@/lib/community-mail";
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

const TOKEN = "4c1f0b7e9a2d4e6f8b3c5a7d9e1f2a3b";

const BAD: [string, unknown][] = [
  ["undefined slot", [undefined]],
  ["null", [null]],
  ["text", ["1"]],
  ["unknown text", ["x"]],
  ["fractional", [0.5]],
  ["negative", [-1]],
  ["more than the one key", [2]],
  ["unsafe integer", [2 ** 53]],
  ["true", [true]],
  ["empty reply", []],
  ["second reply", [1, 1]],
  ["not a list", { result: 1 }],
];

void (async () => {
  for (const [label, bad] of BAD) {
    reply = bad;
    const got = await outcome(() => forgetCommunityUnsub(TOKEN));
    is(`forgetCommunityUnsub, ${label}: never reported as a finished count`, got, "rejected: UnknownReplyError");
  }
  reply = [1];
  is("forgetCommunityUnsub: the record removed is one", await forgetCommunityUnsub(TOKEN), 1);
  reply = [0];
  is("forgetCommunityUnsub: none there is none", await forgetCommunityUnsub(TOKEN), 0);
  reply = undefined;
  await redis.pipeline([["SET", unsubKey(TOKEN), "c1|m1|shop"]]);
  is("forgetCommunityUnsub, real delete: the stored record goes, one", await forgetCommunityUnsub(TOKEN), 1);
  is("forgetCommunityUnsub, real delete: the record is gone", (await redis.pipeline([["EXISTS", unsubKey(TOKEN)]]))[0], 0);
  is("forgetCommunityUnsub, real delete again: none", await forgetCommunityUnsub(TOKEN), 0);
  is("forgetCommunityUnsub: no token, nothing asked", await forgetCommunityUnsub(""), 0);
  done();
})();
