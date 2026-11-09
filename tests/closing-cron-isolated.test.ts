/**
 * The daily closing job (app/api/cron/closing/route.ts) runs five parts in
 * turn: the stores whose plan was started again (lib/closing-holds.ts
 * releaseRestarted), the plans paid for closing stores
 * (lib/closing-plan-guard.ts retryPlanUndos), the plan refunds a request did
 * not finish (lib/plan-refund-flow.ts finishPlanRefunds), the deleted stores
 * still to forget (lib/store-forget-retry.ts retryStoreForgets) and the
 * closing itself (lib/plan-closing.ts closeEnded). Since a reply that cannot
 * be read throws UnknownReplyError (CX-123 rules 24 and 30,
 * tests/closing-reads-siblings.test.ts), one part that throws must not stop
 * the others until the next day:
 *
 *   - every part runs, whatever the one before it did;
 *   - the failure stays visible: logged with the part's name, and the job
 *     answers 500 "server_error" at the end, naming each part that failed,
 *     never "ok" (a part that failed was answered "ok" when it was caught
 *     and taken as nothing done);
 *   - each part's line is asked once a run, so nothing is done twice;
 *   - the job's lock is let go, so the next run is not turned away as busy.
 *
 * Synthetic data only; nothing real is reached.
 */
import { GET as closingJob } from "@/app/api/cron/closing/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.UPSTASH_REDIS_REST_TOKEN ??= "stub-token";
// So the plan refunds part reads its line (lib/billing.ts isBillingConfigured); no request leaves the test.
process.env.STRIPE_SECRET_KEY = "sk_test_closing_cron_isolated_only";
delete process.env.CRON_SECRET;

type Command = (string | number)[];

const LOCK = "nl:closing:lock";
/** The first line each part asks for, by the part's name in the job's answer. */
const LINES: Record<string, [string, string]> = {
  restarted: ["ZRANGEBYSCORE", "nl:closing:held"],
  undos: ["HKEYS", "nl:closing:undo"],
  refunds: ["HGETALL", "nl:plan-refund:ending"],
  forgets: ["HGETALL", "nl:forget:q"],
  closing: ["ZRANGEBYSCORE", "nl:held:stores"],
};

/** What one part's line is answered with this run: an unknown shape, or a database that does not answer. */
let inject: { line: [string, string]; reply: unknown[] | "throw" } | null = null;
const sent: Command[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  sent.push(commands);
  const first = commands[0];
  if (inject && commands.length === 1 && first?.[0] === inject.line[0] && first?.[1] === inject.line[1]) {
    if (inject.reply === "throw") throw new Error("the database did not answer");
    return inject.reply;
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const errors: unknown[][] = [];
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args);
};

/** How many times this run asked for one line. */
const asked = (from: number, [name, key]: [string, string]) =>
  sent
    .slice(from)
    .flat()
    .filter((c) => c[0] === name && c[1] === key).length;

function request() {
  return { headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/closing") } as unknown as Parameters<typeof closingJob>[0];
}

async function run(): Promise<{ status: number; body: Record<string, unknown>; from: number; logged: unknown[][] }> {
  const from = sent.length;
  const before = errors.length;
  try {
    const response = await closingJob(request());
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, from, logged: errors.slice(before) };
  } catch {
    return { status: -1, body: {}, from, logged: errors.slice(before) };
  }
}

async function lockHeld(): Promise<boolean> {
  const [held] = await pipeline([["GET", LOCK]]);
  return held !== null && held !== undefined;
}

async function main(): Promise<void> {
  redis.clear();

  const cases: [string, string, unknown[] | "throw"][] = [
    ["the line of restarted stores answered in an unknown shape", "restarted", [["nl:closing:held:one", "not-a-score"]]],
    ["the line of restarted stores could not be asked", "restarted", "throw"],
    ["the line of plans paid for closing stores answered in an unknown shape", "undos", [{}]],
    ["the line of plans paid for closing stores could not be asked", "undos", "throw"],
    ["the line of unfinished plan refunds could not be asked", "refunds", "throw"],
    ["the line of deleted stores to forget answered in an unknown shape", "forgets", [{ 0: "x" }]],
    ["the line of deleted stores to forget could not be asked", "forgets", "throw"],
    ["the closing's own line could not be asked", "closing", "throw"],
  ];

  for (const [label, name, reply] of cases) {
    part(`closing job: ${label}`);
    inject = { line: LINES[name], reply };
    const got = await run();
    inject = null;
    is("the job answers 500 server_error at the end, never ok, never throws", [got.status, got.body.ok, got.body.error], [500, false, "server_error"]);
    is("and names the part that failed, and only it", got.body.failed, [name]);
    is("the failure is logged with the part's name", got.logged.some((args) => String(args[0]).includes(name)), true);
    for (const [other, line] of Object.entries(LINES)) is(`the ${other} part ran, its line asked once`, asked(got.from, line), 1);
    is("the lock was let go", [asked(got.from, ["DEL", LOCK]), await lockHeld()], [1, false]);
    const next = await run();
    is("so the next run is not turned away as busy, and reads as before", [next.status, next.body.ok, next.body.busy ?? false, next.body.failed ?? null], [200, true, false, null]);
  }

  part("closing job: two parts fail in one run");
  let failing = 0;
  const two = new Set(["nl:closing:held", "nl:forget:q"]);
  const kept = redis.pipeline;
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && two.has(String(commands[0]?.[1])) && (commands[0]?.[0] === "ZRANGEBYSCORE" || commands[0]?.[0] === "HGETALL")) {
      failing += 1;
      sent.push(commands);
      throw new Error("the database did not answer");
    }
    return kept(commands);
  }) as typeof redis.pipeline;
  const both = await run();
  redis.pipeline = kept;
  is("each failed part is named, in the order they ran", [both.status, both.body.failed, failing], [500, ["restarted", "forgets"], 2]);
  for (const [other, line] of Object.entries(LINES)) is(`the ${other} part ran, its line asked once`, asked(both.from, line), 1);
  is("the lock was let go", await lockHeld(), false);

  part("closing job: every part read: as before");
  const fine = await run();
  is("ok", [fine.status, fine.body.ok, fine.body.failed ?? null], [200, true, null]);
  is("the counts in the answer", [typeof fine.body.looked, typeof fine.body.told, typeof fine.body.held], ["number", "number", "number"]);
  for (const [other, line] of Object.entries(LINES)) is(`the ${other} part ran, its line asked once`, asked(fine.from, line), 1);
  is("nothing logged as failed", fine.logged.length, 0);
  is("the lock was let go", await lockHeld(), false);

  part("closing job: the lock already held");
  await pipeline([["SET", LOCK, "1", "EX", 120]]);
  const busy = await run();
  is("busy, and no part runs", [busy.status, busy.body.busy, ...Object.values(LINES).map((line) => asked(busy.from, line))], [200, true, 0, 0, 0, 0, 0]);
  is("and the lock it did not take is not let go", [asked(busy.from, ["DEL", LOCK]), await lockHeld()], [0, true]);
  await pipeline([["DEL", LOCK]]);

  console.error = consoleError;
  done();
}

void main();
