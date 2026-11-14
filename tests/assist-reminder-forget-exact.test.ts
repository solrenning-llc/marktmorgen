/**
 * The erasure of a person's checkout-reminder consents reads exactly (CX-123
 * rule 24; Claude 3 cloud I, erasure audit 14/11/2026).
 *
 * forgetAssistReminderPerson read the person's set of checkouts with
 * `Array.isArray(reply) ? reply : []`: a reply of another shape became "no
 * checkouts", and the DEL that followed still deleted the set, the only
 * thing that finds the consents. Each consent (nl:assist:remind:<checkout>)
 * keeps the typed address; it stayed, could no longer be found by a retry,
 * and the part answered 0, done. The DEL's count was read with `|| 0` too.
 * The copy (remindersOf) dropped what it could not read in the same way.
 * Now an unknown reply throws and nothing is deleted, so a retry finds all
 * of it. Synthetic data only.
 */
import { createHash } from "node:crypto";
import { forgetAssistReminderPerson, remindersOf } from "@/lib/assistant-reminder";
import { assistRemindKey } from "@/lib/assistant-reminder-rules";
import { store as redis, redisPipeline } from "./redis-stub";
import { done, is } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const STATS = "5d0c1f2e3a4b4c6d8e9f0a1b2c3d4e5f";
const EMAIL = "eve@example.com";
const SESSION = "cs_test_a1B2c3D4e5F6g7H8";
const who = `nl:assist:remindwho:${STATS}:${createHash("sha256").update(`nimbus-assist-remind:${STATS}:${EMAIL}`).digest("hex").slice(0, 32)}`;
const consent = JSON.stringify({ e: EMAIL, t: "Email me a reminder if I don't finish this order", v: "1", at: 1_800_000_000 });

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

async function seed(): Promise<void> {
  await redisPipeline([["DEL", who, assistRemindKey(SESSION)]]);
  await redisPipeline([["SET", assistRemindKey(SESSION), consent], ["SADD", who, SESSION]]);
}

void (async () => {
  for (const [label, reply] of [["null", [null]], ["a number", [3]], ["no reply", []]] as const) {
    await seed();
    bad = { command: "SMEMBERS", reply: [...reply] };
    is(`the checkouts read answered ${label}: the part is not finished`, await outcome(() => forgetAssistReminderPerson(STATS, EMAIL)), "rejected: UnknownReplyError");
    is(`the checkouts read answered ${label}: the copy is not given as complete`, await outcome(() => remindersOf(STATS, EMAIL)), "rejected: UnknownReplyError");
    bad = null;
    const [kept, listed] = await redisPipeline([["GET", assistRemindKey(SESSION)], ["SISMEMBER", who, SESSION]]);
    is(`${label}: the consent and what finds it are both still there for a retry`, [kept, listed], [consent, 1]);
  }
  await seed();
  bad = { command: "DEL", reply: [null] };
  is("the deletion answered null: the part is not finished", await outcome(() => forgetAssistReminderPerson(STATS, EMAIL)), "rejected: UnknownReplyError");
  bad = null;
  await seed();
  await redisPipeline([["SET", assistRemindKey(SESSION), "{"]]);
  is("a kept consent that does not read: the copy is not given as complete", await outcome(() => remindersOf(STATS, EMAIL)), "rejected: UnknownReplyError");
  await seed();
  is("a healthy erasure deletes the consent and its note", await forgetAssistReminderPerson(STATS, EMAIL), 2);
  done();
})();
