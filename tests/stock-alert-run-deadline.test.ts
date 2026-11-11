/**
 * One run of the back-in-stock job keeps to its deadline (623 [SZ7], unit 3; Claude 3's LOW 5 on #3620): a product is
 * started only when what is left of the run holds the slowest stock count (up to five Stripe reads of two seconds), and
 * a product whose stock count ran past the deadline sends nothing that run. It waits, and goes on the next run.
 * Synthetic stand-ins only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setProductExtras, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { STOCK_ALERT_DUE, askStockAlert, confirmStockAlert, dueMember } from "@/lib/stock-alerts";
import { type RestockDeps, runRestocks } from "@/lib/stock-alert-send";
import { readListing } from "@/lib/catalog";
import { stockLeft } from "@/lib/stock";
import { storeForIdExactly } from "@/lib/store-exact";
import { sendBatch, type BatchMessage } from "@/lib/email";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "deadline-owner@example.com";

function sender() {
  const sent: BatchMessage[][] = [];
  const send = (async (messages: BatchMessage[]) => {
    sent.push(messages);
    return "sent" as const;
  }) as typeof sendBatch;
  return { sent, send };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle(OWNER, "deadline", "Deadline Prints", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_deadline", subscriptionId: "sub_deadline", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Deadline Prints", address: "12 Harbor Road, Portland, ME 04101" });
  const made = await addProduct(OWNER, "Print", "", "40", null);
  if (!made.ok) throw new Error("no product");
  await setProductExtras(OWNER, made.product.id, { stock: 1 });
  const pid = made.product.id;
  let store = (await storeForEmail(OWNER)) as Store;
  redis.run(["HSET", `nl:stock:${store.statsId}:${pid}`, "cs_sold", JSON.stringify({ until: 0, paid: true })]);
  for (const name of ["ana", "bo", "cy"]) {
    const asked = await askStockAlert({ store, productId: pid, email: `${name}@example.com`, left: 0 });
    if (!asked.ok) throw new Error("not asked");
    await confirmStockAlert(asked.confirm, store);
  }
  store = (await storeForEmail(OWNER)) as Store;
  redis.run(["DEL", `nl:stock:${store.statsId}:${pid}`]);
  const member = dueMember(store.sid!, pid);
  const makeDue = () => redis.run(["ZADD", STOCK_ALERT_DUE, 0, member]);
  let reads = 0;
  const real: RestockDeps = { load: storeForIdExactly, readProduct: readListing, left: (s, p) => { reads += 1; return stockLeft(s, p); }, send: sendBatch };
  const realNow = Date.now;

  part("Too little of the run left for a stock count: the product is not started");
  makeDue();
  const short = sender();
  is("nothing sent", await runRestocks(Date.now() + 5_000, { ...real, send: short.send }), 0);
  is("its stock is not even counted", reads, 0);
  is("it is still due", redis.run(["ZSCORE", STOCK_ALERT_DUE, member]) !== null, true);

  part("A stock count that ran past the deadline: nothing sent this run");
  makeDue();
  const slow = sender();
  try {
    const deadline = Date.now() + 15_000;
    const slowLeft: RestockDeps["left"] = async (s, p) => {
      const left = await stockLeft(s, p);
      const at = realNow() + 16_000;
      Date.now = () => at;
      return left;
    };
    is("nothing sent", await runRestocks(deadline, { ...real, left: slowLeft, send: slow.send }), 0);
    is("the email service is not called past the deadline", slow.sent.length, 0);
  } finally {
    Date.now = realNow;
  }
  is("it is still listed for the next run", redis.run(["ZSCORE", STOCK_ALERT_DUE, member]) !== null, true);

  part("The next run, with time: everyone gets their one email");
  makeDue();
  const next = sender();
  is("three emails", await runRestocks(Date.now() + 30_000, { ...real, send: next.send }), 3);
  is("each address once", next.sent.flat().map((m) => m.to).sort(), ["ana@example.com", "bo@example.com", "cy@example.com"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
