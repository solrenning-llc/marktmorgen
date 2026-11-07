/**
 * Review proof for #3035: access reads must be admitted before Redis work,
 * and the admitted units must cover the exact bounded command count.
 * Synthetic in-memory Redis only.
 */
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { applyAccess } from "@/lib/student-bulk";
import { accessUnits } from "@/lib/student-bulk-rules";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "studentshop", "Student Shop", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, {
    customerId: "cus_BulkAdmission",
    subscriptionId: "sub_BulkAdmission",
    active: true,
    tier: "pro",
    period: paidPeriod(),
  });
  const owner = (await storeForEmail(OWNER))!;
  const courseId = "c".repeat(20);
  const studentsKey = `nl:course:${courseId}:students`;
  const emails = Array.from({ length: 100 }, (_, i) => `student${i}@example.com`);
  await redis.pipeline([
    ["HSET", studentsKey, ...emails.flatMap((email) => [
      emailKey(email),
      JSON.stringify({ e: email, s: 1, l: 1 }),
    ])],
  ]);

  const base = redis.pipeline;
  const events: string[] = [];
  let commandCount = 0;
  redis.pipeline = async (commands) => {
    commandCount += commands.length;
    events.push(...commands.map((command) => String(command[0])));
    return base.call(redis, commands);
  };
  let paidUnits = 0;
  const result = await applyAccess(
    owner,
    courseId,
    { change: "revoke", emails, expect: emails.length },
    async (units) => {
      paidUnits = units;
      events.push("pay");
      return { ok: true };
    },
  );
  redis.pipeline = base;

  part("Every bounded access read and write is admitted before it is spent");
  is(
    "admission happens before the first HMGET/SMISMEMBER access read",
    events.slice(0, 3),
    ["pay", "HMGET", "SMISMEMBER"],
  );
  is(
    "the admitted studio units cover every Redis command in the operation",
    [result.kind, paidUnits * 20 >= commandCount, paidUnits, commandCount],
    ["done", true, accessUnits(emails.length), 204],
  );
  done();
}

void main();
