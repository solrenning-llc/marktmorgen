/**
 * The hourly job's hide step has a time budget of its own (Claude 4 on #3486,
 * comment 6802107160; lib/child-safety.ts, hideHeldProducts).
 *
 * A busy store lock is exactly what puts a held product in the queue, and the
 * step runs inside app/api/cron/quiet (maxDuration 60 s) before the rest of
 * the hourly work. So it never waits the store write's full 8 s on a busy
 * lock, and it stops before the next product once its own deadline is past:
 * whatever it did not reach, or could not confirm off, stays queued (never
 * dropped) for the next run. Neutral, synthetic products only.
 */
import { hideHeldProducts } from "@/lib/child-safety";
import { keepKey } from "@/lib/child-safety-holds";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "budget-owner@example.com";
const HANDLE = "budgetshop";
const QUEUE = "nl:csa:hide";
const WAITING = 27;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Budget Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_budget01", subscriptionId: "sub_budget01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const ids: string[] = [];
  for (let n = 0; n < WAITING; n++) {
    const made = await addProduct(OWNER, `Neutral product ${n}`, "", "19", null);
    if (!made.ok) throw new Error("no product");
    ids.push(made.product.id);
  }
  const store = (await storeForEmail(OWNER)) as Store;
  const tag = store.statsId || `h:${store.handle}`;
  const queuedAt = Date.now() - 60_000;
  // Each product held and waiting to be taken off, as holdReported leaves it when the hide did not go through.
  for (const id of ids) {
    redis.run(["SET", keepKey(store, id), "1", "EX", 400 * 86_400]);
    redis.run(["ZADD", QUEUE, queuedAt, JSON.stringify([storeRef(store), tag, id])]);
  }
  const owner = redis.keys().find((key) => key.startsWith("nl:store:owner:"));
  if (!owner) throw new Error("no owner key");
  const lock = owner.replace("nl:store:owner:", "nl:store:lock:");
  const scores = () => {
    const flat = redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf", "WITHSCORES"]) as string[];
    const out: number[] = [];
    for (let n = 1; n < flat.length; n += 2) out.push(Number(flat[n]));
    return out;
  };
  const hiddenCount = async () => {
    let count = 0;
    for (const id of ids) if ((await readListing((await storeForEmail(OWNER)) as Store, id))?.hidden) count += 1;
    return count;
  };

  part("The store's lock held by another write: the run ends within its budget, nothing dropped");
  redis.run(["SET", lock, "another-write", "EX", 600]);
  const now = Date.now();
  const started = Date.now();
  const busy = await hideHeldProducts(now);
  const took = Date.now() - started;
  console.log(`        run took ${took} ms: ${JSON.stringify(busy)}`);
  is("the run ends within 10 s, far inside the hourly route's 60 s with the rest of its work", took <= 10_000, true);
  is("nothing taken off while the lock is busy", [busy.hidden, await hiddenCount()], [0, 0]);
  is("and it tried some before stopping", busy.waiting > 0, true);
  const after = scores();
  is("every product still queued: never dropped", after.length, WAITING);
  is("those tried wait an hour, those not reached stay due for the next run", [after.filter((score) => score > now).length, after.filter((score) => score === queuedAt).length], [busy.waiting, WAITING - busy.waiting]);
  // The next hourly run may start a little before a full hour later (cron jitter, a faster claim): a product tried
  // and not confirmed off is due for it, never left visible a second hour (Claude 3 on #3588, comment 6801516714).
  const early = (redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", String(now + 3_600_000 - 60_000)]) as string[]).length;
  is("a run a minute short of the hour still finds every product tried and not confirmed off", early, WAITING);
  redis.run(["DEL", lock]);
  let at = now + 2 * 3_600_000;

  part("A deadline already past: nothing is tried, everything stays queued as it was");
  const late = await hideHeldProducts(at, Date.now() - 1);
  is("nothing tried", late, { hidden: 0, waiting: 0, gone: 0 });
  is("all still queued, each due when it was", scores(), after);
  is("nothing taken off", await hiddenCount(), 0);

  part("Once the lock is free, the next runs take them all off and let them go");
  for (let n = 0; n < 3 && scores().length; n++, at += 2 * 3_600_000) await hideHeldProducts(at);
  is("all taken off", await hiddenCount(), WAITING);
  is("and the queue is empty", scores().length, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
