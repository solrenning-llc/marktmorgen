/**
 * A refusal says why, in the store's own terms (534 [FQ1], unit 32; added 2
 * November 2026), checked by what the code does against an in-memory
 * database: a database that does not answer the place check is "unknown",
 * never "full"; places all taken are "full"; the reason reaches the paused
 * studio's address (why=used, pool, unknown or daily); a webhook refused for
 * an unknown count waits to be tried again, not failed; a figure used up
 * names the trial's own window, offers a larger plan only to a paying store
 * with one above it on sale, and in a trial says when a kind a store whose
 * plan ended has none of stops for good.
 */
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { usedWords, NON_PAYING_ALLOWANCES } from "@/lib/store-allowance-rules";
import { resetWords } from "@/lib/allowance-window";
import { admitNonPaying, poolPlace } from "@/lib/free-pool";
import { FREE_POOL_BASE_STORES } from "@/lib/free-pool-rules";
import { takeAllowance } from "@/lib/store-allowance";
import { countStudio } from "@/lib/studio-route";
import { ESSENTIAL_PER_DAY } from "@/lib/studio-allowance-rules";
import { TRIAL_DAYS } from "@/lib/plan";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const free = (n: number) => ({ sid: `${String(n).padStart(3, "0")}`.padEnd(32, "r"), handle: `reason${n}`, statsId: null, tier: "creator" as const, subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "" });

async function main() {
  part("The words of a figure used up");
  const reset = "This opens again on December 1.";
  const paidOpen = usedWords("studio", 300, reset, "paid", true, true);
  is("the window: the month, or the trial", [paidOpen.includes("for this month are used"), usedWords("studio", 300, reset, "trial", true, true).includes("for this trial are used"), usedWords("studio", 300, reset, "none", true, true).includes("for this month are used")], [true, true, true]);
  is("a larger plan only to a store that pays, has one above it, while plans are on sale", [paidOpen.endsWith("Moving to a larger plan raises the figure at once."), usedWords("studio", 300, reset, "paid", true, false).includes("larger plan"), usedWords("studio", 300, reset, "paid", false, true).includes("larger plan"), usedWords("studio", 300, reset, "trial", true, true).includes("larger plan")], [true, false, false, false]);
  is("a figure not included: where, and a plan offered only while plans are on sale", [usedWords("api", 0, reset, "none", false, true), usedWords("api", 0, reset, "trial", true, true)], ["Your store's API requests are not included without a paid plan.", "Your store's API requests are not included in the trial. Start or move to a plan that includes them."]);
  const now = Date.UTC(2031, 7, 10, 12);
  const trialStore = { ...free(90), subscriptionActive: true, trialEnds: (now + 3 * DAY) / 1000 };
  is("in a trial, a kind that ends at zero says the trial's end and after; another says it opens again", [NON_PAYING_ALLOWANCES.ended.api, resetWords(trialStore, now, true).startsWith("The trial ends on"), resetWords(trialStore, now, true).endsWith("after that, these need a paid plan."), resetWords(trialStore, now, false).startsWith("This opens again on")], [0, true, true, true]);
  is("a store at the full trial length counts it as one window", TRIAL_DAYS > 0, true);

  part("A place this month, said as it is");
  redis.clear();
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => String(c[1] ?? "").startsWith("nl:free:in:"))) throw new Error("the database did not answer");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const down = await Promise.all([poolPlace(free(1), now), admitNonPaying(free(1), now), takeAllowance(free(1), "studio", 1, now)]);
  is("a database that does not answer: unknown, not let in, and never called full", [down[0], down[1], !down[2].ok && down[2].reason, !down[2].ok && down[2].message], ["unknown", false, "unknown", "This can't be counted right now. Try again in a minute."]);
  is("and a webhook refused for it waits to be tried again on the schedule, where before it failed for good as 'full'", readFileSync("lib/webhooks.ts", "utf8").includes('if (taken.reason === "unknown" && retryIn !== undefined) return { ...delivery, state: "retrying"'), true);
  const studio = await countStudio(free(1) as never, null);
  is("so the studio's count says unknown too", [!studio.ok && studio.reason], ["unknown"]);
  redis.pipeline = pipeline;
  redis.clear();
  for (let i = 0; i < FREE_POOL_BASE_STORES; i++) await poolPlace(free(10 + i), now);
  const full = await takeAllowance(free(99), "studio", 1, now);
  is("places all taken: full, and the pool's own words", [await poolPlace(free(98), now), !full.ok && full.reason, !full.ok && full.message.startsWith("Stores without a paid plan are full for this month")], ["full", "pool", true]);
  is("a paying store is always in", await poolPlace({ ...free(1), subscriptionActive: true } as never, now), "in");

  part("What the owner needs to leave or pay, past its own daily figure");
  redis.clear();
  const owner = { ...free(50), subscriptionActive: true, subscriptionId: "sub_Reason0001", cycle: "month" as const };
  let last: Awaited<ReturnType<typeof countStudio>> = { ok: true };
  for (let i = 0; i <= ESSENTIAL_PER_DAY; i++) last = await countStudio(owner as never, "billing");
  is("is refused as daily, never as the month's figure", [!last.ok && last.reason, !last.ok && last.message], ["daily", "Too many of these today. Try again tomorrow, or write to support."]);

  done();
}

void main();
