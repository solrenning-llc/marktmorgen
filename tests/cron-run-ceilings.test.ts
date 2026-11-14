/**
 * Every scheduled job has its own time ceiling, and the daily usage watch
 * runs once at a time inside its own deadline (MR rule: every spend has an
 * automatic ceiling before it happens).
 *
 *   - every route under app/api/cron declares maxDuration, so no run's time is
 *     the platform's unverified default;
 *   - a job that holds a lock holds it at least as long as one run may take,
 *     so a second run never starts beside a first that is still going;
 *   - the usage watch (app/api/cron/usage/route.ts) takes its own lock: held
 *     by another run it answers busy and reads nothing; an unknown answer reads
 *     nothing and says so (CX-123 rule 24); a finished run lets its lock go.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GET as usage } from "@/app/api/cron/usage/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const root = process.cwd();
const cronDir = join(root, "app/api/cron");
const routes = readdirSync(cronDir).map((name) => ({ name, text: readFileSync(join(cronDir, name, "route.ts"), "utf8") }));

const sent: (string | number)[][][] = [];
type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
let rule: Rule | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(commands);
  if (rule && rule.when(commands)) return rule.reply as unknown[];
  return pipeline(commands);
}) as typeof redis.pipeline;

const request = { headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof usage>[0];
const LOCK = "nl:usage:lock";
const readSomething = (from: number) => sent.slice(from).some((commands) => commands.some((c) => c[0] === "SMEMBERS"));

async function run(): Promise<{ status: number; body: Record<string, unknown>; from: number }> {
  const from = sent.length;
  const response = await usage(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, from };
}

async function main(): Promise<void> {
  redis.clear();
  delete process.env.CRON_SECRET;

  part("every scheduled job declares its own time ceiling");
  for (const route of routes) {
    is(`${route.name} declares maxDuration`, /export const maxDuration = \d+;/.test(route.text), true);
  }

  part("a job's lock is held at least as long as one run may take");
  for (const route of routes) {
    const ceiling = /export const maxDuration = (\d+);/.exec(route.text);
    for (const lock of route.text.matchAll(/claimMark\("nl:[^"]+:lock", (\d+), lock\)/g)) {
      is(`${route.name}: the lock (${lock[1]} s) outlasts the run (${ceiling?.[1] ?? "?"} s)`, ceiling !== null && Number(lock[1]) >= Number(ceiling[1]), true);
    }
  }

  part("usage: held by another run, it answers busy and reads nothing");
  redis.clear();
  await redis.pipeline([["SET", LOCK, "another-run", "EX", 120]]);
  {
    const got = await run();
    is("answers busy", [got.status, got.body.busy], [200, true]);
    is("reads no store list", readSomething(got.from), false);
    is("leaves the other run's lock", (await redis.pipeline([["GET", LOCK]]))[0], "another-run");
  }

  part("usage: an unknown answer about the lock reads nothing and says so");
  redis.clear();
  {
    const from = sent.length;
    rule = { when: (c) => c.some((x) => (x[0] === "SET" || x[0] === "GET") && x[1] === LOCK), reply: ["not OK"] };
    const response = await usage(request);
    rule = null;
    const body = (await response.json()) as Record<string, unknown>;
    is("answers 503 lock_unknown", [response.status, body.error], [503, "lock_unknown"]);
    is("reads no store list", readSomething(from), false);
  }

  part("usage: a finished run lets its own lock go");
  redis.clear();
  {
    const got = await run();
    is("the run read its stores", readSomething(got.from), true);
    is("its lock was taken", sent.slice(got.from).some((commands) => commands.some((c) => c[0] === "SET" && c[1] === LOCK)), true);
    is("and is gone at the end", (await redis.pipeline([["GET", LOCK]]))[0], null);
  }

  done();
}

void main();
