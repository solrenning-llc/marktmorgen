/**
 * The erasure of a person's invitations to keep a membership reads exactly
 * (CX-123 rule 24; Claude 3 cloud I, erasure audit 14/11/2026).
 *
 * forgetInvitesPerson read the invitations with `Array.isArray(rows) ? rows[i]
 * : null`: a reply of another shape, or a kept invitation that does not
 * read, became "no invitation", the part answered 0, done, and the
 * invitation (with the address), its link and its reminder stayed. The
 * replies of the deletions were never read either. Now an unknown reply
 * throws, so the part is said as not finished. Synthetic data only.
 */
import { forgetInvitesPerson, inviteField, linkKey } from "@/lib/move-members";
import { store as redis, redisPipeline } from "./redis-stub";
import { done, is } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const STORE = { sid: "sid_mv_audit", statsId: "6e1d2c3b4a594f8e9d0c1b2a3f4e5d6c" };
const EMAIL = "member@example.com";
const PRODUCT = "prod_mv_1";
const TOKEN = "c".repeat(40);
const invite = JSON.stringify({ e: EMAIL, p: PRODUCT, o: "", r: 2900, job: "", at: 1_800_000_000, t: TOKEN, kept: 0 });
const field = inviteField(EMAIL, PRODUCT);

let bad: { command: string; reply: unknown[] } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (bad && commands[0]?.[0] === bad.command) return bad.reply;
  return pipeline(commands);
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

async function seed(value = invite): Promise<void> {
  await redisPipeline([["DEL", `nl:mv:${STORE.statsId}`, linkKey(TOKEN), "nl:mv:due"]]);
  await redisPipeline([["HSET", `nl:mv:${STORE.statsId}`, field, value], ["SET", linkKey(TOKEN), "1"], ["ZADD", "nl:mv:due", "2000000000", `${STORE.sid}|${field}`]]);
}

void (async () => {
  for (const [label, reply] of [["null", [null]], ["a short list", [[]]], ["no reply", []]] as const) {
    await seed();
    bad = { command: "HMGET", reply: [...reply] };
    is(`the invitations read answered ${label}: the part is not finished`, await outcome(() => forgetInvitesPerson(STORE, [PRODUCT], EMAIL)), "rejected: UnknownReplyError");
    bad = null;
  }
  await seed("{not json");
  is("a kept invitation that does not read: the part is not finished", await outcome(() => forgetInvitesPerson(STORE, [PRODUCT], EMAIL)), "rejected: UnknownReplyError");
  await seed();
  bad = { command: "HDEL", reply: [null, 1, 1] };
  is("the deletion answered in another shape: the part is not finished", await outcome(() => forgetInvitesPerson(STORE, [PRODUCT], EMAIL)), "rejected: UnknownReplyError");
  bad = null;
  await seed();
  is("a healthy erasure takes the invitation out", await forgetInvitesPerson(STORE, [PRODUCT], EMAIL), 1);
  const [left, link, due] = await redisPipeline([["HGET", `nl:mv:${STORE.statsId}`, field], ["EXISTS", linkKey(TOKEN)], ["ZSCORE", "nl:mv:due", `${STORE.sid}|${field}`]]);
  is("the invitation, its link and its reminder are gone", [left, link, due], [null, 0, null]);
  is("nothing left the second time", await forgetInvitesPerson(STORE, [PRODUCT], EMAIL), 0);
  done();
})();
