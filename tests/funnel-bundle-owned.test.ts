/**
 * A bundle paid for as an offer after paying hands over what it holds (lib/funnel.ts; DISC-B-2).
 *
 * Until this fix, a paid offer added only the bundle's own id to what the buyer has, so a later offer of a product
 * inside that bundle was shown and charged again; and the studio's "repeat" check compared product ids only, so it
 * saved such a funnel. A funnel saved before the bundle came to hold the product could not be caught when it was
 * saved at all.
 *
 *   - the studio refuses a funnel whose offer after a yes is a product the bundle bought before it holds;
 *   - a funnel saved while the bundle did not hold it, the product put in the bundle afterward: once the bundle is
 *     paid, the offer of that product is passed over (its "no" path is followed), never offered and charged.
 */
import { addProduct, claimHandle, ensureStatsId, setProductBundle, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListings, readProduct } from "@/lib/catalog";
import { funnelPosition, stepSlot, type Funnel, type StepAnswer } from "@/lib/funnel";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_funnel_bundle_owned_only";

const OWNER = "pantry@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pantry", "Pantry Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestFunnelBundle1", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const add = async (title: string, price: string, link = true) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    if (link) await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Sourdough Course", "49");
  const guide = await add("Field Guide", "29");
  const sheet = await add("Cheat Sheet", "19");
  const cards = await add("Recipe Cards", "9");
  const extra = await add("Starter Checklist", "15");
  const pack = await add("Kitchen Pack", "39", false);
  is("the bundle holds the guide, the sheet and the cards", (await setProductBundle(OWNER, pack, [guide, sheet, cards])).ok, true);

  const funnel: Funnel = {
    steps: [
      { id: "pack01", productId: pack, priceCents: 3000, headline: "", text: "", imageFrom: null, yes: "sheet1", no: null },
      { id: "sheet1", productId: sheet, priceCents: 900, headline: "", text: "", imageFrom: null, yes: null, no: "list01" },
      { id: "list01", productId: extra, priceCents: 700, headline: "", text: "", imageFrom: null, yes: null, no: null },
    ],
  };

  part("RED: DISC-B-2: the studio refuses an offer, after a yes to a bundle, of a product inside it");
  const refused = await setProductFunnel(OWNER, front, funnel);
  is("RED: DISC-B-2: refused as a repeat", refused.ok ? "saved" : refused.reason, "repeat");

  part("RED: DISC-B-2: a bundle that came to hold the product after the funnel was saved");
  is("the bundle without the sheet", (await setProductBundle(OWNER, pack, [guide, cards])).ok, true);
  is("the funnel is saved then", (await setProductFunnel(OWNER, front, funnel)).ok, true);
  is("and the sheet put in the bundle afterward", (await setProductBundle(OWNER, pack, [guide, sheet, cards])).ok, true);
  const store = (await storeForEmail(OWNER))!;
  const saved = (await readProduct(store, front))!.funnel!;
  const offered = await readListings(store, [pack, sheet, extra]);
  const paidBundle = new Map<string, StepAnswer>([[stepSlot(saved, saved.steps[0]), "paid"]]);
  const position = funnelPosition(saved, offered, paidBundle, new Set([front]));
  is(
    "RED: DISC-B-2: after the bundle is paid, the sheet inside it is passed over and the next offer is the checklist",
    position.kind === "offer" ? position.target.id : position.kind,
    extra,
  );
  const nothingPaid = funnelPosition(saved, offered, new Map(), new Set([front]));
  is("before anything is paid, the bundle is the first offer", nothingPaid.kind === "offer" ? nothingPaid.target.id : nothingPaid.kind, pack);
  const ownsSheet = funnelPosition(saved, offered, paidBundle, new Set([front, sheet]));
  is("a product owned on its own is passed over too, as before", ownsSheet.kind === "offer" ? ownsSheet.target.id : ownsSheet.kind, extra);

  done();
}

void main();
