/**
 * Step 2 of the daily subscription sync (lib/billing-sync.ts, syncStores) moves on inside a batch it could not
 * finish (Claude 2 and Codex H2, MEDIUM on #3216).
 *
 * The defect this file was written around: the deadline, checked before every store, cut the batch short and saved
 * the start of the batch again. The stores already checked and found paid up were not in `seen`, so the next run
 * read them again first; when one batch held more paid-up stores than a run can read, the walk never got past them,
 * and a store further in the batch whose subscription Stripe no longer lists (the case only step 2 catches) kept its
 * paid plan for good. Now the place reached inside the batch is kept with the cursor, and the next run starts after
 * the last store it passed. Synthetic data only; no write is ever sent to Stripe.
 */
import { syncSubscriptions } from "@/lib/billing-sync";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sync_batch_progress_only";
const realNow = Date.now.bind(Date);
let shift = 0;
Date.now = () => realNow() + shift;
/** Each read of one subscription takes this long (milliseconds of the synthetic clock). */
let readTakes = 0;
/** Reading Stripe's list (step 1) takes this long: enough, in a round, to leave step 2 no time at all. */
let listTakes = 0;
const reads: string[] = [];
const canceledAtStripe = new Set<string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || (init?.method ?? "GET") !== "GET") throw new Error("unexpected external operation in synthetic billing sync");
  if (url.pathname === "/v1/subscriptions") {
    shift += listTakes;
    return Response.json({ object: "list", data: [], has_more: false });
  }
  const one = url.pathname.match(/^\/v1\/subscriptions\/(sub_\w+)$/);
  if (one) {
    reads.push(one[1]);
    shift += readTakes;
    const status = canceledAtStripe.has(one[1]) ? "canceled" : "active";
    return Response.json({ id: one[1], object: "subscription", status, metadata: {}, items: { data: [] } });
  }
  throw new Error("unexpected provider path in synthetic billing sync");
}) as typeof fetch;

const shops = ["alpha", "bravo", "charlie", "delta", "echo"];
async function setup(cancel: string[]) {
  redis.clear();
  reads.length = 0;
  canceledAtStripe.clear();
  for (const name of shops) {
    const owner = `batch-${name}@example.com`;
    await claimHandle(owner, `batch-${name}`, `Batch ${name}`, "");
    await ensureStatsId(owner);
    await setSubscription(owner, { customerId: `cus_Batch${name}01`, subscriptionId: `sub_Batch${name}01`, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
    if (cancel.includes(name)) canceledAtStripe.add(`sub_Batch${name}01`);
  }
}
const paid = async (name: string) => (await storeForEmail(`batch-${name}@example.com`))!.subscriptionActive;

async function main() {
  part("Healthy control: with time for every store, one run reads each once and ends the canceled one");
  await setup(["echo"]);
  readTakes = 0;
  const whole = await syncSubscriptions(Date.now() + 60_000);
  is("five stores read once each, the run complete", [new Set(reads).size, reads.length, whole.complete], [5, 5, true]);
  is("the store Stripe has canceled no longer counts as paid up", await paid("echo"), false);

  part("Each read takes longer than the run's whole budget: the walk still moves on inside the batch");
  await setup(["echo"]);
  readTakes = 20_000;
  for (let run = 0; run < 5; run += 1) await syncSubscriptions(Date.now() + 15_000);
  is("in five runs every store is read, none twice", [new Set(reads).size, reads.length], [5, 5]);
  is("the store Stripe has canceled no longer counts as paid up", await paid("echo"), false);
  is("the others still count as paid up", await Promise.all(["alpha", "bravo", "charlie", "delta"].map(paid)), [true, true, true, true]);
  for (let run = 0; run < 5; run += 1) await syncSubscriptions(Date.now() + 15_000);
  is("the next lap starts again from the start of the walk", new Set(reads.slice(5)).size >= 4, true);

  // Codex H2's focal return on #3216: a round whose step 1 used up the time saved only the batch's cursor, so the
  // place reached inside the batch by the round before was lost and the next round read the same store again.
  part("A round that leaves step 2 no time keeps the place the round before reached inside the batch");
  await setup(["echo"]);
  readTakes = 20_000;
  const idleReads: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    listTakes = 0;
    await syncSubscriptions(Date.now() + 15_000);
    listTakes = 60_000;
    const before = reads.length;
    const idle = await syncSubscriptions(Date.now() + 15_000);
    idleReads.push(reads.length - before);
    is(`idle round ${run + 1} is not complete and fails nothing`, [idle.complete, idle.failed], [false, 0]);
  }
  listTakes = 0;
  is("the rounds with no time read no store", idleReads, [0, 0, 0, 0, 0]);
  is("in five useful rounds every store is read, none twice", [new Set(reads).size, reads.length], [5, 5]);
  is("the store Stripe has canceled no longer counts as paid up", await paid("echo"), false);
  is("the others still count as paid up", await Promise.all(["alpha", "bravo", "charlie", "delta"].map(paid)), [true, true, true, true]);

  part("Control: a round with no time and no place saved inside a batch keeps the cursor it had");
  await setup([]);
  readTakes = 0;
  listTakes = 60_000;
  await syncSubscriptions(Date.now() + 15_000);
  listTakes = 0;
  is("nothing read while there was no time", reads.length, 0);
  const after = await syncSubscriptions(Date.now() + 60_000);
  is("the next round with time reads every store once and completes", [new Set(reads).size, reads.length, after.complete], [5, 5, true]);

  done();
}

void main();
