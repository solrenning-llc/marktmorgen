/**
 * Codex's MEDIUM on #1824 @ 48fc8e11e6: a membership whose schedule cannot be read is never taken for a one-off
 * product by the policy page's strict reader (lib/catalog.ts readListingsAll), wherever the listing is read from:
 * the store record's head, a record from before product records (inline), or Redis. Each such read is unknown, and
 * the page is never drawn without its membership section. A readable schedule, and no schedule, read as before.
 *
 * Synthetic only: a stand-in Redis and a real writer; the head and inline listings are the real listing, with only
 * its `recurring` made unreadable, as a store record would carry it.
 */
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { parseCatalog, type Catalog } from "@/lib/catalog";
import { policyInput } from "@/lib/store-policy-input";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Entry = Record<string, unknown>;

async function outcome(store: Parameters<typeof policyInput>[0]): Promise<string> {
  try {
    const input = await policyInput(store);
    return JSON.stringify({ digital: input.sellsDigital, memberships: input.sellsMemberships });
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "g-schedule@example.test";
  await claimHandle(owner, "gschedule", "G Schedule Shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_GSched001", subscriptionId: "sub_GSched001", active: true, period: paidPeriod() });
  const member = await addProduct(owner, "A paid membership", "", "9", { interval: "month", trialDays: 0, payments: 0 });
  if (!member.ok) throw Error("fixture membership failed");
  const store = (await storeForEmail(owner))!;
  const listing = store.catalog.head.find((p) => p.id === member.product.id);
  is("(the membership is in the head, with its schedule)", Boolean(listing?.recurring), true);
  is("a readable schedule reads as a membership", await outcome(store), JSON.stringify({ digital: false, memberships: true }));
  const entry = JSON.parse(JSON.stringify(listing)) as Entry;
  const items = store.catalog.items.map((item) => [item.id, item.kind, ...item.options]);
  const withHead = (head: Entry[]): Catalog => parseCatalog({ id: store.catalog.id, items, head }, undefined);
  const withInline = (products: Entry[]): Catalog => parseCatalog(undefined, products);

  for (const [what, recurring] of [
    ["a schedule with an unknown interval", { interval: "fortnight", trialDays: 0, payments: 0 }],
    ["a schedule that is a number", 7],
    ["a schedule that is text", "month"],
  ] as const) {
    part(what);
    const bad = { ...entry, recurring };
    is(`in the head: unknown, never a one-off`, await outcome({ ...store, catalog: withHead([bad]) }), "unknown");
    is(`inline: unknown, never a one-off`, await outcome({ ...store, catalog: withInline([bad]) }), "unknown");
  }

  part("no schedule, and a readable one, read as before");
  const none = { ...entry, recurring: null };
  is("no schedule in the head while its item says a membership: unknown, never a one-off", await outcome({ ...store, catalog: withHead([none]) }), "unknown");
  is("no schedule inline: a one-off sold digitally, not a membership", await outcome({ ...store, catalog: withInline([none]) }), JSON.stringify({ digital: true, memberships: false }));
  is("a readable schedule inline: a membership", await outcome({ ...store, catalog: withInline([entry]) }), JSON.stringify({ digital: false, memberships: true }));
  is("a readable schedule in the head: a membership", await outcome({ ...store, catalog: withHead([entry]) }), JSON.stringify({ digital: false, memberships: true }));
  done();
}

void main();
