/**
 * 642 [WG2], unit 1: a price option taken off sale (ProductOption.offSale)
 * leaves every public page and every checkout, and those who already bought
 * or subscribe on it keep what they have: nothing about delivery, renewals or
 * Stripe changes. What is checked, each against the real code:
 *
 *   - the flag is kept as it is stored, and nothing else turns it on; a
 *     value stored in a shape it cannot be read in ("true", 1, "yes", null,
 *     {}) reads as off sale, because this flag is what stops a charge
 *     (reviewer C3 on #3598): only an absent flag or exactly false is on sale;
 *   - sellableOptions leaves it out, so the product page, the cards, the
 *     "from" price, the buy form, the comparison and the come-back offers
 *     (namedPriceOffered) never show it;
 *   - the checkout refuses it, even from an old link that names it, before
 *     Stripe is reached; an option still on sale opens as before;
 *   - a product whose options are all off sale is not for sale, whatever its
 *     kind: a course or a podcast never falls back to its own price;
 *   - the affiliate directory and the store assistant never quote it;
 *   - what the buyer bought is still read by its id (delivery is untouched).
 */
import { addOption, addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { handsOver, namedPriceOffered, parseOptions, sellableOptions, withInvitedOption, type ProductOption } from "@/lib/product-option";
import { createCheckout, fromPriceCents } from "@/lib/store-checkout";
import { directoryRow } from "@/lib/affiliate-directory";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { priceWords } from "@/lib/answers";
import { canGift, givableOptions, givenOption } from "@/lib/gift-rules";
import { canGroup } from "@/lib/group-rules";
import { activePlan, planFor, planState } from "@/lib/product-extras";
import type { Listing } from "@/lib/store";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_option_off_sale_only";

const sessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    sessions.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"o".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  if (method === "GET") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

/** Marks option `id` off sale wherever the store keeps it, as the studio will (unit 2); `flag` writes another shape. */
function takeOffSale(id: string, flag: unknown = true): number {
  let patched = 0;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(record)) next[key] = walk(inner);
    if (next.id === id && typeof next.priceCents === "number" && "label" in next) {
      next.offSale = flag;
      patched += 1;
    }
    return next;
  };
  for (const key of redis.keys()) {
    if (redis.run(["TYPE", key]) !== "string") continue;
    const raw = redis.run(["GET", key]);
    if (typeof raw !== "string" || !raw.includes(id)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const before = patched;
    const next = walk(parsed);
    if (patched > before) redis.run(["SET", key, JSON.stringify(next)]);
  }
  return patched;
}

const option = (over: Partial<ProductOption>): ProductOption => ({ id: "o1", label: "Basic", priceCents: 1000, file: null, link: "https://example.com/a", details: [], best: false, ...over });

async function main(): Promise<void> {
  redis.clear();

  part("The flag as it is stored");
  const read = parseOptions([
    { id: "a1", label: "A", priceCents: 1000, link: "https://example.com/a", offSale: true },
    { id: "b1", label: "B", priceCents: 2000, link: "https://example.com/b", offSale: "yes" },
    { id: "c1", label: "C", priceCents: 3000, link: "https://example.com/c" },
    { id: "d1", label: "D", priceCents: 4000, link: "https://example.com/d", offSale: false },
  ]);
  is("exactly true is off sale; a value it cannot read ('yes') is off sale too; absent or exactly false is on sale", read.map((o) => o.offSale === true), [true, true, false, false]);
  const unreadable: unknown[] = ["true", 1, "yes", null, {}];
  const odd = parseOptions(unreadable.map((flag, at) => ({ id: `u${at}`, label: `U${at}`, priceCents: 1000, link: "https://example.com/u", offSale: flag })));
  is("each unreadable value is kept as an option, read as off sale (never dropped, so a product never falls back to its own price)", odd.map((o) => [o.id, o.offSale]), unreadable.map((_, at) => [`u${at}`, true]));
  is("none of them is offered, and with all of them unreadable the product is not for sale", [sellableOptions({ options: odd, course: null, podcast: null, shipping: null } as unknown as Listing).length, handsOver({ options: odd, course: { lessons: 3 } } as unknown as Listing)], [0, false]);
  const invited = withInvitedOption({ options: odd }, "u2");
  is("a moving-in invitation naming one reopens only that one, for that member, as for exactly true", invited.options.map((o) => o.offSale === true), [true, true, false, true, true]);

  part("What a buyer may pick");
  const both = { options: [option({ id: "o1", priceCents: 1000, offSale: true }), option({ id: "o2", label: "Plus", priceCents: 3000 })], priceCents: 1000, file: null, link: null, recurring: null } as unknown as Listing;
  is("an option off sale is not offered", sellableOptions(both).map((o) => o.id), ["o2"]);
  is("the 'from' price is the lowest price still on sale", fromPriceCents(both), 3000);
  is("a come-back offer naming it opens nothing; one on sale still opens", [namedPriceOffered(both, "o1"), namedPriceOffered(both, "o2")], [false, true]);
  const none = { ...both, options: both.options.map((o) => ({ ...o, offSale: true })) } as Listing;
  is("all off sale: nothing to hand over, so not for sale", handsOver(none), false);
  const course = { ...none, course: { lessons: 3 } } as unknown as Listing;
  is("a course whose prices are all off sale is not for sale either (never at its own price)", handsOver(course), false);
  is("a course with one price on sale is", handsOver({ ...course, options: both.options } as Listing), true);

  part("The checkout refuses it, even from an old link");
  const owner = "offsale@example.com";
  await claimHandle(owner, "offsaleshop", "Off Sale Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestOffSale01", true);
  await setSubscription(owner, { customerId: "cus_OffSale0001", subscriptionId: "sub_OffSale0001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Design Club", "", "10", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("no product");
  const basic = await addOption(owner, made.product.id, "Basic", "10");
  const plus = await addOption(owner, made.product.id, "Plus", "30");
  if (!basic.ok || !plus.ok) throw new Error("no options");
  const ids = (await readProduct((await storeForEmail(owner))!, made.product.id))!.options.map((o) => o.id);
  for (const id of ids) await setProductLink(owner, id, `https://example.com/${id}`);
  is("the option is written off sale where the store keeps it", takeOffSale(ids[0]) > 0, true);
  const shop = (await storeForEmail(owner))!;
  const club = (await readProduct(shop, made.product.id))!;
  is("the product read back keeps it off sale, and keeps it for those who bought it", [club.options.find((o) => o.id === ids[0])?.offSale, club.options.find((o) => o.id === ids[0])?.link], [true, `https://example.com/${ids[0]}`]);
  const open = async (id: string) => {
    const before = sessions.length;
    const outcome = await createCheckout(shop, club, "https://marktmorgen.com", id, { digitalConsent: TEST_CONSENT }).then(() => "opened", (error: unknown) => `refused: ${(error as Error).message}`);
    return [outcome, sessions.length - before];
  };
  is("an old link naming the option off sale: refused, Stripe never reached", await open(ids[0]), ["refused: This product needs one of its options", 0]);
  const opened = await open(ids[1]);
  is("the option still on sale: opens as before, at its own price", [opened, sessions.at(-1)?.get("line_items[0][price_data][unit_amount]")], [["opened", 1], "3000"]);
  for (const flag of ["true", 1, "yes", null, {}] as unknown[]) {
    takeOffSale(ids[0], flag);
    const stored = (await readProduct(shop, made.product.id))!;
    const before = sessions.length;
    const outcome = await createCheckout(shop, stored, "https://marktmorgen.com", ids[0], { digitalConsent: TEST_CONSENT }).then(() => "opened", (error: unknown) => `refused: ${(error as Error).message}`);
    is(`offSale stored as ${JSON.stringify(flag)}: read as off sale, refused, Stripe never reached`, [stored.options.find((o) => o.id === ids[0])?.offSale, outcome, sessions.length - before], [true, "refused: This product needs one of its options", 0]);
  }
  takeOffSale(ids[0], false);
  const back = (await readProduct(shop, made.product.id))!;
  const reopened = sessions.length;
  const onSale = await createCheckout(shop, back, "https://marktmorgen.com", ids[0], { digitalConsent: TEST_CONSENT }).then(() => "opened", (error: unknown) => `refused: ${(error as Error).message}`);
  is("offSale stored as exactly false: on sale, opens at its own price", [onSale, sessions.length - reopened, sessions.at(-1)?.get("line_items[0][price_data][unit_amount]")], ["opened", 1, "1000"]);

  part("Never quoted by the affiliate directory or the store assistant");
  const pack = await addProduct(owner, "Font Pack", "", "10", null);
  if (!pack.ok) throw new Error("no pack");
  const small = await addOption(owner, pack.product.id, "Basic", "10");
  const large = await addOption(owner, pack.product.id, "Plus", "30");
  if (!small.ok || !large.ok) throw new Error("no pack options");
  const packIds = (await readProduct((await storeForEmail(owner))!, pack.product.id))!.options.map((o) => o.id);
  for (const id of packIds) await setProductLink(owner, id, `https://example.com/${id}`);
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, percent: 30, days: 30, rule: "last", payday: 15, hold: 30, buyers: true, directory: true, lifetime: true, rates: {} }));
  const rowOf = async () => directoryRow((await storeForEmail(owner))!)?.products.find((p) => p.id === pack.product.id)?.priceCents ?? null;
  is("with both on sale, the directory lists the lowest price", await rowOf(), 1000);
  takeOffSale(packIds[0]);
  is("with the lower one off sale, the directory lists the lowest price still on sale", await rowOf(), 3000);
  const fonts = (await readProduct((await storeForEmail(owner))!, pack.product.id))!;
  is("the assistant names only the prices on sale", [priceWords(fonts, "usd").includes("Basic"), priceWords(fonts, "usd").includes("Plus")], [false, true]);
  takeOffSale(packIds[1]);
  const gone = (await readProduct((await storeForEmail(owner))!, pack.product.id))!;
  is("every price off sale: the directory lists nothing for it, and the assistant says it is not on sale", [await rowOf(), priceWords(gone, "usd")], [null, "It is not on sale right now."]);


  part("Never given as a gift or bought for a group (Revisor 1 on #2685)");
  const gift = { options: [option({ id: "g1", priceCents: 1000, best: true, offSale: true }), option({ id: "g2", label: "Plus", priceCents: 3000 })], priceCents: 1000, file: null, link: null, recurring: null, call: null, pwyw: false, keys: null, stock: null } as unknown as Listing;
  is("the gift and group picker leaves it out, even when it is the pick", givableOptions(gift).map((o) => o.id), ["g2"]);
  is("a gift or group for it is refused, never guessed; one on sale is taken", [givenOption(gift, "g1").ok, givenOption(gift, "g2").ok], [false, true]);
  const lastOff = { ...gift, options: gift.options.map((o) => ({ ...o, offSale: true as const })) } as Listing;
  is("with every price off sale, it cannot be given or bought for a group at all", [canGift(lastOff), canGroup(lastOff)], [false, false]);
  is("with one on sale, it still can", [canGift(gift), canGroup(gift)], [true, true]);

  part("The payment plan reads only the prices on sale (sweep after Revisor 1 on #2685)");
  const planned = { options: [option({ id: "p1", priceCents: 3000, offSale: true }), option({ id: "p2", label: "Plus", priceCents: 3000 })], priceCents: 3000, file: null, link: null, recurring: null, call: null, pwyw: false, keys: null, stock: null, plan: { payments: 3, interval: "month", amountCents: 1000, options: { p2: 1000 } } } as unknown as Listing;
  is("a price off sale with no payment set does not pause the plan for the others", activePlan(planned) !== null, true);
  is("the plan is never offered for the price off sale, even with a payment saved for it", [planFor({ ...planned, plan: { ...planned.plan!, options: { p1: 1000, p2: 1000 } } } as Listing, "p1"), planFor(planned, "p2")?.amountCents], [null, 1000]);
  is("with every price off sale, the plan is paused", planState({ ...planned, options: planned.options.map((o) => ({ ...o, offSale: true as const })) } as Listing), { paused: "options", plan: planned.plan });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
