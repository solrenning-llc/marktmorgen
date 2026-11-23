/**
 * 623 [SZ7], unit 5b: the creator's low-stock alert is checked by the job
 * that already sends back-in-stock emails, never in the
 * checkout (whose stock share of an order's compute has no room left). A
 * product joins the job's set when its number is set and leaves it when it
 * is turned off, its product is gone (its number goes too) or its store is
 * gone. At most LOW_STOCK_RUN_PRODUCTS a run, each again after
 * LOW_STOCK_WAIT_MS. One job at a time, so a count read late never rearms a
 * crossing (Claude 3 and Codex G on #3650). Anything unreadable waits.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { setProductExtras } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { storeForIdExactly } from "@/lib/store-exact";
import { stockLeft } from "@/lib/stock";
import { LOW_STOCK_BYTES, LOW_STOCK_DUE, lowStockOf, lowStockTouched, setLowStock } from "@/lib/low-stock";
import { dataKey, noteData } from "@/lib/store-data";
import { readFileSync } from "node:fs";
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
  // Its room, held as a save holds it (Codex X6 on #3650: a product's deletion left its slot counted until the store closed).
  await noteData(store, [{ slot: "ls:gone000001", bytes: LOW_STOCK_BYTES + 10, set: true }]);
  const room = dataKey(store)!;
  is("its room held", Number(redis.run(["HGET", room, "ls:gone000001"]) ?? 0) > 0, true);
  redis.run(["ZADD", LOW_STOCK_DUE, 0, `${store.sid}|gone000001`]);
  await runLowStockChecks(Date.now() + 30_000, real);
  is("off the set", redis.run(["ZSCORE", LOW_STOCK_DUE, `${store.sid}|gone000001`]), null);
  is("its number gone", redis.run(["HEXISTS", `nl:ls:${sid}`, "gone000001"]), 0);
  is("and its room given back", redis.run(["HGET", room, "ls:gone000001"]), null);

  part("A sale makes its product due at once; a product with no number is never added (Revisor 1 on #3814)");
  redis.run(["ZADD", LOW_STOCK_DUE, Date.now() + LOW_STOCK_WAIT_MS, member]);
  await lowStockTouched(store, [pid, "nonumber0001"]);
  is("due now", Number(redis.run(["ZSCORE", LOW_STOCK_DUE, member])) <= Date.now(), true);
  is("a product without a number stays off the set", redis.run(["ZSCORE", LOW_STOCK_DUE, `${store.sid}|nonumber0001`]), null);
  const stock = readFileSync("lib/stock.ts", "utf8");
  const bound = stock.indexOf("if (bound === 1)");
  is("the cart's hold, once bound, makes its products due", bound > 0 && stock.slice(bound, bound + 300).includes("lowStockTouched(store, limited.map((product) => product.id))"), true);
  is("the platform's pace is enough for changed products only: a product is checked again a day later at most", LOW_STOCK_WAIT_MS, 86_400_000);
  is(`and ${LOW_STOCK_RUN_PRODUCTS} products a run`, LOW_STOCK_RUN_PRODUCTS, 50);
  is("no name in the job reads as a person", /\bmembers?\b/.test(readFileSync("lib/low-stock-alert.ts", "utf8")), false);

  // Codex X6's LOW on #3814 (7059424886): a sale that makes the product due while the job is checking it is never
  // pushed back a day by the job's own reschedule; the job moves it later only while it is still as the job read it.
  part("A sale during the check keeps its product due (Codex X6 on #3814)");
  redis.run(["ZADD", LOW_STOCK_DUE, 0, member]);
  let touchedAt = 0;
  await runLowStockChecks(Date.now() + 30_000, {
    ...real,
    left: async (s, p) => {
      await lowStockTouched(store, [pid]);
      touchedAt = Number(redis.run(["ZSCORE", LOW_STOCK_DUE, member]));
      return stockLeft(s, p);
    },
  });
  is("the sale's touch made it due during the check", touchedAt > 0 && touchedAt <= Date.now(), true);
  is("and it is still due after the check, not a day later", Number(redis.run(["ZSCORE", LOW_STOCK_DUE, member])) <= Date.now(), true);
  redis.run(["ZADD", LOW_STOCK_DUE, 0, member]);
  await runLowStockChecks(Date.now() + 30_000, real);
  is("with no sale during the check, it waits a day as before", Number(redis.run(["ZSCORE", LOW_STOCK_DUE, member])) > Date.now() + LOW_STOCK_WAIT_MS - 60_000, true);

  part("Off takes it off the set");
  store = (await storeForEmail(OWNER)) as Store;
  is("off", await setLowStock(store, pid, 0, 4), "off");
  is("off the set", redis.run(["ZSCORE", LOW_STOCK_DUE, member]), null);
  is("and no number", await lowStockOf(store, pid), null);
  done();
}

void main();
