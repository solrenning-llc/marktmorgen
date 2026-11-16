/**
 * #3297, Claude 7's two MEDIUMs at 9c48904a3d.
 *
 *   MEDIUM 2: a week let go for another try (tryPeriodAgain) wrote the AI lead again on every run that reached it,
 *   each time one more of the creator's monthly AI writing jobs, though the email had already gone with the first
 *   lead. A post the channel keeps refusing (a deleted webhook, 404) spent up to three jobs a week. The lead is now
 *   written only on a period's first try.
 *
 * Synthetic store, sender, channel and AI; no network.
 */
import { NextRequest } from "next/server";
import { GET as weekly } from "@/app/api/cron/weekly/route";
import { control, ai, resetRetry, retry } from "./numbers-summary-retry-cost-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const TRIES = 3; // SUMMARY_TRIES in lib/stats-report.ts
const request = (path: string) => new NextRequest(`https://example.test${path}`);

function reset(): void {
  redis.clear();
  control.sent.length = 0;
  control.numbers = "visitors-5";
  resetRetry();
  ai.jobs = 0;
}

async function main(): Promise<void> {
  globalThis.fetch = async () => { throw new Error("No real network request belongs in a numbers-email route test"); };

  part("Control: the weekly AI lead is written once, on the week's one run");
  reset();
  retry.chat = "channel";
  await weekly(request("/api/cron/weekly"));
  is("one job, one post, one email", [ai.jobs, retry.posts.length, retry.mails.length], [1, 1, 1]);

  part(`A post the channel refuses every time: the week is tried by ${TRIES} runs, the AI lead written once`);
  reset();
  retry.chat = "channel";
  retry.postOk = false;
  for (let i = 1; i <= TRIES + 2; i += 1) await weekly(request("/api/cron/weekly"));
  is(`${TRIES} posts tried, one email`, [retry.posts.length, retry.mails.length], [TRIES, 1]);
  is("one AI job taken for the week, never one a try", ai.jobs, 1);

  part("An email refused every time: one AI job for the week");
  reset();
  retry.sendOk = () => false;
  for (let i = 1; i <= TRIES + 2; i += 1) await weekly(request("/api/cron/weekly"));
  is(`${TRIES} emails tried`, retry.mails.length, TRIES);
  is("one AI job taken for the week", ai.jobs, 1);
}

main().then(done, (error) => { console.error(error); process.exit(1); });
