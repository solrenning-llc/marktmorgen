/**
 * Nothing is published that has nothing to hand over (754 [STN1], unit 2).
 *
 * Publishing a draft (the product route's "visibility" action, hidden false)
 * is refused while the product hands nothing over by the checkout's own rule
 * (lib/product-option.ts handsOver: a file, a link, a course with a lesson, a
 * call, a podcast with an episode, something shipped, or a bundle). It stays
 * hidden, and the editor says what to add. Taking a product off the store is
 * never refused. Once it has a link, it publishes.
 *
 * Synthetic store and products, against the in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as productRoute } from "@/app/api/store/product/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "publisher@example.com";
  await claimHandle(owner, "publisher", "Publisher", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Publxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_pub", subscriptionId: "sub_pub", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(owner);
  const send = async (body: Record<string, unknown>) => {
    const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };

  const made = await addProduct(owner, "The Bread Guide", "How I bake every day", "19", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  // The store record changes with every product write, so it is read again each time.
  const listing = async () => readListing((await storeForEmail(owner))!, id);
  const hidden = async () => (await listing())?.hidden;
  await setProductHidden(owner, id, true);
  const draft = await listing();
  is("a draft with nothing to hand over", [draft?.hidden, draft?.file ?? null, draft?.link ?? null], [true, null, null]);

  part("Publishing a product with nothing to hand over is refused, and it stays a draft");
  const early = await send({ action: "visibility", id, hidden: false });
  is("refused, said why", [early.status, early.body.error], [409, "nothing_to_hand_over"]);
  is("still hidden", await hidden(), true);

  part("Taking a product off the store is never refused");
  const off = await send({ action: "visibility", id, hidden: true });
  is("hidden again, fine", [off.status, off.body.ok, await hidden()], [200, true, true]);

  part("With something to hand over, it publishes");
  const linked = await setProductLink(owner, id, "https://example.com/the-bread-guide");
  is("a link added", linked.ok, true);
  const now = await send({ action: "visibility", id, hidden: false });
  is("published", [now.status, now.body.ok, await hidden()], [200, true, false]);

  part("The editor says what to add, in plain words");
  const editor = readFileSync("components/product-editor.tsx", "utf8");
  // Claude 3 on #3432, LOW 1: the sentence fits every kind handsOver refuses (podcast, bundle, call, options).
is("the refusal has its own sentence, for every kind of product", editor.includes('nothing_to_hand_over: "This has nothing to hand over yet. Add what buyers get (a file or link, its lessons, episodes or products), give each price option one, or sell a call at one price, then publish it."'), true);

  done();
}

main();
