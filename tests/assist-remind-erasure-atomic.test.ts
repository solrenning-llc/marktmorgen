/**
 * Review of #4483 (Codex X5, ALTO, erasure): forgetAssistReminderPerson read the person's list of reminder sessions
 * with one SMEMBERS and deleted with a second call. A list read in part (a reply that is formally a list, but holds
 * only some of the sessions) deleted the index and only the consents it named, so the rest of the consents, which
 * still hold the erased address, were no longer found by any later try, and the reminder queue could still send to
 * them. A member that is not a session was skipped while the whole index was deleted, with the same result. Now the
 * list is read, checked and deleted in one Redis step: a member that is not a session deletes nothing and is
 * unknown, so the erasure stays open and runs again.
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
const statsId = "c".repeat(32);
const email = "erased-atomic@example.com";
const a = `cs_test_${"a".repeat(24)}`;
const b = `cs_test_${"b".repeat(24)}`;
const who = `nl:assist:remindwho:${statsId}:${createHash("sha256").update(`nimbus-assist-remind:${statsId}:${email}`).digest("hex").slice(0, 32)}`;
const consent = (session: string) => ["SET", assistRemindKey(session), JSON.stringify({ s: statsId, e: email, t: "Remind me", v: "v1", l: "en", at: 1 }), "EX", 259200];

async function outcomeOf(): Promise<string> {
  try {
    return `resolved ${await forgetAssistReminderPerson(statsId, email)}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "rejected" : `other ${String(error)}`;
  }
}

const left = async (keys: string[]) => (await redis.pipeline(keys.map((key) => ["EXISTS", key]))).map(Number);

async function main(): Promise<void> {
  part("A list of sessions read in part never leaves a consent behind the deleted index");
  redis.clear();
  await redis.pipeline([consent(a), consent(b), ["SADD", who, a, b]]);
  const original = redis.pipeline.bind(redis);
  // A reply that is a list, but holds only one of the two sessions: as a lost or cut reply would look.
  redis.pipeline = (async (commands: Commands) => (commands.length === 1 && commands[0][0] === "SMEMBERS" && commands[0][1] === who ? [[a]] : original(commands))) as typeof redis.pipeline;
  const partial = await outcomeOf();
  redis.pipeline = original;
  is("both consents and the index are gone", await left([assistRemindKey(a), assistRemindKey(b), who]), [0, 0, 0]);
  is("and the erasure says what it deleted", partial, "resolved 3");

  part("A member that is not a session deletes nothing and keeps the erasure open");
  redis.clear();
  const odd = "cs_test_short";
  await redis.pipeline([consent(a), consent(odd), ["SADD", who, a, odd]]);
  is("rejected as unknown", await outcomeOf(), "rejected");
  is("nothing was deleted, so the next try still finds every consent", await left([assistRemindKey(a), assistRemindKey(odd), who]), [1, 1, 1]);

  part("Control: a confirmed erasure of two consents deletes both and the index");
  redis.clear();
  await redis.pipeline([consent(a), consent(b), ["SADD", who, a, b]]);
  is("resolved with the three keys", await outcomeOf(), "resolved 3");
  is("nothing is left", await left([assistRemindKey(a), assistRemindKey(b), who]), [0, 0, 0]);

  part("Control: nobody to forget");
  redis.clear();
  is("resolved with none", await outcomeOf(), "resolved 0");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
