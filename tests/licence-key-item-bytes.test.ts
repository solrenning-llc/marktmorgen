/**
 * The registry's room for one license key (tests/store-data-registry.ts, the key item of nl:keys:@lib/licence-keys.ts)
 * is never below what giving a key really writes into the store's room (issue #5125, coordinator a64c): the key's
 * sale line, its record and its line in the buyer's own list, measured on the Redis stub at their longest — the longest
 * address the code takes (MAX_EMAIL_LENGTH), the longest key (MAX_KEY_LENGTH) and the longest sale reference a key is
 * given under (an offer after paying on the longest checkout id the code reads, lib/buyer-orders.ts SESSION_ID_PATTERN,
 * with the longest step id, lib/funnel.ts STEP_ID_PATTERN) — for the product's first key and the person's first key,
 * which write the most. The registry item used to be 512 bytes, under the 1,312 a key wrote before the list existed.
 * Synthetic only.
 */
import { addKeys, keyForSale, MAX_KEY_LENGTH } from "@/lib/licence-keys";
import { MAX_EMAIL_LENGTH } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { dataKey } from "@/lib/store-data";
import { ITEM_DATA_BYTES } from "@/lib/store-data-rules";
import { FAMILIES, itemBytes } from "./store-data-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "item-bytes@example.com";
  await claimHandle(OWNER, "itembytes", "Item Bytes", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ItemBytes01", subscriptionId: "sub_ItemBytes01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Longest", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/longest");
  await setProductKeys(OWNER, made.product.id, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const keys = ["K", "L"].map((c) => c.repeat(MAX_KEY_LENGTH));
  if ((await addKeys(store, product, keys)).added !== keys.length) throw new Error("pool not filled");
  const room = dataKey(store)!;
  const charged = () => Number((redis.run(["HGET", room, "o"]) as string | null) ?? 0);
  const email = `${"a".repeat(64)}@${"b".repeat(MAX_EMAIL_LENGTH - 64 - 1 - 4)}.com`;
  const reference = (c: string) => `cs_live_${c.repeat(200)}:upsell:${"s".repeat(12)}`;

  part("The longest key, address and sale: what giving it charges the store's room");
  const before = charged();
  const first = await keyForSale(store, product, reference("x"), email);
  const firstBytes = charged() - before;
  const second = await keyForSale(store, product, reference("y"), email);
  const secondBytes = charged() - before - firstBytes;
  is("both keys given", [first?.state, second?.state], ["issued", "issued"]);
  is("the address is the longest the code takes", email.length, MAX_EMAIL_LENGTH);

  part("The registry holds at least that");
  const item = FAMILIES["nl:keys:@lib/licence-keys.ts"].parts!.find((p) => "item" in p) as { item: number };
  is(`the key item (${item.item}) is at least the product's and the person's first key (${firstBytes} bytes)`, item.item >= firstBytes, true);
  is(`and a later key (${secondBytes} bytes) is no dearer`, secondBytes <= firstBytes, true);
  is(`every product's parts (${itemBytes()}) fit ITEM_DATA_BYTES (${ITEM_DATA_BYTES})`, itemBytes() <= ITEM_DATA_BYTES, true);
  done();
}

void main();
