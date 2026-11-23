/**
 * #2921, Claude 7 xAF's MÉDIO (7109598055): reading in batches of DIRECTORY_READ_BATCH made a build of MAX_ROWS
 * stores 40 batches of store reads, then 40 of numbers reads, one after another. Under a slow Redis (answers late but
 * under the cutoff) that outlived the build mark (BUILD_HOLD_SECONDS, 60 s), so the next visitor started a second full
 * build while the first still ran, exactly when the database was already slow. Now the build has a deadline under the
 * mark (DIRECTORY_BUILD_DEADLINE_MS from its start): a batch not started by then is not read, its stores are counted
 * as left out, and the page is kept partial, so no second build starts before the next kept page runs out.
 *
 * Synthetic: the Redis stand-in only, and a clock that moves a fixed step on every Redis call, so a "slow Redis" costs
 * no real waiting. The listed sids have no store behind them (each read answers "no store").
 */
import { readDirectoryPage } from "@/lib/affiliate-directory";
import { DIRECTORY_CACHE } from "@/lib/directory-index";
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

  part("A slow Redis: the build stops at its deadline, under the build mark");
  // 100 ms a call: one batch of 50 store reads moves the clock several seconds, 40 batches far past the mark.
  step = 100;
  calls = 0;
  const started = clock;
  const page = await readDirectoryPage();
  const took = clock - started;
  is(`the build ends before the mark could run out (took ${took} ms, mark 60000 ms)`, took < 60_000, true);
  is("not every listed store was read", calls < members.length, true);
  is(`the stores not read are counted as left out (omitted ${page.omitted})`, page.omitted > 0, true);
  const [kept, mark] = await real([["GET", DIRECTORY_CACHE], ["GET", BUILD]]);
  is("the page is kept, so the next visitor reads it and builds nothing", typeof kept === "string" && String(kept).includes('"omitted"'), true);
  is("and the build let its mark go", mark, null);
  step = 0;
  calls = 0;
  const again = await readDirectoryPage();
  is("the next visitor reads the kept page: no second build", [calls, again.omitted], [1, page.omitted]);

  part("Control: a healthy Redis reads every listed store");
  redis.clear();
  for (let i = 0; i < members.length; i += 500) await real([["SADD", LISTED, ...members.slice(i, i + 500)]]);
  step = 0;
  const healthy = await readDirectoryPage();
  is("nothing is left out", healthy.omitted, 0);

  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
