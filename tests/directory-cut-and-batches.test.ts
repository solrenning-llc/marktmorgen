/**
 * #2921, Claude 3 yUZf's two findings kept as "fix here" (7106585119):
 *
 *   1. The 2,000-program cut. buildDirectory stops the SSCAN once it holds MAX_ROWS sids with the cursor not back
 *      at "0" and kept that subset as the whole directory: which programs the page ranked depended on SSCAN order,
 *      and nothing said the list was incomplete. Now that page says so (`more`), is kept as a partial page, and a
 *      page kept that way reads back with the same mark.
 *   2. About 6,000 requests at once. The store reads (and then each program's numbers) ran in one Promise.all over
 *      up to 2,000 stores. Now they run in fixed batches of DIRECTORY_READ_BATCH, so no more than that many reads
 *      are ever in flight together.
 *
 * Synthetic: the Redis stand-in only. The 2,001 listed sids are ids with no store behind them (a read answers
 * "no store", which is a row that is not shown), plus one real store as a control.
 */
import { DIRECTORY_READ_BATCH, readDirectoryPage } from "@/lib/affiliate-directory";
import { DIRECTORY_CACHE } from "@/lib/directory-index";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LISTED = "nl:dir:listed";
const sid = (i: number) => i.toString(16).padStart(32, "0");

const real = redis.pipeline.bind(redis);
let inFlight = 0;
let maxInFlight = 0;
redis.pipeline = (async (commands: (string | number)[][]) => {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return await real(commands);
  } finally {
    inFlight -= 1;
  }
}) as typeof redis.pipeline;

async function listed(n: number): Promise<void> {
  redis.clear();
  const members = Array.from({ length: n }, (_, i) => sid(i + 1));
  for (let i = 0; i < members.length; i += 500) await real([["SADD", LISTED, ...members.slice(i, i + 500)]]);
}

async function main(): Promise<void> {
  part("Control: a directory that fits is whole");
  await listed(30);
  maxInFlight = 0;
  const small = await readDirectoryPage();
  is("no 'more' mark on a list read to its end", small.more === true, false);

  part("A listed set past the 2,000 cut is marked as not whole");
  await listed(2_001);
  maxInFlight = 0;
  const big = await readDirectoryPage();
  is("the page says more programs are listed than it read", big.more, true);
  is(`no more than DIRECTORY_READ_BATCH (${DIRECTORY_READ_BATCH}) reads are in flight together (saw ${maxInFlight})`, maxInFlight <= DIRECTORY_READ_BATCH, true);
  const kept = real([["GET", DIRECTORY_CACHE]]);
  is("the page is kept with its mark", typeof (await kept)[0] === "string" && String((await kept)[0]).includes('"more":true'), true);
  maxInFlight = 0;
  const again = await readDirectoryPage();
  is("read back from the kept page, the mark is still there", again.more, true);

  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
