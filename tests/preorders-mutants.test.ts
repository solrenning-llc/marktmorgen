/**
 * Mutation testing of lib/preorders.ts (Claude 7, 13/11/2026): each case kills
 * a mutant that survived the tests importing the module. A pre-order is open
 * only for a product marked coming soon, with a day still ahead, that is shown,
 * that can be handed over later and in a store that can sell; what the studio
 * counts per product, and the coming-soon reads, are pinned.
 *
 * Synthetic only: Redis is tests/redis-stub.ts.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { isComingSoon, preorderDay, preorderViews, setExpectedDay, soonOne, soonState, waitingCount } from "@/lib/preorders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_preorders_mutants_stand_in";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Bread Book", "", "49", null);
  const second = await addProduct("owner@example.com", "Rye Book", "", "29", null);
  if (!made.ok || !second.ok) throw new Error("no product");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/bread");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  const sid = store.statsId as string;
  const p1 = made.product.id;
  const p2 = second.product.id;

  part("Coming soon");
  is("not marked: not coming soon", await isComingSoon(store, p1), false);
  await redis.pipeline([["SADD", `nl:wl:${sid}:soon`, p1]]);
  is("marked: coming soon", await isComingSoon(store, p1), true);
  is("a store with no records: never", await isComingSoon({ ...store, statsId: "" } as Store, p1), false);
  is("one product's read with no records", await soonOne({ ...store, statsId: "" } as Store, p1), { soon: false, day: null });
  await setExpectedDay(store, p1, "2099-05-01");
  await setExpectedDay(store, p2, "2099-06-01");
  is("one product's read", await soonOne(store, p1), { soon: true, day: "2099-05-01" });
  const state = await soonState(store);
  is("the store's read: who is coming soon, and every day", [[...state.soon], [...state.days.entries()].sort()], [[p1], ([[p1, "2099-05-01"], [p2, "2099-06-01"]] as [string, string][]).sort()]);
  is("the store's read with no records", await soonState({ ...store, statsId: "" } as Store), { soon: new Set(), days: new Map() });

  part("When a pre-order is open");
  const now = Date.UTC(2099, 0, 1);
  is("coming soon, a day ahead, shown, in a store that sells", preorderDay(store, product, true, "2099-05-01", now), "2099-05-01");
  is("not coming soon", preorderDay(store, product, false, "2099-05-01", now), null);
  is("no day", preorderDay(store, product, true, null, now), null);
  is("a day gone", preorderDay(store, product, true, "2098-12-31", now), null);
  is("hidden", preorderDay(store, { ...product, hidden: true } as Listing, true, "2099-05-01", now), null);
  is("something that cannot be handed over later (stock)", preorderDay(store, { ...product, stock: 5 } as Listing, true, "2099-05-01", now), null);
  is("a store that cannot sell", preorderDay({ ...store, stripeAccountId: null } as unknown as Store, product, true, "2099-05-01", now), null);

  part("What the studio counts");
  const entry = (to: string, over: Record<string, unknown> = {}) => JSON.stringify({ to, at: 1, pi: `pi_${to.length}`, ...over });
  await redis.pipeline([["HSET", `nl:pre:${sid}:${p2}`, "a", entry("a@example.com"), "b", entry("bb@example.com", { given: 5 }), "c", entry("ccc@example.com", { revoked: 6 })]]);
  const views = await preorderViews(store, [p1, p2, "prodnothing"]);
  is("a day and no orders yet", views[p1], { day: "2099-05-01", waiting: 0, given: 0, refunded: 0 });
  is("each product its own orders", views[p2], { day: "2099-06-01", waiting: 1, given: 1, refunded: 1 });
  is("neither a day nor orders: left out", Object.hasOwn(views, "prodnothing"), false);
  await setExpectedDay(store, p2, null);
  is("orders with no day still shown", (await preorderViews(store, [p2]))[p2], { day: null, waiting: 1, given: 1, refunded: 1 });
  is("no products asked: nothing", await preorderViews(store, []), {});
  is("no records: nothing", await preorderViews({ ...store, statsId: "" } as Store, [p1]), {});
  is("waiting, an unreadable entry counted as waiting", await redis.pipeline([["HSET", `nl:pre:${sid}:${p2}`, "d", "{not json"]]).then(() => waitingCount(store, p2)), 2);
  is("waiting with no records", await waitingCount({ ...store, statsId: "" } as Store, p2), 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
