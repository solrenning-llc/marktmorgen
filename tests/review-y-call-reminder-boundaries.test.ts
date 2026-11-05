import assert from "node:assert/strict";
import { test } from "node:test";
import { callBeginnerQuestions } from "@/lib/call-faq";
import { planReminders, unplanReminders, REMINDER_QUEUE } from "@/lib/call-records";
import { store as redis } from "./redis-stub";

const now = 1_800_000_000_000, hour = 3_600_000;
const session = "cs_test_reviewYreminder000001";
const scores = () => redis.run(["ZRANGEBYSCORE", REMINDER_QUEUE, 0, "+inf", "WITHSCORES"]) as (string | number)[];

test("the FAQ describes planned reminders while retaining the closed-sales notice", () => {
  for (const onSale of [false, true]) {
    const text = callBeginnerQuestions(onSale).find(row => row.q === "Do paid calls work?")!.a;
    assert.match(text, /Reminders are planned/);
    assert.doesNotMatch(text, /The buyer gets a reminder/);
    assert.equal(text.includes("Paid plans are not on sale yet"), !onSale);
    assert.match(text, /at least an hour after booking or moving/);
  }
});

test("both actual reminder boundaries hold at the exact millisecond", async () => {
  for (const [delay, hoursBefore] of [
    [2 * hour - 1, []], [2 * hour, [1]], [2 * hour + 1, [1]],
    [25 * hour - 1, [1]], [25 * hour, [24, 1]], [25 * hour + 1, [24, 1]],
  ] as const) {
    redis.clear();
    await planReminders("review-y", "harbor", session, now + delay, now);
    const actual = scores().filter((_, i) => i % 2 === 1).map(Number).sort((a, b) => a - b);
    assert.deepEqual(actual, hoursBefore.map(before => now + delay - before * hour).sort((a, b) => a - b));
    assert.ok(actual.every(at => at - now >= hour));
  }
  redis.clear();
  await planReminders("review-y", "harbor", session, now + 48 * hour, now);
  assert.equal(scores().length, 4);
  await unplanReminders("review-y", "harbor", session, now + 48 * hour);
  await planReminders("review-y", "harbor", session, now + 2 * hour - 1, now);
  assert.deepEqual(scores(), []);
});
