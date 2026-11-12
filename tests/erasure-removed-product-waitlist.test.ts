/**
 * A person's place on the waitlist of a product the creator later removed is
 * still their personal data: deleting that person deletes it too.
 *
 * The erasure looked only at the products the store lists now, and removing a
 * product (lib/store.ts, removeProduct, and its route) never deletes its
 * waitlist, so the address stayed in the waitlist kept for the removed product
 * while the erasure answered that everything was deleted, and the copy of
 * their data (lib/person-copy.ts) left that place out.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, removeProduct, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { joinWaitlist, setSoon, waitlistPlacesOf } from "@/lib/waitlist";
import { erasePerson } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const single: { text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    single.push(JSON.parse(String(init?.body)) as { text: string });
    return new Response(JSON.stringify({ id: `email_${single.length}` }));
  }
  if (url.hostname.endsWith("stripe.com")) return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_removed_waitlist";
  const owner = "owner@example.com";
  await claimHandle(owner, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const made = await addProduct(owner, "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  // A second product, so the store still lists something after the first goes.
  const kept = await addProduct(owner, "The Cake Book", "", "29", null);
  if (!kept.ok) throw new Error("no second product");
  let store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  // Her place is kept from the moment she joins, whether or not the confirming email went out.
  await joinWaitlist({ store, product, email: "dana@example.com", consent: false, ip: "1.1.1.1", origin: "https://marktmorgen.com" });
  const listKey = `nl:wl:${store.statsId}:${product.id}`;
  is("her address is on the product's waitlist", typeof redis.run(["HGET", listKey, "dana@example.com"]), "string");

  part("The creator removes the product, then Dana deletes herself");
  is("removed", (await removeProduct(owner, product.id)).ok, true);
  store = (await storeForEmail(owner))!;
  const copied = await waitlistPlacesOf(store.statsId, store.catalog.items.map((item) => item.id), "dana@example.com");
  is("the copy of her data still shows that place", copied.map((place) => place.product), [product.id]);
  const erased = await erasePerson(store, "dana@example.com", { kind: "person" });
  is("the erasure says it finished", erased.ok, true);
  is("her address is not kept on the removed product's waitlist", redis.run(["HGET", listKey, "dana@example.com"]), null);
}

main().then(done, (error: unknown) => {
  console.error(error);
  process.exit(1);
});
