/**
 * #2921, Claude 7 xAF's MÉDIO (7109598055): reading in batches of DIRECTORY_READ_BATCH made a build of MAX_ROWS
 * stores 40 batches of store reads, then 40 of numbers reads, one after another. Under a slow Redis (answers late but
 * under the cutoff) that outlived the build mark (BUILD_HOLD_SECONDS, 60 s), so the next visitor started a second full
 * build while the first still ran, exactly when the database was already slow. Now the build has a deadline under the
 * mark (DIRECTORY_BUILD_DEADLINE_MS from its start): a batch not started by then is not read and its stores are
 * counted as left out. A build that read some programs keeps its page partial; one that read none is "could not be
 * checked" and marks itself failed. Either way it ends while its mark is its own, so no second build starts.
 *
 * Synthetic: the Redis stand-in only, and a clock that moves a fixed step on every Redis call, so a "slow Redis" costs
 * no real waiting. The listed sids have no store behind them (each read answers "no store").
 */
import { readDirectoryPage } from "@/lib/affiliate-directory";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LISTED = "nl:dir:listed";
const BUILD = "nl:dir:build";
const sid = (i: number) => i.toString(16).padStart(32, "0");

let clock = 1_800_000_000_000;
let step = 0;
Date.now = () => clock;
const real = redis.pipeline.bind(redis);
let calls = 0;
redis.pipeline = (async (commands: (string | number)[][]) => {
  calls += 1;
  clock += step;
  return real(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const members = Array.from({ length: 2_000 }, (_, i) => sid(i + 1));
  for (let i = 0; i < members.length; i += 500) await real([["SADD", LISTED, ...members.slice(i, i + 500)]]);

  part("A slow Redis: the build stops at its deadline, under the build mark, and no second build starts");
  // 100 ms a call: one batch of 50 store reads moves the clock several seconds, 40 batches far past the mark.
  step = 100;
  calls = 0;
  const started = clock;
  const outcome = await readDirectoryPage().then(() => "answered", (error: unknown) => String(error));
  const took = clock - started;
  is(`the build ends before the mark could run out (took ${took} ms, mark 60000 ms)`, took < 60_000, true);
  is(`not every listed store was read (${calls} Redis calls for ${members.length} stores)`, calls < members.length, true);
  // Every listed sid here has no store, so no program was read before the deadline: the list could not be checked,
  // which is "unavailable", never "no program is listed yet" (the rule for a build whose reads all failed).
  is("with no program read in time, the page is unavailable, never an empty list", outcome.includes("ran out of time"), true);
  const [mark] = await real([["GET", BUILD]]);
  is("the build marked itself failed while the mark was still its own", mark, "failed");
  step = 0;
  calls = 0;
  const again = await readDirectoryPage().then(() => "answered", () => "unavailable");
  is(`the next visitor builds nothing (${calls} Redis calls)`, [again, calls <= 3], ["unavailable", true]);

  part("Control: a healthy Redis reads every listed store");
  redis.clear();
  for (let i = 0; i < members.length; i += 500) await real([["SADD", LISTED, ...members.slice(i, i + 500)]]);
  step = 0;
  const healthy = await readDirectoryPage();
  is("nothing is left out", healthy.omitted, 0);

  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
