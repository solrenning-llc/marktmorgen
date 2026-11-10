/**
 * The shared-link card of a product (app/[handle]/p/[product]/opengraph-image.tsx)
 * follows the store's state: a store switched off after notices
 * (lib/takedown.ts, `suspended`) shows no product on its pages, so its card
 * names no product either and is drawn as the plain card a missing product
 * gets. A store whose record cannot be read is drawn the same way. A live
 * store's card is unchanged, and so is the one of a store switched back on.
 *
 * Synthetic store in the in-memory Redis of the tests; next/og is a stub
 * (tests/aliases/product-card-store-off.test.ts.json).
 */
import OpengraphImage from "@/app/[handle]/p/[product]/opengraph-image";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setProductHidden, setSubscription } from "@/lib/store";
import { lastCard, wordsOf } from "./og-card-stub";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "glaze-owner@example.com";
const TITLE = "Synthetic glazing guide";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "glazeworks", "Glaze Works", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_glaze00001", subscriptionId: "sub_glaze00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, TITLE, "A synthetic product for the card test", "149", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;

  const card = async (): Promise<string> => {
    await OpengraphImage({ params: Promise.resolve({ handle: "@glazeworks", product: id }) });
    return wordsOf(lastCard());
  };
  const plainOf = async (): Promise<string> => {
    await OpengraphImage({ params: Promise.resolve({ handle: "@glazeworks", product: "nosuchproduct" }) });
    return wordsOf(lastCard());
  };

  part("Live store: the card names the product, its price and its store");
  const live = await card();
  is("names the product", live.includes(TITLE), true);
  is("shows its price", live.includes("149"), true);
  is("names the store", live.includes("Glaze Works"), true);
  const plain = await plainOf();
  is("a missing product gets the plain card, without the product", plain.includes(TITLE), false);

  part("A store record that cannot be read: the plain card");
  const pipeline = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: unknown }).pipeline = async () => {
    throw new Error("synthetic unavailable reply");
  };
  const unread = await card();
  (redis as unknown as { pipeline: unknown }).pipeline = pipeline;
  is("an unreadable reply does not name the product", unread.includes(TITLE), false);

  part("Switched off after notices: the plain card, nothing of the product");
  const off = await noteTakedown(OWNER, null, true);
  if (!off?.suspended) throw new Error("store not switched off");
  const dark = await card();
  is("does not name the product", dark.includes(TITLE), false);
  is("does not show its price", dark.includes("149"), false);
  is("is the same card a missing product gets", dark, plain);

  part("Switched back on: the card is the live one again");
  await noteTakedown(OWNER, null, false);
  is("the same card as before the switch-off", await card(), live);

  part("A draft: the plain card, as before");
  await setProductHidden(OWNER, id, true);
  is("a draft is not named", (await card()).includes(TITLE), false);
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
