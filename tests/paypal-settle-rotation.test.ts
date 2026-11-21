/**
 * The daily PayPal settling (settleAllPayPal) went through nl:pp:stores in the same order every day and stopped at
 * its deadline, so stores that are slow at the front of that order took the whole run each day and the stores behind
 * them were never settled: their affiliates stayed "on their way" and their unknown batches missed the daily retry
 * (#4620, part 2). The run now starts after the store where the last one stopped, and keeps that place before it
 * settles each store, so a run cut short inside one store still goes on with the next store the day after.
 * Synthetic stores, in-memory Redis, a clock the test moves.
 */
import { settleAllPayPal } from "@/lib/paypal-payouts";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STORES = "nl:pp:stores";
let clock = Date.now();
Date.now = () => clock;

/** A store with nothing open leaves the set when it is settled; each run here starts with all three in it. */
let all: string[] = [];
/** The stores whose record each run read, in order. */
let read: string[] = [];
/** A read of this store's record takes this long. */
const slow = new Map<string, number>();
const realPipeline = redis.pipeline;
redis.pipeline = async (commands: (string | number)[][]) => {
  for (const c of commands) {
    const key = String(c[1] ?? "");
    if (c[0] === "GET" && key.startsWith("nl:store:id:")) {
      const sid = key.slice("nl:store:id:".length);
      read.push(sid);
      clock += slow.get(sid) ?? 10;
    }
  }
  const replies = await realPipeline(commands);
  // Redis gives a set that does not change in the same order each time: so does this one, whatever was removed and added.
  return replies.map((reply: unknown, i: number) =>
    commands[i][0] === "SMEMBERS" && commands[i][1] === STORES && Array.isArray(reply) ? [...reply].sort((a, b) => all.indexOf(String(a)) - all.indexOf(String(b))) : reply,
  );
};

async function makeStore(email: string, handle: string): Promise<string> {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = await storeForEmail(email);
  if (!store?.sid) throw new Error(`setup: ${handle}`);
  return store.sid;
}

async function run(deadline: number): Promise<void> {
  redis.run(["SADD", STORES, ...all]);
  read = [];
  await settleAllPayPal(deadline);
}

async function main(): Promise<void> {
  redis.clear();
  const sids = [await makeStore("slow-a@example.com", "slowa"), await makeStore("next-b@example.com", "nextb"), await makeStore("next-c@example.com", "nextc")];
  // Whatever order the set gives, the store read first in a fresh run is the slow one.
  all = sids;
  await run(clock + 60_000);
  const order = [...read];
  if (order.length !== 3) throw new Error(`setup: a fresh run reads ${order.length} stores`);
  const [first, second, third] = order;
  slow.set(first, 5_000);

  part("A store that takes the whole run");
  redis.run(["DEL", "nl:pp:settle:after"]);
  await run(clock + 1_000);
  is("the first run reaches only it", read, [first]);

  part("The next day");
  await run(clock + 1_000);
  is("starts after it, so the stores behind it are settled, and it comes round again after them", read, [second, third, first]);

  part("A run with time for every store");
  slow.clear();
  await run(clock + 60_000);
  is("reads each store once", [...read].sort(), [...sids].sort());

  done();
}

void main();
