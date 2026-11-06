/**
 * Sweep APP4 proof (CX-123 rules 24/30), synthetic only: Redis is the in-memory double, the email provider a stand-in.
 *
 * app/api/cron/weekly/route.ts:72-84 — the week's claim (claimWeek) is taken BEFORE the numbers are read. When the
 * numbers cannot be read (readNumbers: lib/stats.ts readStats answers null when the traffic read is not known,
 * statsTrafficCoverage; or it throws, `.catch(() => null)`), `weeklyMessage` is never built, the store is counted
 * "quiet" (as if it had nothing to report), and the claim is KEPT for its 9 days: every later run that week skips
 * the store, so the creator's weekly email for that week is lost and the run's count says nothing went wrong.
 * Its sibling app/api/cron/monthly/route.ts:62-67 handles exactly this case with `releaseMonth` and counts it
 * "failed" (rule 30: the same defect fixed in one place is fixed everywhere).
 *
 * Healthy control: the numbers read, the email goes. DEFECT: the first run's traffic read answers in another shape;
 * a second run the same week, with Redis healthy again, still sends nothing.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeFolder, storeRef } from "@/lib/store";
import { monthKey } from "@/lib/delivery";
import { GET as weeklyCron } from "@/app/api/cron/weekly/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

process.env.RESEND_API_KEY = "re_test_sweep_app4_weekly";
process.env.STRIPE_SECRET_KEY = "sk_test_sweep_app4_weekly";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "sweep-app4-weekly@example.com";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;
// Amazon SES stand-in (tests/ses-mail-fixture.ts): every email the job sends is captured, nothing real is called.
const mail = installSesMailFixture({ fallback: globalThis.fetch });
const emails = mail.sent;

type Commands = (string | number)[][];

async function world(): Promise<string> {
  redis.clear();
  mail.reset();
  mail.configure();
  await claimHandle(OWNER, "app4-weekly-shop", "App4 Weekly Shop", "");
  const statsId = (await ensureStatsId(OWNER))!.statsId;
  await setSubscription(OWNER, { customerId: "cus_App4Weekly01", subscriptionId: "sub_App4Weekly01", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const folder = await storeFolder(storeRef(store));
  redis.run(["SET", `nl:store:folder-owner:${folder}`, OWNER]);
  redis.run(["SADD", `nl:traffic:folders:${monthKey(new Date())}`, folder]);
  const today = new Date().toISOString().slice(0, 10);
  redis.run(["PFADD", `nl:stats:${statsId}:${today}:u`, "visitor-a", "visitor-b"]);
  redis.run(["HSET", `nl:stats:${statsId}:${today}`, "v", 5]);
  return String(statsId);
}

async function run(unknownTraffic: string | null) {
  const real = redis.pipeline.bind(redis);
  if (unknownTraffic) {
    redis.pipeline = (async (commands: Commands) => {
      // readStats' one traffic pipeline (90 days of counts and visitors): answered in another shape.
      if (commands.length > 100 && commands[0][0] === "HGETALL" && String(commands[0][1]).startsWith(`nl:stats:${unknownTraffic}:`)) return [];
      return real(commands);
    }) as typeof redis.pipeline;
  }
  try {
    const response = await weeklyCron(new NextRequest("https://local.example/api/cron/weekly"));
    return (await response.json()) as { looked: number; sent: number; quiet: number; failed: number };
  } finally {
    redis.pipeline = real;
  }
}

async function main() {
  part("1. Healthy control: the week's numbers read, the weekly email goes once");
  await world();
  const healthy = await run(null);
  is("healthy: looked at, sent, one email", [healthy.looked, healthy.sent, healthy.quiet, emails.length], [1, 1, 0, 1]);

  part("1. DEFECT: the traffic read answers in another shape on the week's first run");
  const statsId = await world();
  const first = await run(statsId);
  is("DEFECT: counted 'quiet' (nothing to report), not 'failed'; nothing sent", [first.looked, first.quiet, first.failed, emails.length], [1, 1, 0, 0]);
  const second = await run(null);
  is("DEFECT: a later run the same week, Redis healthy again, skips the store: the week's email is lost", [second.looked, second.sent, emails.length], [0, 0, 0]);

  done();
}

void main();
