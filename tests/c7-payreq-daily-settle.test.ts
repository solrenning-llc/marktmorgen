/**
 * Issue #4728, path (b) (C7, 15 November 2026): the checkout sweep counted a store's open payment requests and tried to
 * take it off the list on every run, seven commands a run for each store with requests. Now the list is read once a
 * run and each store on it is settled once a UTC day, its place kept in the cursor's own SET. Synthetic, the Redis stub.
 */
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { OPEN_COUNT_COMMANDS, REMOVE_IDLE_STORE_COMMANDS } from "@/lib/payment-request-store";
import { CHECKOUT_SWEEP_RUNS_PER_DAY, COST_LINES, PAYMENT_REQUEST_INDEX_COMMANDS, PAYMENT_REQUEST_SETTLES_PER_DAY } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_c7_daily_settle";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 15, 10, 0, 0);
const STORES = "nl:payreq:stores";
const open = (sid: string) => `nl:payreq:o:${sid}`;
const realNow = Date.now;
let clock = T0;

type Commands = (string | number)[][];
const original = redis.pipeline;
const real = original.bind(redis);
let sent: string[] = [];
let onCount: (() => void) | null = null;

function watch(): void {
  redis.pipeline = (async (commands: Commands) => {
    for (const c of commands) {
      const key = String(c[1] ?? "");
      if (c[0] === "SMEMBERS" && key === STORES) sent.push("SMEMBERS");
      if ((c[0] === "ZREMRANGEBYSCORE" || c[0] === "ZCARD") && key.startsWith("nl:payreq:o:")) sent.push(`${c[0]} ${key.slice(12)}`);
      if (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:payreq-idle-store")) sent.push(`EVAL ${String(c[c.length - 1])}`);
    }
    const answer = await real(commands);
    if (onCount && commands.some((c) => c[0] === "ZCARD")) {
      const hook = onCount;
      onCount = null;
      hook();
    }
    return answer;
  }) as typeof redis.pipeline;
}

async function run(deadline = clock + 60_000): Promise<string[]> {
  sent = [];
  await sweepCheckouts(deadline);
  return sent;
}

const members = async () => ((await real([["SMEMBERS", STORES]]))[0] as string[]).sort();

async function main(): Promise<void> {
  Date.now = () => clock;
  try {
    redis.clear();
    // Two stores with an open request each, one whose only request expired.
    await real([
      ["SADD", STORES, "s-a", "s-b", "s-c"],
      ["ZADD", open("s-a"), String(T0 + 7 * DAY), "req-a"],
      ["ZADD", open("s-b"), String(T0 - 1), "req-b-expired"],
      ["ZADD", open("s-c"), String(T0 + 7 * DAY), "req-c"],
    ]);
    watch();

    part("The first run of a day settles each store once: counted, the idle one taken off in one step");
    is("the list once, then each store counted, the idle one removed", await run(), [
      "SMEMBERS",
      "ZREMRANGEBYSCORE s-a", "ZCARD s-a",
      "ZREMRANGEBYSCORE s-b", "ZCARD s-b", "EVAL s-b",
      "ZREMRANGEBYSCORE s-c", "ZCARD s-c",
    ]);
    is("the store with no open request left is off the list", await members(), ["s-a", "s-c"]);

    part("Every other run of the same day reads the list and nothing of any store");
    clock = T0 + 5 * 60_000;
    is("the list only", await run(), ["SMEMBERS"]);
    clock = T0 + 13 * 3_600_000;
    is("the list only, later the same day", await run(), ["SMEMBERS"]);

    part("The next day settles them again, once");
    clock = T0 + DAY;
    await real([["ZADD", open("s-c"), String(T0 + DAY - 1), "req-c"]]); // s-c's request has since expired
    is("each store counted once, the one now idle removed", await run(), [
      "SMEMBERS",
      "ZREMRANGEBYSCORE s-a", "ZCARD s-a",
      "ZREMRANGEBYSCORE s-c", "ZCARD s-c", "EVAL s-c",
    ]);
    is("only the store with an open request is left", await members(), ["s-a"]);
    clock = T0 + DAY + 5 * 60_000;
    is("then the list only", await run(), ["SMEMBERS"]);

    part("A run that stops part way goes on after the last store it settled, none settled twice a day");
    clock = T0 + 2 * DAY;
    await real([
      ["SADD", STORES, "s-d", "s-e"],
      ["ZADD", open("s-d"), String(T0 + 9 * DAY), "req-d"],
      ["ZADD", open("s-e"), String(T0 + 9 * DAY), "req-e"],
    ]);
    const deadline = clock + 1_000;
    onCount = () => { clock = deadline + 1; }; // the job's time runs out right after the first store's count
    is("the first run settles one store, then stops", await run(deadline), ["SMEMBERS", "ZREMRANGEBYSCORE s-a", "ZCARD s-a"]);
    clock = T0 + 2 * DAY + 5 * 60_000;
    is("the next run goes on after it", await run(), ["SMEMBERS", "ZREMRANGEBYSCORE s-d", "ZCARD s-d", "ZREMRANGEBYSCORE s-e", "ZCARD s-e"]);
    clock = T0 + 2 * DAY + 10 * 60_000;
    is("and the pass is done for the day", await run(), ["SMEMBERS"]);

    part("A cursor written before this change (no day kept) settles on its first run");
    await real([["SET", "nl:sweep:cursor", "0|0"]]);
    is("settled", await run(), ["SMEMBERS", "ZREMRANGEBYSCORE s-a", "ZCARD s-a", "ZREMRANGEBYSCORE s-d", "ZCARD s-d", "ZREMRANGEBYSCORE s-e", "ZCARD s-e"]);
  } finally {
    redis.pipeline = original;
    Date.now = realNow;
  }

  part("The line prices the day as it runs");
  is("one read of the list a run", PAYMENT_REQUEST_INDEX_COMMANDS, 1);
  is("one settle a store a day", PAYMENT_REQUEST_SETTLES_PER_DAY, 1);
  is("288 runs a day", CHECKOUT_SWEEP_RUNS_PER_DAY, 288);
  is("a day at most: 294 commands where the count and removal on every run were 2,016",
    [CHECKOUT_SWEEP_RUNS_PER_DAY * PAYMENT_REQUEST_INDEX_COMMANDS + PAYMENT_REQUEST_SETTLES_PER_DAY * (OPEN_COUNT_COMMANDS + REMOVE_IDLE_STORE_COMMANDS), CHECKOUT_SWEEP_RUNS_PER_DAY * (1 + OPEN_COUNT_COMMANDS + REMOVE_IDLE_STORE_COMMANDS)], [294, 2016]);
  is("the line is in the registry", COST_LINES.some((line) => line.id === "payment-request-sweep"), true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
