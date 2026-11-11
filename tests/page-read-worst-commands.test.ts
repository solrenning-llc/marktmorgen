/**
 * The most one counted page reading is billed, every command counted as Upstash bills it: one for each pipeline
 * entry, and, for a script, one more for every redis.call it runs (lib/capped-count.ts, the capped count's own note).
 * COMMANDS.readBeacon (tests/traffic-cost.ts) prices every reading of the page-readings line at that worst, apart
 * from the window's ceiling mark, which the line prices once for every ceiling a window's tokens can carry.
 *
 * The worst path, through the real route (app/api/store/read/route.ts), on a sales page with a time:
 *   the token's mark (SET NX, 1); the window's count and its expiry (INCR, EXPIRE, 2); the capped count of the blocks'
 *   record at its most (EVAL 1, HLEN 1, HMGET 1, HINCRBY 1, so 4) with the time's range counted beside it (HINCRBY 1:
 *   its record only ever holds the TIME_RANGES names, so it needs no cap); and an answer to that pipeline that does not
 *   read, after which both records are given their expiry again (EXPIRE 2). 1 + 2 + 5 + 2 = 10.
 * The reading that reaches the window's ceiling also marks it (SET, 1): 11. That happens once for each value n of the
 * window's count (INCR gives each n once), only where n is the token's ceiling, so at most once a window for each
 * ceiling its tokens can carry (a store's standing, setup or trial, or one of its tiers): priced once a window each
 * (#2571, the review at 5d245b24, MEDIUM 1), not on every reading.
 * With an answer that reads, a record either is at its most (HMGET) or gets its first count's expiry, never both, so
 * the reading that marks the window is billed 9.
 *
 * Synthetic only: the Redis stand-in, no network.
 */
import { CAPPED_COUNT } from "@/lib/capped-count";
import { READ_SAMPLE, forgetReadingsSeen, noteReadStore, readSlot, readToken, readTokenPass, readSampled } from "@/lib/page-read";
import { DEPTH_FIELDS_MAX } from "@/lib/page-depth-rules";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { allowanceWindow } from "@/lib/allowance-window";
import { POST as readRoute } from "@/app/api/store/read/route";
import { COMMANDS, readBeaconCost } from "./traffic-cost";
import { COMMAND, COST_LINES, readingsAtCeiling } from "./plan-cost-registry";
import { EXTRA_REQUESTS, REQUESTS_PER_VISIT, SETUP_EXTRA_REQUESTS, SETUP_VISITS, TRIAL_EXTRA_REQUESTS, TRIAL_VISITS, publicVisitLimit, visitsIncluded } from "@/lib/traffic-rules";
import { TIERS } from "@/lib/plan";
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
    // The blocks' record is the capped count's first; the time's is the record beside it, ending in ":t".
    for (const c of list) {
      const named = c[0] === "EVAL" && c[1] === CAPPED_COUNT ? c.slice(3, 3 + Number(c[2])).map(String) : c[0] === "HINCRBY" ? [String(c[1])] : [];
      for (const k of named) if (/^nl:depth:/.test(k) && !keys.includes(k)) keys.push(k);
    }
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
  /** A reading at its worst, both records at their most, the window `short` readings short of its ceiling. */
  const measure = async (short: number, lose: boolean) => {
    const token = slotted(statsId, store);
    atTheMost(token);
    const pass = readTokenPass(token, PRODUCT)!;
    redis.run(["SET", `nl:traffic:read:${statsId}:${pass.window}`, String(pass.cap - short)]);
    loseCount = lose;
    billed = 0;
    await sale(token);
    loseCount = false;
    return billed;
  };
  const worst = await measure(1, true);
  const unmarked = await measure(2, true);
  const answered = await measure(1, false);
  console.log(`  billed: worst ${worst} (${unmarked} apart from the ceiling mark), with the count's answer read ${answered}`);
  is("the worst path apart from the window's ceiling mark (both records at their most, the count's answer lost) is billed 10", unmarked, 10);
  is("the reading that reaches the ceiling marks the window: one more, 11", worst, unmarked + 1);
  is("the same reading with the count's answer read is billed 9", answered, 9);
  is("COMMANDS.readBeacon prices every reading at that worst apart from the mark", unmarked <= COMMANDS.readBeacon, true);

  part("the window's ceiling mark, once a window for each ceiling its tokens can carry");
  {
    // Past the ceiling, readings from servers that had not seen it write no mark again: only n == the token's ceiling does.
    const token = slotted(statsId, store);
    const pass = readTokenPass(token, PRODUCT)!;
    const window = `nl:traffic:read:${statsId}:${pass.window}`;
    redis.run(["SET", window, String(pass.cap - 1)]);
    redis.run(["DEL", `${window}:over`]);
    let marks = 0;
    const counting = redis.pipeline;
    (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: Command[]) => {
      for (const c of list) if (c[0] === "SET" && String(c[1]) === `${window}:over`) marks += 1;
      return counting(list);
    }) as typeof redis.pipeline;
    forgetReadingsSeen();
    await sale(token);
    for (let i = 0; i < 3; i += 1) {
      forgetReadingsSeen();
      await sale(slotted(statsId, store));
    }
    (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = counting;
    is("the reading that reaches the ceiling marks the window once, and none past it does", marks, 1);
    // Every ceiling a store's tokens can carry: its setup, its trial and each tier's (lib/traffic-rules.ts, requestLimitFor).
    const ceiling = (visits: number, extra: number) => Math.ceil(publicVisitLimit(REQUESTS_PER_VISIT * visits + extra) / READ_SAMPLE);
    const ceilings = new Set([ceiling(SETUP_VISITS, SETUP_EXTRA_REQUESTS), ceiling(TRIAL_VISITS, TRIAL_EXTRA_REQUESTS), ...TIERS.map((t) => ceiling(visitsIncluded(t), EXTRA_REQUESTS[t]))]);
    const line = COST_LINES.find((l) => l.id === "page-readings")!;
    for (const tier of TIERS) {
      const readings = readingsAtCeiling(REQUESTS_PER_VISIT * visitsIncluded(tier) + EXTRA_REQUESTS[tier]);
      is(`${tier}: the line prices every reading at COMMANDS.readBeacon and a mark for each of the ${ceilings.size} ceilings`, line.monthlyUsd(tier) + 1e-12 >= readings * readBeaconCost() + ceilings.size * COMMAND, true);
    }
  }
  done();
}

void main();
