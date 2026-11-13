/**
 * Issue #4380 (erasure, HIGH, Codex L): forgetAssistReminderPerson read its SMEMBERS reply as an empty list
 * whenever it was not an array, deleted only the index, and answered the DEL count as success: the consent still
 * holding the erased address stayed, and the reminder queue (which reads the consent by its session) could send
 * to it. Now the member list and the DEL count are read exactly; anything else throws UnknownReplyError, so the
 * erasure stays open and is run again.
 *
 * Synthetic in-memory Redis only.
 */
import { createHash } from "node:crypto";
import { forgetAssistReminderPerson } from "@/lib/assistant-reminder";
import { assistRemindKey } from "@/lib/assistant-reminder-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const statsId = "a".repeat(32);
const email = "erased@example.com";
const session = `cs_test_${"b".repeat(24)}`;
const consentKey = assistRemindKey(session);
const who = `nl:assist:remindwho:${statsId}:${createHash("sha256").update(`nimbus-assist-remind:${statsId}:${email}`).digest("hex").slice(0, 32)}`;

async function run(answer: { command: string; reply: unknown[] } | null): Promise<{ outcome: string; consent: unknown }> {
  redis.clear();
  await redis.pipeline([
    ["SET", consentKey, JSON.stringify({ s: statsId, e: email, t: "Remind me", v: "v1", l: "en", at: 1 }), "EX", 259200],
    ["SADD", who, session],
  ]);
  const original = redis.pipeline.bind(redis);
  if (answer) redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === answer.command ? answer.reply : original(commands))) as typeof redis.pipeline;
  let outcome: string;
  try {
    outcome = `resolved ${await forgetAssistReminderPerson(statsId, email)}`;
  } catch (error) {
    outcome = error instanceof UnknownReplyError ? "rejected" : `other ${String(error)}`;
  } finally {
    redis.pipeline = original;
  }
  return { outcome, consent: (await redis.pipeline([["GET", consentKey]]))[0] };
}

async function main(): Promise<void> {
  part("Control: a confirmed erasure deletes the consent and the index");
  const ok = await run(null);
  is("resolved with both deleted", [ok.outcome, ok.consent], ["resolved 2", null]);

  part("Rule 24: an unreadable member list is unknown, never no reminders");
  for (const [what, reply] of [
    ["a number instead of the list", [42]],
    ["no reply", []],
    ["a list holding a number", [[1]]],
    ["two replies", [[session], [session]]],
  ] as const) {
    const r = await run({ command: "SMEMBERS", reply: reply as unknown as unknown[] });
    is(`${what}: rejected`, r.outcome, "rejected");
  }

  part("Rule 24: the DEL's count read exactly");
  for (const [what, reply] of [
    ["not a number", ["OK"]],
    ["more than it was sent", [9]],
    ["no reply", []],
  ] as const) {
    const r = await run({ command: "DEL", reply: reply as unknown as unknown[] });
    is(`${what}: rejected`, r.outcome, "rejected");
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
