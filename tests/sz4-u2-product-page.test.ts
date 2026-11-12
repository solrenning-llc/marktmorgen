/**
 * Member and past-buyer prices on the product page (620 [SZ4], second unit;
 * the rules, the proof and the checkout are the first unit,
 * tests/member-price.test.ts).
 *
 * What is checked:
 *
 *   - a visitor sees "Member price $X (regular $Y)" only once the server has
 *     proved their address holds what a rule asks (lib/member-price.ts,
 *     memberPriceFor); an unknown or unproved answer, or a member price no
 *     larger than a sale or a fair price, shows the normal price;
 *   - it is offered only where the checkout takes it: the buyer's own
 *     purchase of this product alone, at one price, paid in full (no box to
 *     check, no payment plan, no bundle to build), so the page never shows a
 *     price Stripe will not charge;
 *   - the buy box sends the percentage it showed (the checkout proves it
 *     again) and its button says the member amount; the price is said in
 *     words and with the regular price beside it, never by color alone;
 *   - the two answers the checkout sends back (?member=changed,
 *     ?member=alone) are said in plain words beside the buy box;
 *   - every sentence in the seven languages a store speaks;
 *   - the page is drawn for each request (it reads the visitor's cookies),
 *     never cached for everybody, so one visitor's price never reaches
 *     another, and it asks the server only when a member price could show.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, setMemberPrices, setProductLink, setStripeAccount, setStoreSale, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { BuyBox } from "@/components/store-product";
import { MemberPriceBack, MemberPriceNote, MemberPriceTag, memberPriceCanShow, memberShown, readMemberBack } from "@/components/member-price";
import { MEMBER_PRICE_WORDS, memberPriceWords } from "@/lib/buyer-words/member-price";
import { memberPriceFor } from "@/lib/member-price";
import { speech } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { salePrice } from "@/lib/store-sale";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "harbor@example.com";
const jar = (cookies: Record<string, string>) => ({ get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) });
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;
/** The rendered text: tags are taken off until none is left, so no tag can survive by being split around another. */
function text(html: string): string {
  let out = html;
  for (let before = ""; before !== out; ) {
    before = out;
    out = out.replace(/<[^<>]*>/g, "");
  }
  return out.replace(/[<>]/g, "").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_member_page_only";

  part("The words, in every language a store speaks");
  const keys = ["head", "note", "paypal", "changed", "alone"] as const;
  for (const code of LANGUAGE_CODES) {
    const words = MEMBER_PRICE_WORDS[code];
    is(`${code}: every sentence is there`, keys.every((key) => typeof words[key] === "string" && words[key].trim().length > 0), true);
    const line = words.line("$21.60", "$27");
    is(`${code}: the line says both amounts and the name`, [line.includes("$21.60"), line.includes("$27"), line.includes(words.head)], [true, true, true]);
    if (code !== "en") is(`${code}: not the English words`, keys.filter((key) => words[key] === MEMBER_PRICE_WORDS.en[key]), []);
  }
  is("an unknown language falls back to English", memberPriceWords("xx"), MEMBER_PRICE_WORDS.en);
  is("English says it plainly", MEMBER_PRICE_WORDS.en.line("$21.60", "$27"), "Member price $21.60 (regular $27)");

  part("Who is shown it");
  await claimHandle(OWNER, "harborpage", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarborPg01", true);
  await setSubscription(OWNER, { customerId: "cus_OwnerPg0001", subscriptionId: "sub_OwnerPg0001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Kitchen Club", "", "9", { interval: "month", trialDays: 0, payments: 0 });
  const planner = await addProduct(OWNER, "Meal Planner", "", "27", null);
  if (!club.ok || !planner.ok) throw new Error("no product");
  await setProductLink(OWNER, planner.product.id, "https://example.com/planner");
  await setMemberPrices(OWNER, { on: true, rules: [{ id: "club", percent: 20, by: [club.product.id], all: true, products: [] }] });
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, planner.product.id))!;
  const clubNow = (await readListing(store, club.product.id))!;
  const place = { selling: true, soon: false, remaining: null, ready: true, related: [] };

  is("a proved member: the percentage", memberShown(store, product, { state: "member", percent: 20, email: "m@example.com" }), 20);
  is("unknown: the normal price", memberShown(store, product, { state: "unknown" }), 0);
  is("not a member: the normal price", memberShown(store, product, { state: "none" }), 0);
  is("a product one price, paid in full, on sale here: it can show", memberPriceCanShow(store, product, place), true);
  is("not while the store cannot take a payment", memberPriceCanShow(store, product, { ...place, selling: false }), false);
  is("not while it is coming soon", memberPriceCanShow(store, product, { ...place, soon: true }), false);
  is("not when sold out", memberPriceCanShow(store, product, { ...place, remaining: 0 }), false);
  is("not on a bundle not ready to hand over", memberPriceCanShow(store, product, { ...place, ready: false }), false);
  is("not on a membership (a rule never covers it)", memberPriceCanShow(store, clubNow, place), false);
  is("not on a product with several prices", memberPriceCanShow(store, { ...product, options: [{ id: "o1", label: "Big", priceCents: 4000, details: [], best: false }] } as unknown as typeof product, place), false);
  const shown = readFileSync("components/member-price.tsx", "utf8");
  const canShow = shown.slice(shown.indexOf("export function memberPriceCanShow"), shown.indexOf("export function memberShown"));
  is("not with a payment plan, a box to check or a bundle the buyer builds (the checkout refuses those)", ["activePlan(product)", "activeBumps(", "picks(product)"].every((piece) => canShow.includes(piece)), true);

  const now = Math.floor(Date.now() / 1000);
  await setStoreSale(OWNER, { name: "Spring", coupon: "spring30", percent: 30, starts: now - 60, ends: now + 3600, all: true, products: [] });
  const onSale = (await storeForEmail(OWNER))!;
  is("a sale taking off more: the sale, never two (the checkout takes the largest)", memberShown(onSale, product, { state: "member", percent: 20, email: "m@example.com" }), 0);
  await setStoreSale(OWNER, { name: "Spring", coupon: "spring10", percent: 10, starts: now - 60, ends: now + 3600, all: true, products: [] });
  const smallSale = (await storeForEmail(OWNER))!;
  is("a smaller sale: the member price", memberShown(smallSale, product, { state: "member", percent: 20, email: "m@example.com" }), 20);
  await setStoreSale(OWNER, { name: "Spring", coupon: "spring10", percent: 10, starts: now - 7200, ends: now - 3600, all: true, products: [] });
  store = (await storeForEmail(OWNER))!;
  is("a visitor with no proof at all: nothing to show", memberShown(store, product, await memberPriceFor(store, product, jar({}))), 0);

  part("The buy box");
  const { money } = speech(store);
  const memberAmount = money(salePrice(product.priceCents, 20));
  const base = { store, product, related: [], remaining: null, writes: false, selling: true };
  const plain = renderToStaticMarkup(createElement(BuyBox, base));
  is("without a member price, nothing is claimed", count(plain, /name="member"/g), 0);
  const withMember = renderToStaticMarkup(createElement(BuyBox, { ...base, member: 20 }));
  const form = withMember.slice(withMember.indexOf("data-checkout"), withMember.indexOf("</form>"));
  is("the form sends the percentage it showed, for the checkout to prove again", count(form, /<input type="hidden" name="member" value="20"\/>/g), 1);
  is("its button says the member amount", text(form).includes(`Buy for ${memberAmount}`), true);
  is("and not the regular one", text(form).includes(`Buy for ${money(product.priceCents)}`), false);

  part("Said in words, the regular price beside it");
  const note = renderToStaticMarkup(createElement(MemberPriceNote, { store, product, percent: 20, paypal: false }));
  is("Member price $X (regular $Y)", text(note).startsWith(`Member price ${memberAmount} (regular ${money(product.priceCents)})`), true);
  is("who it is for, in plain words", text(note).includes(MEMBER_PRICE_WORDS.en.note), true);
  is("PayPal is said only where it is offered", [text(note).includes(MEMBER_PRICE_WORDS.en.paypal), text(renderToStaticMarkup(createElement(MemberPriceNote, { store, product, percent: 20, paypal: true }))).includes(MEMBER_PRICE_WORDS.en.paypal)], [false, true]);
  const tag = renderToStaticMarkup(createElement(MemberPriceTag, { store, product, percent: 20 }));
  is("the price pill: the regular price struck through and named, then the member price named", [/<s[^>]*>[\s\S]*?<span class="sr-only">Was <\/span>/.test(tag), tag.includes(money(product.priceCents)), text(tag).includes(`Member price ${memberAmount}`)], [true, true, true]);
  const german = { ...store, language: "de" } as typeof store;
  is("in the store's own language", text(renderToStaticMarkup(createElement(MemberPriceNote, { store: german, product, percent: 20, paypal: false }))).startsWith(MEMBER_PRICE_WORDS.de.head), true);

  part("The checkout's answers, said beside the buy box");
  is("only the two answers the checkout sends are read", [readMemberBack("changed"), readMemberBack("alone"), readMemberBack("other"), readMemberBack(["changed"]), readMemberBack(undefined)], ["changed", "alone", "", "", ""]);
  const changed = renderToStaticMarkup(createElement(MemberPriceBack, { store, back: "changed" }));
  const alone = renderToStaticMarkup(createElement(MemberPriceBack, { store, back: "alone" }));
  is("changed: said, and nothing was charged", text(changed), MEMBER_PRICE_WORDS.en.changed);
  is("alone: said", text(alone), MEMBER_PRICE_WORDS.en.alone);
  is("a note, not color alone", [changed.includes('class="st-note'), alone.includes('class="st-note')], [true, true]);

  part("The page");
  const page = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  is("drawn for each request: it reads the visitor's cookies", page.includes("await cookies()"), true);
  is("never cached for everybody", ["export const revalidate", "force-static", "generateStaticParams", '"use cache"', "unstable_cache"].filter((piece) => page.includes(piece)), []);
  is("the server is asked only where a member price could show", /memberPriceCanShow\([^)]*\{[^}]*\}\)\s*\?\s*await memberPriceFor\(/.test(page), true);
  is("an answer that fails is unknown: the normal price", /await memberPriceFor\([\s\S]*?\)\.catch\(/.test(page), true);
  is("the buy box is given the member price", /<BuyBox [^>]*member=\{member\}/.test(page), true);
  is("its note is drawn beside the buy box", page.includes("<MemberPriceNote"), true);
  is("the checkout's answer is read from the address", page.includes("readMemberBack(query.member)") && page.includes("<MemberPriceBack"), true);
  is("the price pills say the member price too", page.includes("<MemberPriceTag"), true);
  is("the page's other buttons lead a member to the buy box that carries it", /member\s*\?\s*\{\s*action:\s*\{\s*kind:\s*"link",\s*href:\s*"#buy"\s*\}/.test(page), true);
  // Claude 4's LOW on #3021: the cart charges cartPrice (sale or fair price only, lib/cart-checkout.ts), never the
  // member price, so a member shown "Member price $21.60 (regular $27)" is never offered a path that charges $27.
  const cartLine = page.split("\n").find((line) => line.includes("<AddToCart")) ?? "";
  is("a member shown their price is never offered Add to cart, which charges the regular price", [cartLine.length > 0, /!member\b/.test(cartLine)], [true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
