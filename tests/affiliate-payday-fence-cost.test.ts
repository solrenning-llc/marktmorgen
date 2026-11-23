/**
 * What the payday's fence costs (Codex L-20261119-1144, #5010 row 88; the coordinator's rule 964c: a fix that turns a
 * SET into a fence measures its real route and is priced on its own line). The month's claim and keepMonth's
 * write-again are each one EVAL that runs HGET, GET and SET, in place of one SET: measured here on a real payday run,
 * each request counted whole (script, keys, the owner's ref at the longest address a store can have), at most two
 * fenced steps a run, and the job once a day, so the line affiliate-payday-fence bounds them all.
 *
 * Synthetic store, affiliate and sale; Resend is a stand-in; MemoryRedis.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "node:test";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { PAYDAY_CATCH_UP_DAYS, PAYDAY_FENCE_EXTRA_BYTES, PAYDAY_FENCE_EXTRA_COMMANDS, PAYDAY_RUNS_DUE, sendPaydayEmails } from "@/lib/affiliate-payday";
import { MAX_EMAIL_LENGTH } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { COMMAND, COST_LINES, DB_BYTE } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = new Date(Date.UTC(2026, 10, 15, 14));
mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
process.env.STRIPE_SECRET_KEY = "sk_test_payday_fence_cost_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const DAY = 86_400;
const T0 = Math.floor(NOW.getTime() / 1000) - 400 * DAY;
// The longest address a store can have, so the owner's ref the fence carries is at its longest.
const OWNER = `${"o".repeat(MAX_EMAIL_LENGTH - "@example.com".length)}@example.com`;

/**
 * Billed commands of one fence script on its dearest path, as Upstash bills them: the EVAL and every redis.call it
 * runs. The two branches of `if ARGV[4] == "" then ... else ... end` (a store with an id, one from before ids) never
 * both run, so the dearer of them is counted, with every call outside them.
 */
const calls = (text: string) => (text.match(/redis\.call\(/g) ?? []).length;
function billed(script: string): number {
  const head = 'if ARGV[4] == "" then';
  const at = script.indexOf(head);
  if (at < 0 || script.indexOf(head, at + 1) >= 0) throw new Error("a fence script of another shape");
  const elseAt = script.indexOf("\nelse\n", at);
  const endAt = script.indexOf("\nend\n", elseAt);
  if (elseAt < 0 || endAt < 0) throw new Error("a fence script of another shape");
  const branches = Math.max(calls(script.slice(at, elseAt)), calls(script.slice(elseAt, endAt)));
  return 1 + calls(script.slice(0, at)) + branches + calls(script.slice(endAt));
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "paydayfence", "Payday Fence Cost", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPaydayCost", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, payday: 15 }));
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const aff = "c3c3c3c3c3c3";
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, aff, JSON.stringify({ id: aff, email: `${aff}@example.com`, code: "c3c3c", status: "approved", appliedAt: T0 * 1000, decidedAt: T0 * 1000, note: "" })],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff, at: T0 + 10 * DAY, product: "prod01", title: "Bread course", base: 1000, total: 1000, currency: "usd", rate: 20, self: false, how: "click" })],
  ]);
  const claim = `nl:aff:payday:${statsId}:2026-11`;
  const fenced: (string | number)[][] = [];
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) if (c[0] === "EVAL" && c.includes(claim)) fenced.push(c);
    // Every EXPIRE on the month's claim fails, so the run also sends keepMonth's write-again: both fenced steps.
    if (commands.some((c) => c[0] === "EXPIRE" && c[1] === claim)) throw new Error("the keep's EXPIRE failed (test)");
    return real(commands);
  }) as typeof redis.pipeline;
  const out = await sendPaydayEmails(Date.now() + 20_000, NOW);
  redis.pipeline = real;

  part("A due run sends both fenced steps, each inside the line's bound");
  is("the run sends the email", out.sent, 1);
  is("two fenced steps on the month's key: the claim and the write-again", fenced.length, 2);
  const extra = fenced.reduce((sum, c) => sum + billed(String(c[1])) - 1, 0);
  is("their extra billed commands over two plain SETs are the line's", extra, PAYDAY_FENCE_EXTRA_COMMANDS);
  const biggest = Math.max(...fenced.map((c) => Buffer.byteLength(JSON.stringify(c))));
  is("each fenced request, whole, at the longest owner ref, is under 2 KiB", biggest <= PAYDAY_FENCE_EXTRA_BYTES / 2, true);

  part("The job once a day, a store due on PAYDAY_RUNS_DUE days a month");
  const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
  const job = vercel.crons.filter((c) => c.path === "/api/cron/affiliates");
  is("one schedule, once a day", job.map((c) => /^\d+ \d+ \* \* \*$/.test(c.schedule)), [true]);
  is("due on its payday and the catch-up days", PAYDAY_RUNS_DUE, PAYDAY_CATCH_UP_DAYS + 1);

  part("The line prices them all, for a paying store and one that pays nothing");
  const line = COST_LINES.find((l) => l.id === "affiliate-payday-fence")!;
  const month = PAYDAY_RUNS_DUE * (PAYDAY_FENCE_EXTRA_COMMANDS * COMMAND + PAYDAY_FENCE_EXTRA_BYTES * DB_BYTE);
  for (const tier of ["creator", "pro", "scale"] as const) is(`${tier}: the line's month`, Math.abs(line.monthlyUsd(tier) - month) < 1e-15, true);
  is("above zero, never free", month > 0, true);
  const registry = readFileSync(join(process.cwd(), "tests/plan-cost-registry.ts"), "utf8");
  const worst = registry.slice(registry.indexOf("export function nonPayingWorst"), registry.indexOf("\n}\n", registry.indexOf("export function nonPayingWorst")));
  is("a store that pays nothing carries it too", worst.includes('creator("affiliate-payday-fence")'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
