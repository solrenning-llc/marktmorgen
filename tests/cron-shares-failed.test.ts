/**
 * Issue #4146 (Codex U): the daily share job (app/api/cron/shares) answered `ok: false` with HTTP 200 when
 * settleShares counted a failed settlement, so a scheduler or monitor reading the status took the failed run for a
 * good one. Now a run with `failed > 0` keeps its counts and answers `error: "failed"` with HTTP 500, as the
 * affiliates, weekly and monthly jobs do; a clean run still answers 200.
 *
 * Synthetic only: the in-memory Redis; COMMISSION_LIVE and settleShares are stand-ins
 * (tests/aliases/cron-shares-failed.test.ts.json), so nothing is settled and no Stripe call is made.
 */
import { NextRequest } from "next/server";
import { GET as runJob } from "@/app/api/cron/shares/route";
import { next } from "./cron-shares-failed-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.CRON_SECRET = "cron-secret-shares-failed";
process.env.STRIPE_SECRET_KEY = "sk_test_cron_shares_failed";

type Answer = { ok?: boolean; error?: string; counts?: { failed?: number; fees?: number } };

async function run(): Promise<{ status: number; json: Answer }> {
  const response = await runJob(new NextRequest("https://marktmorgen.test/api/cron/shares", { headers: { authorization: "Bearer cron-secret-shares-failed" } }));
  return { status: response.status, json: (await response.json()) as Answer };
}

async function main(): Promise<void> {
  redis.clear();

  part("Control: a clean run answers 200 with its counts");
  next.counts = { ...next.counts, fees: 3, failed: 0 };
  const clean = await run();
  is("200, ok, the counts kept", [clean.status, clean.json.ok, clean.json.counts?.fees, clean.json.counts?.failed], [200, true, 3, 0]);

  part("A run with a failed settlement is not a success over HTTP (#4146)");
  next.counts = { ...next.counts, fees: 2, failed: 1 };
  const failed = await run();
  is("500, ok false, error failed, the counts kept", [failed.status, failed.json.ok, failed.json.error, failed.json.counts?.fees, failed.json.counts?.failed], [500, false, "failed", 2, 1]);

  part("The lock is let go after a failed run, so the next run is not busy");
  next.counts = { ...next.counts, fees: 0, failed: 0 };
  const after = await run();
  is("the next run settles", [after.status, after.json.ok], [200, true]);

  done();
}

void main();
