import { planReminders, unplanReminders, REMINDER_QUEUE } from "@/lib/call-records";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const now = 1_800_000_000_000, hour = 3_600_000;
const session = "cs_test_123456789012345678901234";
async function planned(): Promise<unknown[]> {
  const [rows] = await redis.pipeline([["ZRANGEBYSCORE", REMINDER_QUEUE, 0, "+inf", "WITHSCORES"]]);
  if (!Array.isArray(rows)) throw Error("Unknown synthetic queue");
  return rows;
}
async function main(): Promise<void> {
  part("Independent one-millisecond boundaries around both planned reminders");
  for (const [delay, count] of [
    [-hour, 0], [0, 0], [hour, 0], [2 * hour - 1, 0], [2 * hour, 1], [2 * hour + 1, 1],
    [24 * hour, 1], [25 * hour - 1, 1], [25 * hour, 2], [25 * hour + 1, 2], [48 * hour, 2],
  ] as const) {
    redis.clear();
    await planReminders("review-calls", "harbor", session, now + delay, now);
    const rows = await planned();
    is(`delay ${delay}: number of reminders`, rows.length / 2, count);
    is(`delay ${delay}: every planned time respects the minimum lead`, rows.filter((_, i) => i % 2 === 1).every(score => Number(score) >= now + hour), true);
  }
  part("Moving the call removes the old plan and uses the new booking time");
  redis.clear();
  await planReminders("review-calls", "harbor", session, now + 48 * hour, now);
  is("two initial reminders", (await planned()).length, 4);
  await unplanReminders("review-calls", "harbor", session, now + 48 * hour);
  await planReminders("review-calls", "harbor", session, now + 2 * hour - 1, now);
  is("moving closer leaves neither old nor ineligible new reminder", await planned(), []);
  await planReminders("review-calls", "harbor", session, now + 25 * hour, now);
  is("moving far enough away includes both again", (await planned()).length, 4);
}
void main().then(done).catch(error => { console.error(error); process.exit(1); });
