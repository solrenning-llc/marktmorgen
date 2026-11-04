/**
 * The price an email named is gone (owner, C2-89, 4 November 2026): a
 * member's moving-in link (lib/move-members.ts) and a come-back offer
 * (lib/winback-send.ts) for a price option the creator has since removed,
 * even the last one, open nothing, never another option nor the product's
 * own price. Their pages say that price is no longer offered, with a link to
 * the product's page, in every language the store can use. No moving-in
 * email or reminder names another price instead. Stripe is played by a
 * stand-in for `fetch`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addOption, addProduct, claimHandle, ensureStatsId, removeOption, setLanguage, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { inviteEmail, inviteMembers, openMove, priceWords, readInvite } from "@/lib/move-members";
import { openWinBack } from "@/lib/winback-send";
import { namedPriceGone, namedPriceOffered } from "@/lib/product-option";
import { moveWords } from "@/lib/buyer-words/move";
import { membershipWords } from "@/lib/buyer-words/membership";
import { LANGUAGES } from "@/lib/store-language";
import MovePage from "@/app/[handle]/move/[product]/page";
import RenewPage from "@/app/[handle]/renew/[product]/page";
import { redisPipeline, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "price-gone@example.com";
const DAY = 86_400;
const nowS = Math.floor(Date.now() / 1000);
const checkouts: URLSearchParams[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"p".repeat(20)}${checkouts.length}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

/** A come-back offer as the weekly sweep keeps it (lib/winback-send.ts, sweepStore). */
async function comeBackOffer(statsId: string, product: string, option: string): Promise<string> {
  const token = Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40);
  await redisPipeline([["SET", `nl:wb:link:${token}`, JSON.stringify({ s: statsId, e: "dana@example.com", p: product, o: option, c: "co_Back0001", pc: 25, m: 1 }), "EX", 14 * DAY]]);
  return token;
}

const page = async (render: typeof MovePage | typeof RenewPage, handle: string, product: string, query: Record<string, string>) =>
  renderToStaticMarkup(await render({ params: Promise.resolve({ handle: `@${handle}`, product }), searchParams: Promise.resolve(query) }));

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_price_gone_only_a_stand_in";
  redis.clear();

  part("The rule");
  const two = { options: [{ id: "a" }, { id: "b" }] };
  is("an option still offered: not gone; one removed: gone", [namedPriceGone(two, "a"), namedPriceGone(two, "c")], [false, true]);
  is("the last option removed: gone, never the product's own price instead", namedPriceGone({ options: [] }, "a"), true);
  is("the product's own price named: gone once it sells only at its options", [namedPriceGone({ options: [] }, ""), namedPriceGone(two, "")], [false, true]);

  const made = await claimHandle(OWNER, "pricegone", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPriceGone1", true);
  await setSubscription(OWNER, { customerId: "cus_PriceGone01", subscriptionId: "sub_PriceGone01", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  const id = club.product.id;
  // The product's own link too, so it still sells with no option left: the case that once opened at its own price.
  await setProductLink(OWNER, id, "https://example.com/club");
  await addOption(OWNER, id, "Basic", "19");
  await addOption(OWNER, id, "Plus", "39");
  // Kept with nothing to hand over yet: not offered by the checkout.
  await addOption(OWNER, id, "Bare", "49");
  let store = (await storeForEmail(OWNER))!;
  const [basic, plus, bare] = (await readProduct(store, id))!.options.map((o) => o.id);
  await setProductLink(OWNER, basic, "https://example.com/basic");
  await setProductLink(OWNER, plus, "https://example.com/plus");
  store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;

  const renews = nowS + 20 * DAY;
  const [plusField, basicField, bareField] = await inviteMembers(store, "job_pricegone", [
    { email: "ada@example.com", productId: id, option: plus, renews },
    { email: "ben@example.com", productId: id, option: basic, renews },
    { email: "cy@example.com", productId: id, option: bare, renews },
  ]);
  if (!plusField || !basicField || !bareField) throw new Error("not invited");
  const bareInvite = (await readInvite(statsId, bareField))!;
  const bareOffer = await comeBackOffer(statsId, id, bare);
  const plusInvite = (await readInvite(statsId, plusField))!;
  const basicInvite = (await readInvite(statsId, basicField))!;
  const plusOffer = await comeBackOffer(statsId, id, plus);
  const basicOffer = await comeBackOffer(statsId, id, basic);

  part("While the price is offered, both open at it");
  const movedPlus = await openMove(store, id, plusInvite.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("the moving-in link opens Plus", [movedPlus.ok, checkouts.at(-1)?.get("metadata[option]")], [true, plus]);
  const backPlus = await openWinBack(store, id, plusOffer, "https://marktmorgen.com", TEST_CONSENT);
  is("the come-back offer opens Plus", [backPlus.ok, checkouts.at(-1)?.get("metadata[option]")], [true, plus]);

  part("An option kept with nothing to hand over");
  let product = (await readProduct(store, id))!;
  const atStart = checkouts.length;
  const moveBare = await openMove(store, id, bareInvite.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  const backBare = await openWinBack(store, id, bareOffer, "https://marktmorgen.com", TEST_CONSENT);
  is("not on sale: the general answer, never \"refused\" for ever nor \"price\", and no checkout", [namedPriceOffered(product, bare), moveBare.ok ? "opened" : moveBare.reason, backBare.ok ? "opened" : backBare.reason, checkouts.length], [false, "unavailable", "unavailable", atStart]);
  is("no email or reminder names it", [priceWords(store, product, bare), await inviteEmail(store, bareField)], [null, null]);
  const bareBack = await page(RenewPage, "pricegone", id, { back: bareOffer });
  is("its come-back page offers nothing and says so, not that the offer ended", [bareBack.includes(membershipWords("en").comeBackWith), bareBack.includes(membershipWords("en").offerNotices.unavailable.replace(/'/g, "&#x27;")), bareBack.includes("This offer has ended")], [false, true, false]);
  await removeOption(OWNER, bare);
  store = (await storeForEmail(OWNER))!;

  part("One of several removed");
  await removeOption(OWNER, plus);
  store = (await storeForEmail(OWNER))!;
  product = (await readProduct(store, id))!;
  const before = checkouts.length;
  const move1 = await openMove(store, id, plusInvite.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  const back1 = await openWinBack(store, id, plusOffer, "https://marktmorgen.com", TEST_CONSENT);
  is("both say the price is gone, and no checkout opens", [move1.ok ? "opened" : move1.reason, back1.ok ? "opened" : back1.reason, checkouts.length], ["price", "price", before]);
  is("no email or reminder names another price", [priceWords(store, product, plus), await inviteEmail(store, plusField)], [null, null]);
  is("Basic's link still opens at Basic", (await openMove(store, id, basicInvite.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT)).ok, true);
  checkouts.length = before;
  const links = (html: string) => html.split(`href="/@pricegone/p/`).length - 1;
  const plusBack = await page(RenewPage, "pricegone", id, { back: plusOffer });
  is("the come-back page: no checkout form and no Renew button, one link to the product's page", [plusBack.includes(`action="/api/store/checkout"`), plusBack.includes(`action="/api/store/come-back/open"`), plusBack.includes("Renew The Inner Circle"), links(plusBack)], [false, false, false, 1]);
  const limitedMove = await page(MovePage, "pricegone", id, { k: plusInvite.t, status: "limited" });
  is("the moving-in page with the price gone never says to press a button that is not there", [limitedMove.includes(moveWords("en").notices.price.title), limitedMove.includes(moveWords("en").notices.limited.title), limitedMove.includes(moveWords("en").notices.refused.title)], [true, false, false]);
  const stillOffered = await page(RenewPage, "pricegone", id, { back: basicOffer, status: "price" });
  is("a price still offered: \"status=price\" in the address alone says nothing is gone", [stillOffered.includes(membershipWords("en").offerNotices.price.replace(/'/g, "&#x27;")), stillOffered.includes(`action="/api/store/come-back/open"`)], [false, true]);

  part("The last one removed");
  await removeOption(OWNER, basic);
  store = (await storeForEmail(OWNER))!;
  product = (await readProduct(store, id))!;
  is("the product still sells at its own price", [product.options.length, product.priceCents], [0, 2900]);
  const move2 = await openMove(store, id, basicInvite.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  const back2 = await openWinBack(store, id, basicOffer, "https://marktmorgen.com", TEST_CONSENT);
  is("neither opens at the product's own price: both say the price is gone", [move2.ok ? "opened" : move2.reason, back2.ok ? "opened" : back2.reason, checkouts.length], ["price", "price", before]);
  is("and no email or reminder names the product's own price instead", [priceWords(store, product, basic), await inviteEmail(store, basicField)], [null, null]);
  const lastBack = await page(RenewPage, "pricegone", id, { back: basicOffer });
  is("the come-back page: no checkout form at the product's own price, one link to the product's page", [lastBack.includes(`action="/api/store/checkout"`), lastBack.includes("$29 a month"), links(lastBack)], [false, false, 1]);

  part("The pages, in every language");
  for (const language of Object.keys(LANGUAGES) as (keyof typeof LANGUAGES)[]) {
    await setLanguage(OWNER, language);
    const m = moveWords(language);
    const w = membershipWords(language);
    const href = `href="/@pricegone/p/`;
    const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
    const moved = await page(MovePage, "pricegone", id, { k: basicInvite.t });
    is(`${language}: the moving-in page says the price is no longer offered, with no button`, [moved.includes(escaped(m.notices.price.title)), moved.includes(escaped(m.keep))], [true, false]);
    is(`${language}: with a link to the product's page that says what it is for`, moved.includes(`${href}`) && moved.includes(escaped(m.seePrices("The Inner Circle"))), true);
    const pressed = await page(MovePage, "pricegone", id, { k: basicInvite.t, status: "price" });
    is(`${language}: the same after the button's answer`, pressed.includes(escaped(m.notices.price.title)), true);
    const renewed = await page(RenewPage, "pricegone", id, { back: basicOffer });
    is(`${language}: the come-back page says the price is no longer offered, with no offer button`, [renewed.includes(escaped(w.offerNotices.price)), renewed.includes(escaped(w.comeBackWith))], [true, false]);
    is(`${language}: with a link to the product's page that says what it is for`, renewed.includes(escaped(w.seePrices("The Inner Circle"))), true);
    is(`${language}: and no promise that renewing here opens it again`, [renewed.includes(escaped(w.endedClosed("The Inner Circle"))), renewed.includes(escaped(w.endedBody("The Inner Circle")))], [true, false]);
  }
  part("A draft");
  await setLanguage(OWNER, "en");
  await setProductHidden(OWNER, id, true);
  const draftMove = await page(MovePage, "pricegone", id, { k: basicInvite.t });
  const draftBack = await page(RenewPage, "pricegone", id, { back: basicOffer });
  is("no page buyers can open, so no link and no word of one", [links(draftMove), links(draftBack), /product(&#x27;|')s page/.test(draftMove + draftBack), draftMove.includes(moveWords("en").notices.price.title)], [0, 0, false, true]);
  is("every language says it, in its own words", new Set(Object.keys(LANGUAGES).map((l) => moveWords(l).notices.price.title)).size, Object.keys(LANGUAGES).length);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
