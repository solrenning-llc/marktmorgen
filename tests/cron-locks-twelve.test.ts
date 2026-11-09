/**
 * The twelve cron jobs' one-run-at-a-time locks read exactly (CX-123 rules 24 and 30; sweep APP4 findings 1 and 3).
 *
 * plans, closing, affiliates, imports, closed-data, recount, monthly, weekly, stripe-check, shares, stream and
 * mail-check took their lock with SET NX, read only nil as "another run holds it" and anything else (no reply, a
 * reply in another shape) as theirs, and let go with a plain DEL whoever held it. So a lost answer let a job run
 * beside another run of itself (payment-plan charges, affiliate payouts, plan refunds, closed-store erasure) and
 * delete that run's lock. They now read the lock as lot L10a's jobs do (lib/claim-mark.ts) and as Claude 4's fix of
 * cron/mail does: "OK", or this run's own value read back, is ours; nil, or another value read back, is busy; any
 * other answer is unknown, answered 503 `lock_unknown`, nothing run and nothing let go. At the end a run lets go of
 * its lock only while it still holds its own value (releaseMark, one compare-and-delete script).
 *
 * Also the weekly job (finding 3): when a store's numbers cannot be read, the week's claim is let go and the store
 * is counted "failed", as the monthly job does, so a later run that week sends the email.
 *
 * Synthetic only: Redis is the in-memory double, Stripe, Bunny and the email provider are stand-ins.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET as plansCron } from "@/app/api/cron/plans/route";
import { GET as closingCron } from "@/app/api/cron/closing/route";
import { GET as affiliatesCron } from "@/app/api/cron/affiliates/route";
import { GET as importsCron } from "@/app/api/cron/imports/route";
import { GET as closedDataCron } from "@/app/api/cron/closed-data/route";
import { GET as recountCron } from "@/app/api/cron/recount/route";
import { GET as monthlyCron } from "@/app/api/cron/monthly/route";
import { GET as weeklyCron } from "@/app/api/cron/weekly/route";
import { GET as stripeCheckCron } from "@/app/api/cron/stripe-check/route";
import { GET as streamCron } from "@/app/api/cron/stream/route";
import { GET as mailCheckCron } from "@/app/api/cron/mail-check/route";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeFolder, storeRef } from "@/lib/store";
import { monthKey } from "@/lib/delivery";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

delete process.env.CRON_SECRET;
process.env.STRIPE_SECRET_KEY = "sk_test_cron_locks_twelve_stand_in";
process.env.STRIPE_DEMO_SECRET_KEY = "sk_test_cron_locks_twelve_demo_stand_in";
process.env.RESEND_API_KEY = "re_test_cron_locks_twelve_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.BUNNY_STREAM_LIBRARY_ID = "4242";
process.env.BUNNY_STREAM_API_KEY = "a-stand-in-api-key-for-tests-only";
process.env.BUNNY_STREAM_TOKEN_KEY = "a-stand-in-token-key-for-tests-only";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;
// Amazon SES stand-in (tests/ses-mail-fixture.ts): every email a job sends is captured, nothing real is called.
const mail = installSesMailFixture({ fallback: globalThis.fetch });

type Commands = (string | number)[][];
type Job = (request: NextRequest) => Promise<Response>;

/** Jobs whose whole body runs against an empty world here: a free run, a lost answer whose write landed, and a lock
 * taken over mid-run are shown on these too. */
const FULL: [string, string, Job][] = [
  ["plans", "nl:plans:lock", plansCron as Job],
  ["closing", "nl:closing:lock", closingCron as Job],
  ["affiliates", "nl:aff:payday:lock", affiliatesCron as Job],
  ["imports", "nl:imports:lock", importsCron as Job],
  ["closed-data", "nl:closed:lock", closedDataCron as Job],
  ["recount", "nl:recount:lock", recountCron as Job],
  ["monthly", "nl:monthly:lock", monthlyCron as Job],
  ["weekly", "nl:weekly:lock", weeklyCron as Job],
];
/** Jobs whose bodies call Stripe's demo account, Bunny or the mail checker: the lock's own answers are shown, and on
 * stripe-check and mail-check also a slow run whose lock the next run took (their checks fail fast on the stand-ins). */
const LOCK_ONLY: [string, string, Job][] = [
  ["stripe-check", "nl:stripe-check:lock", stripeCheckCron as Job],
  ["stream", "nl:stream:lock", streamCron as Job],
  ["mail-check", "nl:mail-check:lock", mailCheckCron as Job],
];

const MALFORMED: [string, unknown][] = [
  ["no reply at all", []],
  ["QUEUED", ["QUEUED"]],
  ["a number", [1]],
];

type Outcome = { status: number; busy: boolean; error: unknown; ran: number; lockAfter: unknown };

/**
 * Runs one job. `holder`: the value another run already holds the lock with (null: nobody). `reply`: what the lock's
 * own SET NX answers (undefined: Redis's own answer); `landed`: the SET is applied before the odd answer is given.
 * `takeOver`: once the job starts work, its lock runs out and the next run takes it with this value.
 */
async function run(name: string, lock: string, GET: Job, options: { holder?: string | null; reply?: unknown; landed?: boolean; takeOver?: string } = {}): Promise<Outcome> {
  redis.clear();
  mail.reset();
  if (options.holder) redis.run(["SET", lock, options.holder, "EX", 300]);
  const real = redis.pipeline.bind(redis);
  let answered = false;
  let ran = 0;
  let tookOver = false;
  const onLock = (command: (string | number)[]) => command.slice(1).includes(lock);
  redis.pipeline = (async (commands: Commands) => {
    const first = commands[0];
    if (!answered && first?.[0] === "SET" && first?.[1] === lock) {
      answered = true;
      if (options.reply === undefined) return real(commands);
      if (options.landed) await real(commands);
      return options.reply;
    }
    if (!commands.every(onLock)) {
      ran += 1;
      if (options.takeOver && !tookOver) {
        tookOver = true;
        redis.run(["SET", lock, options.takeOver, "EX", 300]);
      }
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let response: Response | null = null;
  try {
    // A job that wrongly runs its body against stand-ins is cut short here, so the check still answers.
    response = await Promise.race([
      GET(new NextRequest(`https://local.example/api/cron/${name}`)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000).unref()),
    ]);
  } catch {
    response = null;
  } finally {
    redis.pipeline = real;
  }
  const body = (response ? await response.json().catch(() => ({})) : {}) as { busy?: boolean; error?: unknown };
  return { status: response?.status ?? -1, busy: body.busy === true, error: body.error, ran, lockAfter: redis.run(["GET", lock]) };
}

async function weeklyWorld(owner: string): Promise<string> {
  redis.clear();
  mail.reset();
  mail.configure();
  await claimHandle(owner, "cron-locks-weekly", "Cron Locks Weekly", "");
  const statsId = (await ensureStatsId(owner))!.statsId;
  await setSubscription(owner, { customerId: "cus_CronLocksWeekly1", subscriptionId: "sub_CronLocksWeekly1", active: true, period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const folder = await storeFolder(storeRef(store));
  redis.run(["SET", `nl:store:folder-owner:${folder}`, owner]);
  redis.run(["SADD", `nl:traffic:folders:${monthKey(new Date())}`, folder]);
  const today = new Date().toISOString().slice(0, 10);
  redis.run(["PFADD", `nl:stats:${statsId}:${today}:u`, "visitor-a", "visitor-b"]);
  redis.run(["HSET", `nl:stats:${statsId}:${today}`, "v", 5]);
  return String(statsId);
}

async function weeklyRun(unknownTraffic: string | null) {
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

async function main(): Promise<void> {
  for (const [name, lock, GET] of [...FULL, ...LOCK_ONLY]) {
    part(`cron/${name}: another run holds ${lock}`);
    const busy = await run(name, lock, GET, { holder: "another-run" });
    is("Redis answers nil: busy, nothing run, the other run's lock kept", [busy.status, busy.busy, busy.ran, busy.lockAfter], [200, true, 0, "another-run"]);
    for (const [label, reply] of MALFORMED) {
      const held = await run(name, lock, GET, { holder: "another-run", reply });
      // Before: anything but nil was read as ours, the job ran, and its finally deleted the other run's lock.
      is(`answered ${label}: read back as another run's, busy, nothing run, its lock kept`, [held.status, held.busy, held.ran, held.lockAfter], [200, true, 0, "another-run"]);
      const free = await run(name, lock, GET, { reply });
      // Before: read as ours and run. Now: not read back as ours, so unknown: 503 lock_unknown, nothing run.
      is(`not held, answered ${label} and not landed: unknown, 503, nothing run, nothing left`, [free.status, free.error, free.ran, free.lockAfter], [503, "lock_unknown", 0, null]);
    }
  }

  for (const [name, lock, GET] of FULL) {
    part(`cron/${name}: a run that is its own`);
    const healthy = await run(name, lock, GET);
    is("Redis answers OK: the job runs and lets its own lock go", [healthy.status, healthy.ran > 0, healthy.lockAfter], [200, true, null]);
    const landed = await run(name, lock, GET, { reply: [], landed: true });
    is("the answer was lost but the write landed: read back as ours, run, and let go", [landed.status, landed.ran > 0, landed.lockAfter], [200, true, null]);
    const overtaken = await run(name, lock, GET, { takeOver: "the-next-run" });
    // Before: its finally deleted whoever held the lock, here the next run's.
    is("its lock ran out and the next run took it: the next run's lock is kept", [overtaken.ran > 0, overtaken.lockAfter], [true, "the-next-run"]);
  }

  // stripe-check and mail-check against stand-ins: Stripe's demo account and the mail checker answer nothing useful
  // here, so their checks fail fast, but each still reads and writes its last result in Redis after taking the lock,
  // which is where the next run takes it over. The slow run is shown on these two as on the jobs above.
  for (const [name, lock, GET] of LOCK_ONLY.filter(([job]) => job === "stripe-check" || job === "mail-check")) {
    part(`cron/${name}: a slow run whose lock the next run took`);
    const overtaken = await run(name, lock, GET, { takeOver: "the-next-run" });
    // Before: its finally deleted whoever held the lock, here the next run's.
    is("its lock ran out and the next run took it: it ran, answered, and the next run's lock is kept", [overtaken.status, overtaken.ran > 0, overtaken.lockAfter], [200, true, "the-next-run"]);
  }

  part("cron/shares: settles only while COMMISSION_LIVE (false today, not changed here), so its lock is read from the source");
  const root = process.cwd();
  for (const [name, lock] of [...FULL, ...LOCK_ONLY, ["shares", "nl:share:lock"]]) {
    const source = readFileSync(join(root, "app/api/cron", name, "route.ts"), "utf8");
    is(`cron/${name}: claimed with claimMark and this run's own value`, source.includes(`claimMark("${lock}", `) && source.includes("claimValue()"), true);
    is(`cron/${name}: an unknown claim answers 503 lock_unknown`, /if \(got !== "ours"\) return Response\.json\(\{ ok: false, error: "lock_unknown" \}, \{ status: 503 \}\)/.test(source), true);
    is(`cron/${name}: let go only with releaseMark and its own value`, source.includes(`releaseMark("${lock}", lock)`), true);
    is(`cron/${name}: no SET NX read as "anything but nil is ours", no plain DEL of the lock`, [source.includes(`"SET", "${lock}", "1", "NX"`), source.includes(`["DEL", "${lock}"]`)], [false, false]);
  }

  // Review 6732896949 (Claude 2, LEVE 1): a lock that runs out before Vercel stops the function lets a second run
  // start beside the first. Each lock is kept at least the route's maxDuration plus room, so it outlasts the run
  // whatever the run does (a cutoff stops requests, not the function), as cron/shares already did (300 s, 330 s).
  part("each job's lock outlasts its route's maxDuration, with room");
  const LOCK_ROOM_SECONDS = 30;
  for (const [name, lock] of [...FULL, ...LOCK_ONLY, ["shares", "nl:share:lock"]]) {
    const source = readFileSync(join(root, "app/api/cron", name, "route.ts"), "utf8");
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(source)?.[1] ?? NaN);
    const ttl = Number(new RegExp(`claimMark\\("${lock}", (\\d+), lock\\)`).exec(source)?.[1] ?? NaN);
    // Before: stripe-check held its lock 120 s and mail-check 170 s while each may run 180 s.
    is(`cron/${name}: lock ${ttl} s >= maxDuration ${maxDuration} s + ${LOCK_ROOM_SECONDS} s`, Number.isFinite(maxDuration) && Number.isFinite(ttl) && ttl >= maxDuration + LOCK_ROOM_SECONDS, true);
  }

  part("cron/weekly: numbers that cannot be read let the week's claim go and count as failed (as cron/monthly)");
  const owner = "cron-locks-weekly@example.com";
  await weeklyWorld(owner);
  const healthy = await weeklyRun(null);
  is("healthy: looked at, sent, one email", [healthy.looked, healthy.sent, healthy.quiet, healthy.failed, mail.sent.length], [1, 1, 0, 0, 1]);
  const statsId = await weeklyWorld(owner);
  const first = await weeklyRun(statsId);
  // Before: counted quiet with failed 0, and the week's claim kept.
  is("the traffic read answers in another shape: counted failed, not quiet; nothing sent", [first.looked, first.quiet, first.failed, mail.sent.length], [1, 0, 1, 0]);
  const second = await weeklyRun(null);
  // Before: looked 0 and sent 0, the week's email lost.
  is("a later run the same week, Redis healthy again, sends the week's email", [second.looked, second.sent, mail.sent.length], [1, 1, 1]);

  done();
}

void main();
