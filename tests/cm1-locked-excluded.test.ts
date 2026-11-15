/**
 * Codex U's MEDIUM on #3007 (lib/community-locked.ts lockedSpaces / unlocksOf): the spaces the member was let into
 * (`opened`) and those whose answer could not be read (`unchecked`) are taken off the locked list, but unlocksOf
 * rebuilt it from every shown space and read and charged their products too. An open space with many products
 * could spend the store's public requests or the cap meant for the spaces really locked, and turn one of them
 * "capped" or the whole page into "resting". Only the products of the spaces shown as locked are read and paid.
 * Synthetic store, the stand-in Redis and a stubbed Stripe.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setCommunity, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { type CommunityConfig, freshConfig, newItemId } from "@/lib/community";
import { lockedSpaces } from "@/lib/community-locked";
import { collectionUnits } from "@/lib/page-read-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "cm1-excluded-owner@example.com";

async function made(title: string, price: string, hidden = false): Promise<string> {
  const added = await addProduct(OWNER, title, "", price, null);
  if (!added.ok) throw new Error(`no product ${title}`);
  await setProductLink(OWNER, added.product.id, `https://example.com/${added.product.id}`);
  if (hidden) await setProductHidden(OWNER, added.product.id, true);
  return added.product.id;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_cm1_excluded_only_a_stand_in";
  await claimHandle(OWNER, "lockedexcluded", "Locked Excluded", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLkExcl001", true);
  await setSubscription(OWNER, { customerId: "cus_LockedExcl001", subscriptionId: "sub_LockedExcl001", active: true, tier: "scale", period: paidPeriod() } as never);
  const openProducts: string[] = [];
  for (let n = 0; n < 12; n++) openProducts.push(await made(`Open ${n}`, "5", true));
  const uncheckedProducts: string[] = [];
  for (let n = 0; n < 6; n++) uncheckedProducts.push(await made(`Unchecked ${n}`, "5", true));
  const lockedProduct = await made("Locked pass", "19");
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const [open, unchecked, locked] = [newItemId(), newItemId(), newItemId()];
  const config: CommunityConfig = {
    ...freshConfig(store.name),
    access: [...openProducts, ...uncheckedProducts, lockedProduct],
    spaces: [
      { id: newItemId(), name: "General", about: "", creatorOnly: false, only: [], level: 0 },
      { id: open, name: "Open", about: "", creatorOnly: false, only: openProducts, level: 0, shown: true },
      { id: unchecked, name: "Unchecked", about: "", creatorOnly: false, only: uncheckedProducts, level: 0, shown: true },
      { id: locked, name: "Locked", about: "", creatorOnly: false, only: [lockedProduct], level: 0, shown: true },
    ],
  };

  part("Only the spaces shown as locked are read and paid");
  let paid = 0;
  const shown = await lockedSpaces(store, config, new Set([open]), async (units) => { paid += units; return true; }, new Set([unchecked]));
  is("the open space is not listed, the unchecked one is, the locked one has its way in", shown?.map((s) => [s.name, typeof s.unlock === "object" ? "link" : s.unlock]).sort(), [["Locked", "link"], ["Unchecked", "unchecked"]]);
  is("what was paid is the one locked product's read, not the open or unchecked spaces' products", paid, collectionUnits(1));

  part("A tight allowance meant for the locked space is not spent on the others");
  let left = collectionUnits(1);
  const tight = await lockedSpaces(store, config, new Set([open]), async (units) => { if (units > left) return false; left -= units; return true; }, new Set([unchecked]));
  is("the page is not turned into resting", tight === null, false);
  is("the locked space still has its way in", tight?.find((s) => s.name === "Locked")?.unlock && typeof tight?.find((s) => s.name === "Locked")?.unlock === "object", true);
  done();
}

void main();
