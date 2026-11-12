/**
 * The last thing a published product hands over is never taken off by two
 * studio tabs at once (754 [STN1]; Claude 7's LEVE on #3432).
 *
 * The routes checked the product (readDelivery) and then wrote in a separate
 * step: two tabs taking off the two price options' links at the same moment
 * both read the other one still there, both passed, and the product stayed
 * listed with nothing to hand over. The check is now made again under the
 * store's lock, in the same step as the write (setProductLink and
 * setProductFile with `keepLast`), so one of the two is refused.
 *
 * Synthetic store and products, against the in-memory Redis.
 */
import { NextRequest } from "next/server";
import { addOption, addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductFile, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { handsOver } from "@/lib/product-option";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as productRoute } from "@/app/api/store/product/route";
import { POST as attachRoute } from "@/app/api/store/file/attach/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "racer@example.com";
  await claimHandle(owner, "racer", "Racer", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Racexxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_race", subscriptionId: "sub_race", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(owner);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const unlink = (id: string) => productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers, body: JSON.stringify({ action: "unlink", id }) }));
  const detach = (id: string) => attachRoute(new NextRequest("https://marktmorgen.com/api/store/file/attach", { method: "POST", headers, body: JSON.stringify({ id, detach: true }) }));

  const made = await addProduct(owner, "The Rye Notes", "Two ways in", "29", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const one = await addOption(owner, id, "PDF", "29");
  const two = await addOption(owner, id, "Print", "39");
  if (!one.ok || !two.ok) throw new Error("no options");
  const options = ((await readListing((await storeForEmail(owner))!, id))?.options ?? []).map((option) => option.id);
  await setProductLink(owner, options[0], "https://example.com/rye-pdf");
  await setProductLink(owner, options[1], "https://example.com/rye-print");
  await setProductHidden(owner, id, false);

  part("Two tabs unlink the two options' links at the same moment");
  const [a, b] = await Promise.all([unlink(options[0]), unlink(options[1])]);
  is("one is refused as the last delivery", [a.status, b.status].sort(), [200, 409]);
  const after = await readListing((await storeForEmail(owner))!, id);
  is("the published product still hands something over", [after?.hidden, after ? handsOver(after) : null], [false, true]);

  part("A link taken off in one tab and a file in another, at the same moment");
  const mixed = await addProduct(owner, "The Wheat Notes", "Two ways in", "29", null);
  if (!mixed.ok) throw new Error("no product");
  const mixedId = mixed.product.id;
  const m1 = await addOption(owner, mixedId, "PDF", "29");
  const m2 = await addOption(owner, mixedId, "Print", "39");
  if (!m1.ok || !m2.ok) throw new Error("no options");
  const mixedOptions = ((await readListing((await storeForEmail(owner))!, mixedId))?.options ?? []).map((option) => option.id);
  const folder = await storeFolder(owner);
  await setProductFile(owner, mixedOptions[0], { pathname: `${folder}/${mixedOptions[0]}/wheat.pdf`, name: "wheat.pdf", bytes: 1000, contentType: "application/pdf", addedAt: new Date().toISOString() });
  await setProductLink(owner, mixedOptions[1], "https://example.com/wheat-print");
  await setProductHidden(owner, mixedId, false);
  const [c, d] = await Promise.all([detach(mixedOptions[0]), unlink(mixedOptions[1])]);
  is("one is refused as the last delivery", [c.status, d.status].sort(), [200, 409]);
  const mixedAfter = await readListing((await storeForEmail(owner))!, mixedId);
  is("the published product still hands something over", [mixedAfter?.hidden, mixedAfter ? handsOver(mixedAfter) : null], [false, true]);

  part("The store's own setters keep the check only when asked");
  const single = await addProduct(owner, "The Oat Sheet", "One page", "9", null);
  if (!single.ok) throw new Error("no product");
  await setProductLink(owner, single.product.id, "https://example.com/oat");
  await setProductHidden(owner, single.product.id, false);
  const kept = await setProductLink(owner, single.product.id, null, { keepLast: true });
  is("asked to keep the last delivery: refused", kept.ok ? "ok" : kept.reason, "last_delivery");
  is("without it (a plan closing): taken off", (await setProductLink(owner, single.product.id, null)).ok, true);

  done();
}

main();
