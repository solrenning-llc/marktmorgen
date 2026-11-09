/**
 * The most one counted page reading is billed, every command counted as Upstash bills it: one for each pipeline
 * entry, and, for a script, one more for every redis.call it runs (lib/capped-count.ts, the capped count's own note).
 * COMMANDS.readBeacon (tests/traffic-cost.ts) prices every reading of the page-readings line at that worst.
 *
 * The worst path, through the real route (app/api/store/read/route.ts), on a sales page with a time:
 *   the token's mark (SET NX, 1); the window's count and its expiry (INCR, EXPIRE, 2); the reading that reaches the
 *   window's ceiling marks it (SET, 1); the capped count of both records in one script (EVAL 1, HLEN 2, HMGET 2 for
 *   two records at their most, HINCRBY 2, so 7); and an answer to that script that does not read, after which both
 *   records are given their expiry again (EXPIRE 2). 1 + 2 + 1 + 7 + 2 = 13.
 * With an answer that reads, a record either is at its most (HMGET) or gets its first count's expiry, never both, so
 * the same reading is billed 11.
 *
 * Synthetic only: the Redis stand-in, no network.
 */
import { CAPPED_COUNT } from "@/lib/capped-count";
import { READ_SAMPLE, forgetReadingsSeen, noteReadStore, readSlot, readToken, readTokenPass, readSampled } from "@/lib/page-read";
import { DEPTH_FIELDS_MAX } from "@/lib/page-depth-rules";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { allowanceWindow } from "@/lib/allowance-window";
import { POST as readRoute } from "@/app/api/store/read/route";
import { COMMANDS } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const PRODUCT = "prod000001";
type Command = (string | number)[];

/** Billed commands while something runs: each entry, and each redis.call a capped count runs inside. */
let billed = 0;
/** When true, the capped count's answer is lost after it ran (it wrote, the reply does not read). */
let loseCount = false;
const real = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: Command[]) => {
  billed += list.length;
  let capped = false;
  for (const command of list) {
    if (command[0] !== "EVAL" || command[1] !== CAPPED_COUNT) continue;
    capped = true;
    const n = Number(command[2]);
    const keys = command.slice(3, 3 + n).map(String);
    const caps = command.slice(3 + n, 3 + 2 * n).map(Number);
    const counts = command.slice(3 + 2 * n);
    for (let k = 0; k < n; k += 1) {
      let left = 0;
      for (let i = 0; i < counts.length; i += 3) if (Number(counts[i]) === k + 1) left += 1;
      if (!left) continue;
      billed += 1; // HLEN
      if (Number(redis.run(["HLEN", keys[k]])) + left > caps[k]) billed += 1; // HMGET
    }
    billed += counts.length / 3; // HINCRBY, one a count
  }
  const replies = await real(list);
  return capped && loseCount ? list.map(() => undefined) : replies;
}) as typeof redis.pipeline;

let seed = 0;
function nonce(): string {
  for (;;) {
    const n = `visit${String((seed += 1)).padStart(11, "0")}`;
    if (readSampled(n)) return n;
  }
}
let place = 0;
/** A token for a page whose check drew its block's reading slot. */
function slotted(statsId: string, store: Parameters<typeof noteReadStore>[1]): string {
  const window = allowanceWindow(store!, Date.now())!.id;
  do place += 1;
  while (!readSlot(window, place));
  noteReadStore(statsId, store, Date.now(), place);
  return readToken(statsId, PRODUCT, Date.now(), nonce());
}
const sale = (t: string) => readRoute(new Request("https://marktmorgen.com/api/store/read", { method: "POST", headers: { "user-agent": PHONE }, body: JSON.stringify({ t, k: "d", p: PRODUCT, b: "blok0001", s: 42 }) }) as never);

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle("worst@example.com", "worstreads", "Worst Reads", "");
  await ensureStatsId("worst@example.com");
  const store = (await storeForEmail("worst@example.com"))!;
  const statsId = store.statsId!;
  is("(a reading is drawn one in READ_SAMPLE)", READ_SAMPLE, 8);

  // One reading first, to learn the two records' keys from the capped count the route sends.
  let keys: string[] = [];
  const spy = redis.pipeline;
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: Command[]) => {
    for (const c of list) if (c[0] === "EVAL" && c[1] === CAPPED_COUNT) keys = c.slice(3, 5).map(String);
    return spy(list);
  }) as typeof redis.pipeline;
  await sale(slotted(statsId, store));
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = spy;
  is("(the route counts a sales page's block and time in two records)", keys.length, 2);

  /** Both records at their most, and the window one reading short of its ceiling. */
  const atTheMost = (token: string) => {
    const [blocks, times] = keys;
    redis.run(["DEL", blocks]);
    for (let i = 0; i < DEPTH_FIELDS_MAX; i += 1) redis.run(["HSET", blocks, `other${String(i).padStart(4, "0")}`, "1"]);
    for (const f of ["@t0", "@t1", "@t2", "@t3", "@t4", "@t5"]) redis.run(["HSET", times, f, "1"]);
    const pass = readTokenPass(token, PRODUCT)!;
    const window = `nl:traffic:read:${statsId}:${pass.window}`;
    redis.run(["DEL", `${window}:over`]);
    redis.run(["SET", window, String(pass.cap - 1)]);
    forgetReadingsSeen();
  };

  part("the most a reading counted is billed");
  const lost = slotted(statsId, store);
  atTheMost(lost);
  loseCount = true;
  billed = 0;
  await sale(lost);
  loseCount = false;
  const worst = billed;
  const normal = slotted(statsId, store);
  atTheMost(normal);
  billed = 0;
  await sale(normal);
  const answered = billed;
  console.log(`  billed: worst ${worst}, with the count's answer read ${answered}`);
  is("the worst path (ceiling reached, both records at their most, the count's answer lost) is billed 13", worst, 13);
  is("the same reading with the count's answer read is billed 11", answered, 11);
  is("COMMANDS.readBeacon prices every reading at that worst", worst <= COMMANDS.readBeacon, true);
  done();
}

void main();
