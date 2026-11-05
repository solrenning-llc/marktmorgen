import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { callBeginnerQuestions } from "@/lib/call-faq";
import { planReminders, REMINDER_QUEUE, REMINDER_MIN_LEAD_MS } from "@/lib/call-records";
import { store as redis } from "./redis-stub";

const now = 1_800_000_000_000;
const hour = 3600_000;
const session = "cs_test_123456789012345678901234";
beforeEach(() => { redis.clear(); });

test("the FAQ describes planning and its lead condition, without promising delivery", () => {
  for (const onSale of [true, false]) {
    const answer = callBeginnerQuestions(onSale).find((item) => item.q === "Do paid calls work?")!.a;
    assert.ok(answer.includes("Reminders are planned for a day before and an hour before the call."));
    assert.ok(answer.includes("Each reminder must fall at least an hour after booking or moving the call."));
    assert.equal(answer.includes("The buyer gets a reminder"), false);
  }
});

for (const [label, delay, expected] of [
  ["far enough ahead", 48 * hour, 2],
  ["only the hour-before reminder is eligible", 3 * hour, 1],
  ["the minimum lead is included", hour + REMINDER_MIN_LEAD_MS, 1],
  ["a closer booking has no reminder to promise", hour + REMINDER_MIN_LEAD_MS - 1, 0],
] as const) {
  test(`the real planner agrees with the FAQ: ${label}`, async () => {
    await planReminders("calls-evidence", "harbor", session, now + delay, now);
    const [raw] = await redis.pipeline([["ZRANGEBYSCORE", REMINDER_QUEUE, 0, now + delay, "WITHSCORES"]]);
    assert.ok(Array.isArray(raw));
    assert.equal(raw.length, expected * 2);
    for (let i = 0; i < raw.length; i += 2) {
      assert.ok(Number(raw[i + 1]) - now >= REMINDER_MIN_LEAD_MS);
      assert.ok(String(raw[i]).includes(`|${session}|`));
    }
  });
}
