/**
 * One run of the back-in-stock job never sends more than RESTOCK_RUN_EMAILS, a batch left waiting from an earlier
 * run included (623 [SZ7], unit 3; Claude 3's LOW 4 on #3620): a waiting batch larger than what is left of the run
 * waits for the next run. Synthetic stand-ins only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setProductExtras, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { STOCK_ALERT_DUE, askStockAlert, confirmStockAlert, dueMember } from "@/lib/stock-alerts";
import { RESTOCK_RUN_EMAILS, type RestockDeps, runRestocks } from "@/lib/stock-alert-send";
import { readListing } from "@/lib/catalog";
import { stockLeft } from "@/lib/stock";
import { storeForIdExactly } from "@/lib/store-exact";
import { sendBatch, type BatchMessage } from "@/lib/email";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "ceiling-owner@example.com";

function sender(outcome: "sent" | "retry") {
  const sent: BatchMessage[][] = [];
  const send = (async (messages: BatchMessage[]) => {
    sent.push(messages);
    return outcome;
  }) as typeof sendBatch;
  return { sent, send };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle(OWNER, "ceiling", "Ceiling Prints", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ceiling", subscriptionId: "sub_ceiling", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Ceiling Prints", address: "12 Harbor Road, Portland, ME 04101" });
  const sizes = [80, 80, 80, 100];
  const products: string[] = [];
  for (const [p, size] of sizes.entries()) {
    const made = await addProduct(OWNER, `Print ${p}`, "", "40", null);
    if (!made.ok) throw new Error("no product");
    await setProductExtras(OWNER, made.product.id, { stock: 1 });
    products.push(made.product.id);
    const store = (await storeForEmail(OWNER)) as Store;
    redis.run(["HSET", `nl:stock:${store.statsId}:${made.product.id}`, "cs_sold", JSON.stringify({ until: 0, paid: true })]);
    for (let i = 0; i < size; i += 1) {
      const asked = await askStockAlert({ store, productId: made.product.id, email: `p${p}-reader${i}@example.com`, left: 0 });
      if (!asked.ok) throw new Error("not asked");
      await confirmStockAlert(asked.confirm, store);
    }
  }
  const store = (await storeForEmail(OWNER)) as Store;
  // Back in stock: one unit left on each.
  for (const pid of products) redis.run(["DEL", `nl:stock:${store.statsId}:${pid}`]);
  const real: RestockDeps = { load: storeForIdExactly, readProduct: readListing, left: (s, p) => stockLeft(s, p), send: sendBatch };
  const makeDue = () => { for (const pid of products) redis.run(["ZADD", STOCK_ALERT_DUE, 0, dueMember(store.sid!, pid)]); };

  part("Batches left waiting by an earlier run are kept inside the run's ceiling");
  makeDue();
  const lost = sender("retry");
  await runRestocks(Date.now() + 30_000, { ...real, send: lost.send });
  is("the first run wrote a batch for each product and none went", lost.sent.length, products.length);
  makeDue();
  const next = sender("sent");
  const count = await runRestocks(Date.now() + 30_000, { ...real, send: next.send });
  const written = next.sent.reduce((n, b) => n + b.length, 0);
  is("never more than RESTOCK_RUN_EMAILS in one run", [written <= RESTOCK_RUN_EMAILS, count <= RESTOCK_RUN_EMAILS], [true, true]);
  makeDue();
  const last = sender("sent");
  await runRestocks(Date.now() + 30_000, { ...real, send: last.send });
  is("the rest go on the next run: every address once", next.sent.flat().length + last.sent.flat().length, sizes.reduce((a, b) => a + b, 0));
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
