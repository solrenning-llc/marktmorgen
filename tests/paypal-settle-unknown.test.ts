/**
 * The daily PayPal job never takes a store whose record cannot be read for a
 * store that is gone (rule 24, CX-123; ALTO (2) of Claude 5's proof
 * claude5/store-read-unknown-proof). settleAllPayPal read each store in
 * nl:pp:stores with `storeForId(sid).catch(() => null)` and SREMed it when
 * nothing came back: a read that timed out took a store with a batch still
 * open off the daily job for good, and its affiliates stayed "on their way".
 * A store that is gone (its id names no record) still leaves the set.
 *
 * Synthetic stores, in-memory Redis; the unreadable record is a read that
 * times out, an id key whose GET answers another shape, or an owner record
 * that comes back cut (Claude 6's MEDIUM on #3102: storeForId answers null,
 * not an error, for those two, so only an EXISTS that is exactly 0 says gone).
 */
import { settleAllPayPal } from "@/lib/paypal-payouts";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STORES = "nl:pp:stores";
const timedOut = new Set<string>();
// A GET of this key answers this value instead of the stored one (another shape).
const offShape = new Map<string, unknown>();
// A GET whose stored record carries this handle comes back cut to 20 characters.
let cutHandle: string | null = null;
const realPipeline = redis.pipeline;
redis.pipeline = async (commands: (string | number)[][]) => {
  if (commands.some((c) => c[0] === "GET" && timedOut.has(String(c[1])))) throw new Error("Redis request timed out (test)");
  const replies = await realPipeline(commands);
  return replies.map((reply: unknown, i: number) => {
    const c = commands[i];
    if (c[0] !== "GET") return reply;
    if (offShape.has(String(c[1]))) return offShape.get(String(c[1]));
    if (cutHandle && typeof reply === "string" && reply.includes(`"handle":"${cutHandle}"`)) return reply.slice(0, 20);
    return reply;
  });
};

async function makeStore(email: string, handle: string): Promise<string> {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = await storeForEmail(email);
  if (!store?.sid) throw new Error(`setup: ${handle}`);
  return store.sid;
}

async function main(): Promise<void> {
  redis.clear();
  const open = await makeStore("open-batch@example.com", "openbatch");
  const gone = await makeStore("gone-store@example.com", "gonestore");
  // lib/store.ts storeIdKey: what storeForId reads first.
  const openIdKey = `nl:store:id:${open}`;
  const goneIdKey = `nl:store:id:${gone}`;
  if (redis.run(["GET", openIdKey]) === null || redis.run(["GET", goneIdKey]) === null) throw new Error("setup: a store's id key");
  redis.run(["DEL", goneIdKey]);
  redis.run(["SADD", STORES, open, gone]);

  part("A store whose record cannot be read stays in the daily job");
  timedOut.add(openIdKey);
  const settled = await settleAllPayPal(Date.now() + 30_000);
  timedOut.delete(openIdKey);
  is("nothing settled on a read that failed", settled, 0);
  is("the store with its batch still open is still in the daily job", redis.run(["SISMEMBER", STORES, open]), 1);
  is("a store that is gone (its id names no record) leaves it, as before", redis.run(["SISMEMBER", STORES, gone]), 0);

  part("An id key that answers another shape is not a store that is gone");
  redis.run(["SADD", STORES, open]);
  offShape.set(openIdKey, 42);
  is("nothing settled on a reply of another shape", await settleAllPayPal(Date.now() + 30_000), 0);
  offShape.delete(openIdKey);
  is("the store with its batch still open is still in the daily job", redis.run(["SISMEMBER", STORES, open]), 1);

  part("An owner record that comes back cut is not a store that is gone");
  redis.run(["SADD", STORES, open]);
  cutHandle = "openbatch";
  is("nothing settled on a cut record", await settleAllPayPal(Date.now() + 30_000), 0);
  cutHandle = null;
  is("the store with its batch still open is still in the daily job", redis.run(["SISMEMBER", STORES, open]), 1);

  part("An EXISTS that cannot be read keeps the store too");
  redis.run(["SADD", STORES, open]);
  offShape.set(openIdKey, 42);
  const realAgain = redis.pipeline;
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EXISTS")) return ["not a count"];
    return realAgain(commands);
  };
  is("nothing settled", await settleAllPayPal(Date.now() + 30_000), 0);
  redis.pipeline = realAgain;
  offShape.delete(openIdKey);
  is("the store is still in the daily job", redis.run(["SISMEMBER", STORES, open]), 1);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
