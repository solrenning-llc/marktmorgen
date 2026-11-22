/**
 * A person's copy reads only that person's license keys (issue #5125, row (1) licence-keys / licence-activations):
 * the copier used to read every product's whole hash of keys ever given (HGETALL of nl:keys:<store>:<product>:info,
 * kept for good and never capped) to keep the person's, and the devices part read it all a second time. One person's
 * copy cost grew with every key the store had ever given. It must read only the person's own keys, whichever sale
 * gave them: a checkout, an offer taken after paying (its own payment, `pi_`), or a product of a bundle. Synthetic
 * store and email, the Redis stub, no provider.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { keyForSale } from "@/lib/licence-keys";
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "keys-copy@example.com";
const DANA = "dana@example.com";

/** Every read the copy makes of a license key's hashes, as "COMMAND key field". */
async function readsOf<T>(run: () => Promise<T>): Promise<{ value: T; reads: string[] }> {
  const pipeline = redis.pipeline.bind(redis);
  const reads: string[] = [];
  const note = (c: (string | number)[]) => {
    const name = String(c[0]).toUpperCase();
    if (String(c[1] ?? "").startsWith("nl:keys:") && !["SET", "SADD", "HSET", "HSETNX", "DEL", "EXPIRE", "EVAL"].includes(name)) reads.push(c.map(String).join(" "));
  };
  redis.pipeline = (async (commands: (string | number)[][]) => {
    commands.forEach(note);
    return pipeline(commands);
  }) as typeof redis.pipeline;
  try {
    return { value: await run(), reads };
  } finally {
    redis.pipeline = pipeline;
  }
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "keycopy", "Key Copy", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_KeyCopy0001", subscriptionId: "sub_KeyCopy0001", active: true, period: paidPeriod() });
  const app = await addProduct(OWNER, "Copy App", "", "29", null);
  const plugin = await addProduct(OWNER, "Copy Plugin", "", "19", null);
  if (!app.ok || !plugin.ok) throw new Error("no products");
  for (const made of [app, plugin]) {
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "CPY", groups: 4, groupLength: 4, lowAt: 0 });
  }
  const store = (await storeForEmail(OWNER))!;
  const products = [(await readListing(store, app.product.id))!, (await readListing(store, plugin.product.id))!] as Listing[];

  // Six other buyers, one key of each product each; then Dana: the app from a checkout, the plugin from the same
  // checkout (a bundle's second product, same reference), and the app again from an offer taken after paying.
  const others: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    for (const product of products) {
      const given = await keyForSale(store, product, `cs_test_other${i}${"x".repeat(20)}`, `buyer${i}@example.com`);
      if (given?.state !== "issued") throw new Error("no key for another buyer");
      others.push(given.key);
    }
  }
  const danas: string[] = [];
  for (const [product, reference] of [[products[0], `cs_test_dana${"d".repeat(20)}`], [products[1], `cs_test_dana${"d".repeat(20)}`], [products[0], `pi_3DanaOffer${"o".repeat(14)}`]] as [Listing, string][]) {
    const given = await keyForSale(store, product, reference, DANA);
    if (given?.state !== "issued") throw new Error("no key for Dana");
    danas.push(given.key);
  }

  const scope = { store, statsId: store.statsId, listId: store.listId ?? null, email: DANA, productIds: products.map((p) => p.id) } as unknown as ErasureScope;

  part("Dana's copy holds her three keys, and only hers");
  const keys = await readsOf(() => COPIERS["lib/licence-keys.ts"](scope));
  const copied = (keys.value as { key: string }[]).map((k) => k.key).sort();
  is("her three keys, from a checkout, a bundle's product and an offer after paying", copied, [...danas].sort());
  is("no other buyer's key is in her copy", others.some((k) => copied.includes(k)), false);

  part("Reading them never reads the store's whole set of keys");
  is("no product's whole hash of keys given is read", keys.reads.filter((r) => /^(HGETALL|HVALS|HKEYS|HSCAN) nl:keys:.*:info/.test(r)).length, 0);
  is("no other buyer's key record is read", keys.reads.some((r) => others.some((k) => r.endsWith(` ${k}`))), false);

  part("The devices part reads only her keys too");
  const devices = await readsOf(() => COPIERS["lib/licence-activations.ts"](scope));
  is("no product's whole hash of keys given is read for the devices", devices.reads.filter((r) => /^(HGETALL|HVALS|HKEYS|HSCAN) nl:keys:.*:info/.test(r)).length, 0);
  is("no other buyer's key or devices are read", devices.reads.some((r) => others.some((k) => r.includes(k))), false);

  part("A person with no key reads no key record");
  const none = await readsOf(() => COPIERS["lib/licence-keys.ts"]({ ...scope, email: "nobody@example.com" } as ErasureScope));
  is("nothing copied", (none.value as unknown[]).length, 0);
  is("and no key record is read", none.reads.filter((r) => r.includes(":info")).length, 0);
  done();
}

void main();
