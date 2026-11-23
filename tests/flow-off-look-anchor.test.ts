/**
 * Board #5285, row #3428: Claude 3's LOW of 6786137236 (the same as on #3416). A workflow step whose store is
 * switched off is looked at early, a day after the hold began, so a short switch-off holds it a day at most
 * (lib/flow-retry.ts, nextTry). That first look was anchored to when the step began to wait for ANY reason, so a step
 * that had already waited 2 days for the month's allowance, then found its store switched off, skipped the early look
 * and was held 8.25 days (16.5 with one more wait in the run). The run's record now keeps when this step was first
 * looked at while its store was switched off (offAt, lib/flow-runs.ts WAIT_IF_RUN v4), and the early look counts from
 * it; the step's day clock (since) still bounds the whole wait (MAX_WAIT_DAYS_PER_STEP).
 *
 * Synthetic run records; Redis is lib/redis-memory.ts.
 */
import { SWITCHED_OFF_FIRST_LOOK_SECONDS, nextTry } from "@/lib/flow-retry";
import { countWaits, openRuns } from "@/lib/flow-runs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const FLOW = "a".repeat(12);
const now = Math.floor(Date.now() / 1000);

async function main(): Promise<void> {
  part("nextTry: the early look counts from the first switched-off look");
  const known = (since: number, offSince?: number) => ({ since, ...(offSince === undefined ? {} : { offSince }) }) as { since: number };
  is("control: a step that began to wait now looks a day later, as before", nextTry("switched_off", 1, now, known(now, now)), now + SWITCHED_OFF_FIRST_LOOK_SECONDS);
  is("a step that waited 2 days for the allowance, first looked at switched off now (n 3): a day later, not 8.25 days", nextTry("switched_off", 3, now, known(now - 2 * DAY, now)), now + SWITCHED_OFF_FIRST_LOOK_SECONDS);
  is("with one more wait in the run (n 5): still a day later, not 16.5 days", nextTry("switched_off", 5, now, known(now - 2 * DAY, now)), now + SWITCHED_OFF_FIRST_LOOK_SECONDS);
  const later = nextTry("switched_off", 4, now, known(now - 3 * DAY, now - DAY - 60));
  is("control: past its early look, the looks left share the step's own days, counted from since, as before", later, nextTry("switched_off", 4, now, known(now - 3 * DAY)));

  part("countWaits: the run's record keeps when this step was first looked at switched off");
  redis.clear();
  const email = "off-look@example.com";
  await openRuns(FLOW, [email], now - 2 * DAY);
  const whole = (await countWaits(FLOW, [email], 0, now - 2 * DAY)).get(email);
  is("control: a whole wait reads as before, with no switched-off look", whole, { waits: 1, offLooks: 0, since: now - 2 * DAY });
  const first = (await countWaits(FLOW, [email], 0, now, true)).get(email);
  is("the first switched-off look: the step's clock from its first wait, the switched-off one from now", [first?.since, (first as { offSince?: number } | null)?.offSince], [now - 2 * DAY, now]);
  const second = (await countWaits(FLOW, [email], 0, now + DAY, true)).get(email);
  is("the next look keeps both", [second?.since, (second as { offSince?: number } | null)?.offSince], [now - 2 * DAY, now]);
  const next = (await countWaits(FLOW, [email], 1, now + 2 * DAY, true)).get(email);
  is("a later step's first switched-off look starts its own", (next as { offSince?: number } | null)?.offSince, now + 2 * DAY);
  done();
}

void main();
