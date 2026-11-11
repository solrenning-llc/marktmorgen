/**
 * 623 [SZ7], unit 5b: the creator's low-stock alert is checked by the job
 * that already runs every five minutes for back-in-stock emails, never in the
 * checkout (whose stock share of an order's compute has no room left). A
 * product joins the job's set when its number is set and leaves it when it
 * is turned off, its product is gone (its number goes too) or its store is
 * gone. At most LOW_STOCK_RUN_PRODUCTS a run, each again after
 * LOW_STOCK_WAIT_MS. One job at a time, so a count read late never rearms a
 * crossing (Claude 3 and Codex G on #3650). Anything unreadable waits.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { setProductExtras } from "@/lib/catalog";
import { readListing } from "@/lib/catalog";
import { storeForIdExactly } from "@/lib/store-exact";
import { stockLeft } from "@/lib/stock";
import { LOW_STOCK_DUE, lowStockOf, setLowStock } from "@/lib/low-stock";
import { LOW_STOCK_RUN_PRODUCTS, LOW_STOCK_WAIT_MS, type LowStockDeps, runLowStockChecks } from "@/lib/low-stock-alert";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

// The same synthetic key as tests/store-alerts.test.ts: the Resend fixture takes only listed literals.
process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "job.owner@example.com";
const emails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push((JSON.parse(String(init?.body)) as { subject: string }).subject);
    return new Response(JSON.stringify({ id: `email_${emails.length}` }), { status: 200 });
  }
  throw new Error(`Only synthetic email: ${url.hostname}`);
}) as typeof fetch;

const real: LowStockDeps = { load: storeForIdExactly, readProduct: readListing, left: (s, p) => stockLeft(s, p) };

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "jobstock", "Job Goods", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_job", subscriptionId: "sub_job", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Glazed Mug", "", "30", null);
  if (!made.ok) throw new Error("no product");
  const pid = made.product.id;
  await setProductExtras(OWNER, pid, { stock: 6 });
  let store = (await storeForEmail(OWNER)) as Store;
  const sid = store.statsId!;
  const member = `${store.sid}|${pid}`;
  const sell = (n: number) => { for (let i = 0; i < n; i += 1) redis.run(["HSET", `nl:stock:${sid}:${pid}`, `cs_sold_${Date.now()}_${i}_${Math.random()}`, JSON.stringify({ until: 0, paid: true })]); };

  part("Setting a number puts the product on the job's set; off takes it off");
  is("set at 5 with 6 left", await setLowStock(store, pid, 5, 6), "saved");
  is("on the set", redis.run(["ZSCORE", LOW_STOCK_DUE, member]) !== null, true);

  part("The job tells the creator once when the units fall to the number");
  is("nothing sold: nothing told", await runLowStockChecks(Date.now() + 30_000, real), 0);
  sell(1);
  redis.run(["ZADD", LOW_STOCK_DUE, 0, member]);
  is("one sold, 5 left: told", await runLowStockChecks(Date.now() + 30_000, real), 1);
  is("one email", emails, ["Glazed Mug: 5 left"]);
  is("checked again only after the wait", Number(redis.run(["ZSCORE", LOW_STOCK_DUE, member])) >= Date.now() + LOW_STOCK_WAIT_MS - 5_000, true);
  sell(1);
  redis.run(["ZADD", LOW_STOCK_DUE, 0, member]);
  is("4 left: not again", await runLowStockChecks(Date.now() + 30_000, real), 0);

  part("Unreadable units wait, never told");
  redis.run(["ZADD", LOW_STOCK_DUE, 0, member]);
  is("no alert", await runLowStockChecks(Date.now() + 30_000, { ...real, left: async () => { throw new Error("Stock reading unavailable"); } }), 0);
  is("still on the set", redis.run(["ZSCORE", LOW_STOCK_DUE, member]) !== null, true);

  part(`At most ${LOW_STOCK_RUN_PRODUCTS} products a run`);
  for (let i = 0; i < LOW_STOCK_RUN_PRODUCTS + 3; i += 1) redis.run(["ZADD", LOW_STOCK_DUE, 0, `${store.sid}|extra${String(i).padStart(4, "0")}`]);
  let reads = 0;
  await runLowStockChecks(Date.now() + 30_000, { ...real, readProduct: async (s, id) => { reads += 1; return readListing(s, id); } });
  is("read at most that many", reads <= LOW_STOCK_RUN_PRODUCTS, true);

  part("A product gone leaves the set, and its number goes with it");
  for (let i = 0; i < LOW_STOCK_RUN_PRODUCTS + 3; i += 1) redis.run(["ZREM", LOW_STOCK_DUE, `${store.sid}|extra${String(i).padStart(4, "0")}`]);
  redis.run(["HSET", `nl:ls:${sid}`, "gone000001", JSON.stringify({ low: 3, seen: 5 })]);
  redis.run(["ZADD", LOW_STOCK_DUE, 0, `${store.sid}|gone000001`]);
  await runLowStockChecks(Date.now() + 30_000, real);
  is("off the set", redis.run(["ZSCORE", LOW_STOCK_DUE, `${store.sid}|gone000001`]), null);
  is("its number gone", redis.run(["HEXISTS", `nl:ls:${sid}`, "gone000001"]), 0);

  part("Off takes it off the set");
  store = (await storeForEmail(OWNER)) as Store;
  is("off", await setLowStock(store, pid, 0, 4), "off");
  is("off the set", redis.run(["ZSCORE", LOW_STOCK_DUE, member]), null);
  is("and no number", await lowStockOf(store, pid), null);
  done();
}

void main();
