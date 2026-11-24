/**
 * Claude 3 xuXy's doubt on #5434 (OWNER-20261124-0059-DOUBT-NOT-APPROVED (b)), noted as older than the PR by Claude 3
 * vyDE: the daily IndexNow job (app/api/cron/indexnow/route.ts, lib/indexnow.ts announceNewPages) had no line in
 * tests/plan-cost-registry.ts, before or after #5434's claim (issue #4003). Unknown cost fails, never zero (MR), so the
 * whole run is priced there as a company fixed job (INDEXNOW_RUN, NOT_A_COST.INDEXNOW_BATCH), every number derived from
 * the constants and the sitemap. This holds the line to the schedule, the route, the release script's own text and to
 * what the real job sends in its worst run. Read through the module, so it runs, and fails, where the line is not there
 * yet. In-memory Redis and a mocked engine only; nothing leaves the test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as registry from "./plan-cost-registry";
import { INDEXNOW_BATCH, INDEXNOW_ENDPOINT, announceNewPages, sitemapUrls } from "@/lib/indexnow";
import { RELEASE } from "@/lib/redis-lock";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Run = {
  runsPerMonth: number;
  addressesPerRun: number;
  addressBytes: number;
  claimCommandsMost: number;
  readCommands: number;
  markCommandsMost: number;
  releaseCommands: number;
  busyRunCommandsMost: number;
  commandsPerRunMost: number;
  commandsPerMonthMost: number;
  postsPerRunMost: number;
  routeSecondsMost: number;
};
const run = (registry as unknown as { INDEXNOW_RUN?: Run }).INDEXNOW_RUN;
const reason = (registry as unknown as { NOT_A_COST: Record<string, string> }).NOT_A_COST.INDEXNOW_BATCH ?? "";
const root = process.cwd();
const releaseCalls = (RELEASE.match(/redis\.call\(/g) ?? []).length;

async function main(): Promise<void> {
  const urls = sitemapUrls();
  const batches = Math.ceil(urls.length / INDEXNOW_BATCH);

  part("The schedule, the route and the release script, read from their own text");
  const crons = (JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] }).crons;
  const schedule = crons.filter((cron) => cron.path === "/api/cron/indexnow").map((cron) => cron.schedule);
  is("one schedule, once a UTC day", schedule.length === 1 && /^\d+ \d+ \* \* \*$/.test(schedule[0]), true);
  const route = readFileSync(join(root, "app/api/cron/indexnow/route.ts"), "utf8");
  const maxDuration = Number(/export const maxDuration = (\d+);/.exec(route)?.[1]);
  is("the route's time limit is a number", Number.isFinite(maxDuration) && maxDuration > 0, true);
  is("the release is one EVAL and its GET and DEL", releaseCalls, 2);

  part("The registry's run, derived from the constants and the sitemap");
  is("INDEXNOW_RUN is in the registry", typeof run, "object");
  is("one run a UTC day, DAY_WINDOWS a month", run?.runsPerMonth, registry.DAY_WINDOWS);
  is("the addresses are the sitemap's", run?.addressesPerRun, urls.length);
  is("their bytes are the sitemap's", run?.addressBytes, urls.reduce((sum, url) => sum + Buffer.byteLength(url), 0));
  is("the claim: its SET NX EX and the read-back of an answer in another shape", run?.claimCommandsMost, 2);
  is("one SISMEMBER an address", run?.readCommands, urls.length);
  is("one SADD a batch the engines took", run?.markCommandsMost, batches);
  is("one POST a batch", run?.postsPerRunMost, batches);
  is("the release: the EVAL and the script's calls", run?.releaseCommands, 1 + releaseCalls);
  is("a busy run: the claim only", run?.busyRunCommandsMost, 2);
  is("a run at its most", run?.commandsPerRunMost, 2 + urls.length + batches + 1 + releaseCalls);
  is("a month at its most", run?.commandsPerMonthMost, registry.DAY_WINDOWS * (2 + urls.length + batches + 1 + releaseCalls));
  is("the route's time limit", run?.routeSecondsMost, maxDuration);
  is(
    "NOT_A_COST says why it is the company's, names the run and the gap, never zero",
    ["INDEXNOW_RUN", "lib/indexnow.ts", "tests/indexnow-run-cost.test.ts", "lib/llc-fixed-costs.ts", "not certified, never zero"].map((word) => reason.includes(word)),
    [true, true, true, true, true],
  );

  part("What the real job sends in its worst run: every address new, the claim answered in another shape");
  redis.clear();
  const sent: (string | number)[][] = [];
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent.push(...commands);
    const replies = await real(commands);
    // The claim lands, but its answer comes back in another shape, so the job reads it back (lib/claim-mark.ts).
    if (commands.length === 1 && commands[0][0] === "SET") return ["QUEUED"] as never;
    return replies;
  }) as typeof redis.pipeline;
  const posts: string[][] = [];
  let result: Awaited<ReturnType<typeof announceNewPages>>;
  try {
    result = await announceNewPages((async (input: RequestInfo | URL, init?: RequestInit) => {
      is("(each post) to the protocol's address", String(input), INDEXNOW_ENDPOINT);
      posts.push((JSON.parse(String(init?.body)) as { urlList: string[] }).urlList);
      return new Response(null, { status: 202 });
    }) as typeof fetch);
  } finally {
    redis.pipeline = real;
  }
  is("the run announced every address", result, { ok: true, announced: urls.length });
  const count = (name: string) => sent.filter((c) => c[0] === name).length;
  is(
    "one SET, one GET, a SISMEMBER an address, a SADD a batch, one EVAL, nothing else",
    [count("SET"), count("GET"), count("SISMEMBER"), count("SADD"), count("EVAL"), sent.length],
    [1, 1, urls.length, batches, 1, 2 + urls.length + batches + 1],
  );
  is("the EVAL is the release", sent.find((c) => c[0] === "EVAL")?.[1], RELEASE);
  const billed = sent.reduce((sum, c) => sum + (c[0] === "EVAL" ? (c[1] === RELEASE ? 1 + releaseCalls : NaN) : 1), 0);
  is("billed exactly the registry's run at its most", billed, run?.commandsPerRunMost);
  is("the posts are the registry's", posts.length, run?.postsPerRunMost);
  is("the claim was let go", redis.run(["EXISTS", "nl:indexnow:lock"]), 0);

  part("A run that finds the claim held sends the claim only");
  redis.clear();
  redis.run(["SET", "nl:indexnow:lock", "another run", "EX", 120]);
  const busySent: (string | number)[][] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    busySent.push(...commands);
    return real(commands);
  }) as typeof redis.pipeline;
  let busy: Awaited<ReturnType<typeof announceNewPages>>;
  try {
    busy = await announceNewPages((async () => {
      throw new Error("a busy run never posts");
    }) as typeof fetch);
  } finally {
    redis.pipeline = real;
  }
  is("busy, nothing announced", busy, { ok: true, announced: 0, busy: true });
  is("within the registry's busy run", busySent.length <= (run?.busyRunCommandsMost ?? -1), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
