/**
 * Claude 5 ibuF's LEVE on #5409 @1f290b0604: the low-stock job had no cost line in tests/plan-cost-registry.ts (only
 * the email-meter map), and #5409's LOW_STOCK_OFF and LOW_STOCK_SAVE run TAKE_DATA inside them, which Upstash bills as
 * the EVAL and one command for every redis.call. The scripts' commands are now stated in lib/low-stock.ts
 * (LOW_STOCK_OFF_COMMANDS, LOW_STOCK_SAVE_COMMANDS) and the job's counted part a run in the registry (LOW_STOCK_RUN,
 * NOT_A_COST.LOW_STOCK_RUN_PRODUCTS), every number derived from the constants. This holds them to the scripts' own
 * text and to what the real job sends for a run of products gone. Read through the modules, so it runs, and fails,
 * where the figures are not there yet. Synthetic store; in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as lowStock from "@/lib/low-stock";
import * as data from "@/lib/store-data";
import * as registry from "./plan-cost-registry";
import { LOW_STOCK_RUN_PRODUCTS, runLowStockChecks } from "@/lib/low-stock-alert";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ls = lowStock as unknown as { LOW_STOCK_OFF: string; LOW_STOCK_SAVE: string; LOW_STOCK_DUE: string; LOW_STOCK_OFF_COMMANDS?: number; LOW_STOCK_SAVE_COMMANDS?: number };
const take = data.takeDataCommands(1);
type Run = {
  runsPerMonth: number;
  productsPerRun: number;
  dueReadCommands: number;
  turnEndCommandsMost: number;
  goneProductCommands: number;
  offAddedCommands: number;
  saveCommands: number;
  countedCommandsPerRun: number;
};
const run = (registry as unknown as { LOW_STOCK_RUN?: Run }).LOW_STOCK_RUN;
const reason = (registry as unknown as { NOT_A_COST: Record<string, string> }).NOT_A_COST.LOW_STOCK_RUN_PRODUCTS ?? "";
const callsOutside = (script: string) => (script.split(data.TAKE_DATA).join("").match(/redis\.call\(/g) ?? []).length;

async function main(): Promise<void> {
  part("The scripts' commands, read from their own text");
  is("each runs TAKE_DATA once", [ls.LOW_STOCK_OFF.split(data.TAKE_DATA).length, ls.LOW_STOCK_SAVE.split(data.TAKE_DATA).length], [2, 2]);
  is("and one redis.call of its own (the HDEL, the HSET)", [callsOutside(ls.LOW_STOCK_OFF), callsOutside(ls.LOW_STOCK_SAVE)], [1, 1]);
  is(
    "RED: stated at the EVAL, TAKE_DATA's inner calls at their worst and that call",
    [ls.LOW_STOCK_OFF_COMMANDS, ls.LOW_STOCK_SAVE_COMMANDS],
    [1 + (take - 1) + callsOutside(ls.LOW_STOCK_OFF), 1 + (take - 1) + callsOutside(ls.LOW_STOCK_SAVE)],
  );
  const reschedule = /const LOW_STOCK_RESCHEDULE = \[([\s\S]*?)\]\.join/.exec(readFileSync(join(process.cwd(), "lib/low-stock-alert.ts"), "utf8"))?.[1] ?? "";
  const rescheduleCalls = (reschedule.match(/redis\.call\(/g) ?? []).length;
  is("the job's reschedule is its EVAL and two calls", rescheduleCalls, 2);

  part("The registry's run, derived from the constants");
  is("LOW_STOCK_RUN is in the registry", typeof run, "object");
  is("every five minutes, a 32-day month", run?.runsPerMonth, registry.DAY_WINDOWS * 288);
  is("the batch is the job's", run?.productsPerRun, LOW_STOCK_RUN_PRODUCTS);
  is("a turn ends in a ZREM or the reschedule", run?.turnEndCommandsMost, Math.max(1, 1 + rescheduleCalls));
  is("a gone product: the off script, its ZREM and the job's", run?.goneProductCommands, (ls.LOW_STOCK_OFF_COMMANDS ?? NaN) + 2);
  is("the off script adds TAKE_DATA's give-back over the plain HDEL", run?.offAddedCommands, take);
  is("a save, when a route calls it: the script and its ZADD", run?.saveCommands, (ls.LOW_STOCK_SAVE_COMMANDS ?? NaN) + 1);
  is(
    "a run: the read and every product at its most",
    run?.countedCommandsPerRun,
    1 + LOW_STOCK_RUN_PRODUCTS * Math.max((ls.LOW_STOCK_OFF_COMMANDS ?? NaN) + 2, 1 + rescheduleCalls),
  );
  is(
    "NOT_A_COST says why it is the company's, names the run and the gap, never zero",
    ["LOW_STOCK_RUN", "LOW_STOCK_OFF_COMMANDS", "#5427", "not certified, never zero"].map((word) => reason.includes(word)),
    [true, true, true, true],
  );

  part("What the real job sends for a run of products gone");
  redis.clear();
  const owner = "low-stock-run@example.test";
  if (!(await claimHandle(owner, "lowrun", "Fictional Low Run", "")).ok) throw new Error("no store");
  await ensureStatsId(owner);
  const store = (await storeForEmail(owner))!;
  for (let i = 0; i < LOW_STOCK_RUN_PRODUCTS + 5; i++) redis.run(["ZADD", ls.LOW_STOCK_DUE, 0, `${store.sid}|gone${i}`]);
  const sent: (string | number)[][] = [];
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent.push(...commands);
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await runLowStockChecks(Date.now() + 60_000, { load: async () => store, readProduct: async () => null, left: async () => null });
  } finally {
    redis.pipeline = real;
  }
  const billed = sent.reduce((sum, c) => sum + (c[0] === "EVAL" ? (c[1] === ls.LOW_STOCK_OFF ? ls.LOW_STOCK_OFF_COMMANDS ?? NaN : NaN) : 1), 0);
  is("one read, then each product's off script and two ZREMs, no other script", [sent.filter((c) => c[0] === "ZRANGEBYSCORE").length, sent.filter((c) => c[0] === "EVAL").length, sent.filter((c) => c[0] === "ZREM").length], [1, LOW_STOCK_RUN_PRODUCTS, 2 * LOW_STOCK_RUN_PRODUCTS]);
  is("no plain HDEL beside the script", sent.filter((c) => c[0] === "HDEL").length, 0);
  is("billed at most the registry's run", billed <= (run?.countedCommandsPerRun ?? -1), true);
  is("exactly the registry's run when every product is gone", billed, run?.countedCommandsPerRun);
  is("the products past the batch wait for the next run", redis.run(["ZCARD", ls.LOW_STOCK_DUE]), 5);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
