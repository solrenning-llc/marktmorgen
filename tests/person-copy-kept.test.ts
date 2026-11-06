/**
 * 619 [SZ3] unit 4: what the erasure keeps on purpose is in the person's
 * copy too (lib/person-data.ts, "kept"): license keys they bought, their
 * PayPal orders, their pre-orders, and, while the store closes, that they are
 * to be told. Only theirs: another buyer's records stay out.
 */
import { claimHandle, addProduct, ensureListId, ensureStatsId, setProductKeys, storeForEmail, storeFolder, storeRef } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { keyForSale } from "@/lib/licence-keys";
import { addressHash } from "@/lib/imported-purchases";
import { toldKey } from "@/lib/closing-buyers";
import { erasureScope } from "@/lib/person-erasure";
import { COPIERS, COPY_PLAN } from "@/lib/person-copy";
import { setSubscription } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "keptowner@example.com";
const PERSON = "kim@example.com";
const OTHER = "lee@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "keptshop", "Kept Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Kept00001", subscriptionId: "sub_Kept00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Plugin", "A plugin.", "49", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  await setProductKeys(OWNER, id, DEFAULT_KEYS);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, id))!;
  const mine = await keyForSale(store, product, "cs_test_" + "k".repeat(58), PERSON);
  await keyForSale(store, product, "cs_test_" + "l".repeat(58), OTHER);
  const statsId = store.statsId!;
  redis.run(["SADD", `nl:ppsell:own:${statsId}:${addressHash(PERSON)}:${id}`, "ORDER12345AB"]);
  redis.run(["SET", "nl:ppsell:paid:ORDER12345AB", JSON.stringify({ store: statsId, order: "ORDER12345AB", capture: "CAP1", email: PERSON, product: id, cents: 4900, currency: "usd", at: 1_790_000_000 })]);
  redis.run(["HSET", `nl:pre:${statsId}:${id}`, "cs_test_" + "p".repeat(20), JSON.stringify({ to: PERSON, at: 1_790_000_000, pi: "pi_1" }), "cs_test_" + "q".repeat(20), JSON.stringify({ to: OTHER, at: 1_790_000_000, pi: "pi_2" })]);
  redis.run(["HSET", toldKey(await storeFolder(storeRef(store))), PERSON, "x"]);
  const scope = { ...(await erasureScope(store, PERSON))!, productIds: [id] };

  part("Kept on purpose, and still theirs to see");
  const modules = ["lib/licence-keys.ts", "lib/paypal-sales.ts", "lib/preorders.ts", "lib/closing-buyers.ts"];
  is("all four are copied", modules.map((m) => COPY_PLAN[m].how), modules.map(() => "copied"));
  const [keys, paypal, pre, told] = await Promise.all(modules.map((m) => COPIERS[m](scope)));
  is("their key, and only theirs", keys.map((k) => (k as { key: string }).key), [mine?.state === "issued" ? mine.key : ""]);
  is("their PayPal order", paypal.map((o) => (o as { order: string }).order), ["ORDER12345AB"]);
  is("their pre-order, not the other buyer's", pre.map((p) => (p as { to: string }).to), [PERSON]);
  is("on the list to be told the store closes, not told yet", told, [{ toldTheStoreCloses: "not yet" }]);
  is("the other buyer's address is in none of it", JSON.stringify([keys, paypal, pre, told]).includes(OTHER), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
