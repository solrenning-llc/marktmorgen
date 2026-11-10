/**
 * A product kept for a child-safety report (lib/child-safety.ts,
 * C1-20261109-1546-TODOS-70) is never handed over through another product:
 * Claude 6's focal review of #3471 (review 5831883701) found that a bundle
 * that already held it before the report kept selling it, and that a
 * checkout box (order bump) set up before the report kept offering it, and
 * could still be pointed at it afterwards.
 *
 * Held here, through the functions the checkouts and pages read:
 *   - what a bundle offers (lib/bundles.ts, offeredItems) is nothing while one
 *     of its products is held, so its page does not sell it and no offer
 *     after paying names it (offerableAfterPaying, read by lib/upsell.ts);
 *   - the cart's checkout (lib/cart-checkout.ts) refuses a bundle holding a
 *     held product before anything reaches Stripe;
 *   - the single checkout's check (heldInSale, read by
 *     app/api/store/checkout/route.ts before lib/store-checkout.ts) refuses a
 *     bundle holding a held product and a ticked box whose product is held or
 *     is a bundle holding one; a hold that cannot be read refuses too;
 *   - the store page's boxes (lib/catalog.ts, readPage) leave a held product out;
 *   - a product page's boxes, and its embedded copy's, pass what they read
 *     through offerableTargets (lib/child-safety-holds.ts), so a held
 *     product's title is never drawn as a checkout box there;
 *   - the studio's extras route refuses a box pointing at a held product, or
 *     at a bundle holding one (409 on_hold).
 * Products not held are untouched by any of it.
 *
 * Nobody opens, downloads or describes reported content: the titles are
 * neutral placeholders and the products hand over a placeholder link.
 * Synthetic store, in-memory Redis, every outside call caught here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductBundle, setProductExtras, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import * as safety from "@/lib/child-safety";
import { readListing, readPage } from "@/lib/catalog";
import { offerableAfterPaying, offeredItems } from "@/lib/bundles";
import { createCartCheckout } from "@/lib/cart-checkout";
import { POST as extrasRoute } from "@/app/api/store/extras/route";
import { POST as savedBlocksRoute } from "@/app/api/store/saved-blocks/route";
import { sectionUsesKey } from "@/lib/saved-block-store";
import { emptyBlock, type PageBlock } from "@/lib/sales-page";
import { store as redis } from "./redis-stub";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_held_bundles_only";

/** Checkouts opened at Stripe; every other outside call answers 404. */
const opened: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    opened.push(new URLSearchParams(String(init.body)));
    return new Response(JSON.stringify({ id: "cs_test_heldbundle00001", url: "https://checkout.stripe.com/c/pay/cs_test_heldbundle00001" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404, headers: { "content-type": "application/json" } });
}) as typeof fetch;

type Handler = (request: NextRequest) => Promise<Response>;
type HeldInSale = (store: unknown, product: unknown, bumps: string[]) => Promise<string | null>;
const OWNER = "hold.bundles@example.com";
const HANDLE = "holdbundles";
const ORIGIN = "https://marktmorgen.com";
const ON_HOLD = [409, "on_hold"];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Hold Bundles", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHoldBnd01", true);
  await setSubscription(OWNER, { customerId: "cus_holdbundles", subscriptionId: "sub_holdbundles", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(OWNER);
  const send = async (route: Handler, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`${ORIGIN}/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" }, body: JSON.stringify(body) }));
    return [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];
  };
  const current = async () => (await storeForEmail(OWNER))!;
  const make = async (title: string, link = true) => {
    const made = await addProduct(OWNER, title, "", "19", null);
    if (!made.ok) throw new Error("no product");
    if (link) await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const listing = async (id: string) => (await readListing(await current(), id))!;
  const ids = (list: { id: string }[] | null | undefined) => (list ?? []).map((p) => p.id);
  const heldInSale = (safety as unknown as Record<string, unknown>).heldInSale as HeldInSale | undefined;
  const sale = async (id: string, bumps: string[]) => (heldInSale ? heldInSale(await current(), await listing(id), bumps) : "missing");
  const cart = async (products: string[]) => {
    const before = opened.length;
    const store = await current();
    const full = await Promise.all(products.map(async (id) => (await import("@/lib/catalog")).readProduct(store, id)));
    const answer = await createCartCheckout(store, full.map((p) => p!), ORIGIN, { digitalConsent: TEST_CONSENT }).then(
      () => "opened",
      () => "refused",
    );
    return [answer, opened.length - before];
  };

  // As a creator had set them up before the report.
  const reported = await make("reported-item-part");
  const partB = await make("item-part-b");
  const partC = await make("item-part-c");
  const partD = await make("item-part-d");
  const heldBundle = await make("item-bundle-with-reported", false);
  const cleanBundle = await make("item-bundle-clean", false);
  for (const [bundle, items] of [
    [heldBundle, [reported, partB]],
    [cleanBundle, [partC, partD]],
  ] as const) {
    const saved = await setProductBundle(OWNER, bundle, [...items]);
    if (!saved.ok) throw new Error(`bundle not saved: ${saved.reason}`);
  }
  const front = await make("item-front");
  for (const [slot, target] of [reported, heldBundle, partC].entries()) {
    const set = await setProductExtras(OWNER, front, { slot, bump: { productId: target, priceCents: 900, pitch: "" } });
    if (!set.ok) throw new Error(`box not set: ${set.reason}`);
  }
  const other = await make("item-other");

  part("Before the report: everything sells");
  is("the bundle with the product offers both", ids((await offeredItems(await current(), [await listing(heldBundle)])).get(heldBundle)), [reported, partB]);
  is("the cart opens with it", await cart([heldBundle, partC]), ["opened", 1]);

  // The report.
  const openedBefore = opened.length;
  const outcome = await safety.holdReported({ kind: "child_safety", url: `${ORIGIN}/@${HANDLE}/p/${reported}` }, await current());
  if (outcome !== "held") throw new Error(`not held: ${outcome}`);

  part("A bundle that held the product before the report");
  is("offers nothing on its page", ids((await offeredItems(await current(), [await listing(heldBundle)])).get(heldBundle)), []);
  is("is offered after paying by no funnel, the clean bundle still is", ids(await offerableAfterPaying(await current(), [await listing(heldBundle), await listing(cleanBundle), await listing(partC)])), [cleanBundle, partC]);
  is("the single checkout refuses it", await sale(heldBundle, []), "bundle");
  is("the cart refuses it before Stripe", await cart([heldBundle, partC]), ["refused", 0]);

  part("A checkout box set up before the report");
  is("the store page's boxes leave the held product out", ids((await readPage(await current(), 1)).related).includes(reported), false);
  // A product page, its embedded copy and a collection page draw a box's product the same way, from its own read:
  // each passes what it read through offerableTargets, so a held product's title is never drawn as a checkout box there.
  for (const page of ["app/[handle]/p/[product]/page.tsx", "app/embed/[handle]/[product]/page.tsx"]) {
    const source = readFileSync(join(process.cwd(), page), "utf8");
    const reads = source.match(/readListings\(store, bumpTargets\(product\)\)[^\n]*/g) ?? [];
    is(`${page}: every box read goes through offerableTargets`, reads.length > 0 && reads.every((read) => read.includes("offerableTargets(store, found)")), true);
  }
  is("a checked box of the held product is refused", await sale(front, [reported]), "box");
  is("the first box checked the old way is refused too", await sale(front, ["yes"]), "box");
  is("a checked box of a bundle holding it is refused", await sale(front, [heldBundle]), "box");
  is("a checked box of a product not held goes on", await sale(front, [partC]), null);
  is("no box checked goes on", await sale(front, []), null);

  part("A box pointed at it after the report");
  is("at the held product", await send(extrasRoute as Handler, "extras", { id: other, bump: { productId: reported, price: "9", pitch: "" }, slot: 0 }), ON_HOLD);
  is("at a bundle holding it", await send(extrasRoute as Handler, "extras", { id: other, bump: { productId: heldBundle, price: "9", pitch: "" }, slot: 0 }), ON_HOLD);
  is("nothing was set", (await listing(other)).bumps, []);
  is("at a product not held, it is set", await send(extrasRoute as Handler, "extras", { id: other, bump: { productId: partC, price: "9", pitch: "" }, slot: 0 }), [200, "ok"]);

  part("Products not held");
  is("the clean bundle offers both", ids((await offeredItems(await current(), [await listing(cleanBundle)])).get(cleanBundle)), [partC, partD]);
  is("its checkout goes on", await sale(cleanBundle, []), null);
  is("its cart opens", await cart([cleanBundle, partB]), ["opened", 1]);
  is("nothing opened at Stripe since the report names the held product", opened.slice(openedBefore).some((body) => [...body.values()].some((value) => value.split(",").includes(reported))), false);

  part("A saved section applied to the held product's page (regression test asked in the same review)");
  const faq: PageBlock = { ...(emptyBlock("faq") as Extract<PageBlock, { kind: "faq" }>), items: [{ q: "A placeholder question?", a: "A placeholder answer." }] };
  const section = (await (await savedBlocksRoute(new NextRequest(`${ORIGIN}/api/store/saved-blocks`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" }, body: JSON.stringify({ action: "save", name: "Placeholder section", blocks: [faq] }) }))).json()) as { ok: boolean; section?: { id: string } };
  if (!section.ok || !section.section) throw new Error("no section");
  const statsId = (await current()).statsId!;
  // As a page's own save writes it down (lib/saved-block-store.ts, usesCommands): both product pages carry the section.
  await redis.pipeline([["SADD", sectionUsesKey(statsId, section.section.id), reported, partD]]);
  const applies = async () => ((await redis.pipeline([["SCAN", "0", "MATCH", "nl:fuse:m:apply:*", "COUNT", 1000]]))[0] as [string, string[]])[1].length;
  is("applied to the held product's page: on_hold", await send(savedBlocksRoute as Handler, "saved-blocks", { action: "apply", id: section.section.id, pages: [reported] }), ON_HOLD);
  is("with a page not held beside it: on_hold too, nothing applied", await send(savedBlocksRoute as Handler, "saved-blocks", { action: "apply", id: section.section.id, pages: [partD, reported] }), ON_HOLD);
  is("the month's tries were not counted", await applies(), 0);
  is("a page not held still takes it", await send(savedBlocksRoute as Handler, "saved-blocks", { action: "apply", id: section.section.id, pages: [partD] }), [200, "ok"]);

  part("A hold that cannot be read refuses (rule 24)");
  const store = await current();
  const tag = store.statsId || `h:${store.handle}`;
  await redis.pipeline([["SET", `nl:csa:keep:${tag}:${partC}`, "garbled"]]);
  is("the single checkout says unavailable", await sale(cleanBundle, []), "unavailable");
  is("the cart refuses", await cart([cleanBundle, partB]), ["refused", 0]);
  is("the extras route answers 503", await send(extrasRoute as Handler, "extras", { id: other, bump: { productId: cleanBundle, price: "9", pitch: "" }, slot: 1 }), [503, "unavailable"]);
  await redis.pipeline([["DEL", `nl:csa:keep:${tag}:${partC}`]]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
