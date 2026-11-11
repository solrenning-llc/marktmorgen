/**
 * 630 [HN6](27), part (a): a link that opens a product with one price option
 * already chosen (lib/option-link-rules.ts, the buy box in
 * components/store-product.tsx, the product page and the studio's copy link).
 * What is checked:
 *
 *   - only an option the page offers now is chosen; an unknown, removed,
 *     undelivering or malformed id chooses nothing, and the box asks for a
 *     choice exactly as without the link (487 [IT4]);
 *   - the chosen option is drawn checked (cards) or selected (a long list),
 *     and the buyer is told why, in every buyer language; the others stay
 *     open to choose;
 *   - the link carries only the option's id: no price, no person;
 *   - the product page reads it from the query and the studio offers it per
 *     option that hands something over.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuyBox } from "@/components/store-product";
import { OPTION_PARAM, linkedOption, optionLinkPath } from "@/lib/option-link-rules";
import { speechFor } from "@/lib/buyer-words";
const LANGUAGES = ["en", "es", "fr", "de", "it", "nl", "pt"];
const words = (lang: string) => speechFor(lang, "usd").w;
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_option_link_only";
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "option-owner@example.com";
  await claimHandle(OWNER, "optshop", "Option Shop", "Guides.");
  await setSubscription(OWNER, { customerId: "cus_OptShop0001", subscriptionId: "sub_OptPlan0001", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(Date.now()) });
  await setStripeAccount(OWNER, "acct_fixture009", true);
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Brand Guide", "Fonts and colors.", "20", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  const store = (await storeForEmail(OWNER))!;
  const base = (await readListing(store, made.product.id))!;
  const option = (id: string, label: string, cents: number, delivers = true) => ({ id, label, priceCents: cents, file: null, link: delivers ? `https://example.com/${id}` : null, details: [] as string[] });
  const product: Listing = { ...base, options: [option("basic", "Basic", 2000), option("gold", "Gold", 4900), option("empty", "Empty", 9900, false)] } as Listing;
  const offered = product.options.filter((o) => o.link !== null);

  part("Which option a link may choose");
  is("one the page offers is chosen", linkedOption("gold", offered), "gold");
  is("an unknown, an undelivering or a malformed one chooses nothing", [linkedOption("silver", offered), linkedOption("empty", offered), linkedOption("go ld", offered), linkedOption("", offered), linkedOption(undefined, offered), linkedOption(7, offered)], [null, null, null, null, null, null]);
  is("a repeated parameter is read by its first value only", [linkedOption(["gold", "basic"], offered), linkedOption(["nope", "gold"], offered)], ["gold", null]);
  is("the link carries only the option's id", optionLinkPath("/@optshop/p/brand-guide-abc123", "gold"), "/@optshop/p/brand-guide-abc123?option=gold");
  is("and the page reads it under that name", OPTION_PARAM, "option");
  const refused = (() => {
    try {
      optionLinkPath("/@optshop/p/x", "a b");
      return false;
    } catch {
      return true;
    }
  })();
  is("an id that is not an option id never becomes a link", refused, true);

  part("The buy box");
  const box = (chosenOption: string | null, p: Listing = product, language = "en") =>
    renderToStaticMarkup(createElement(BuyBox, { store: { ...store, language: language as typeof store.language }, product: p, related: [], remaining: null, writes: false, selling: true, chosenOption }));
  const checked = (html: string) => [...html.matchAll(/<input[^>]*name="option"[^>]*>/g)].filter((m) => /checked=""/.test(m[0])).map((m) => /value="([^"]+)"/.exec(m[0])?.[1]);
  const without = box(null);
  is("without a link nothing is chosen and nothing is said", [checked(without), without.includes("data-option-from-link")], [[], false]);
  const withGold = box("gold");
  is("with the link, that option is chosen and the others are not", checked(withGold), ["gold"]);
  is("the buyer is told why, by the option's own name", withGold.includes(words("en").optionFromLink("Gold")), true);
  is("every option stays there to choose, and each still asks for a choice", [(withGold.match(/name="option"/g) ?? []).length, (withGold.match(/required=""/g) ?? []).length >= 2], [2, true]);
  is("an option it does not offer: as without the link", box("empty"), without);
  is("in every buyer language", LANGUAGES.filter((lang) => !box("gold", product, lang).includes(words(lang).optionFromLink("Gold").replace(/'/g, "&#x27;"))), []);
  const many: Listing = { ...product, options: Array.from({ length: 8 }, (_, i) => option(`opt${i}`, `Size ${i}`, 1000 + i * 100)) } as Listing;
  const list = box("opt5", many);
  is("past six options, the list opens with the linked one selected", [/<option value="opt5" selected="">/.test(list), /<option value="opt4" selected="">/.test(list), list.includes(words("en").optionFromLink("Size 5"))], [true, false, true]);
  is("and without a link, on the choose-one line", /<option value="" disabled="" selected="">/.test(box(null, many)), true);

  part("The page and the studio");
  const page = read("app/[handle]/p/[product]/page.tsx");
  is("the product page reads the option from its query, among the options it offers", page.includes("const linkedChoice = linkedOption(query[OPTION_PARAM], sellableOptions(product));") && page.includes("chosenOption={linkedChoice}"), true);
  const editor = read("components/product-editor.tsx");
  is("the studio offers the link only on an option that hands something over", /\{opens \|\| option\.file \|\| option\.link \? \(\s*<OptionLinkCopy path=\{`\/@\$\{handle\}\/p\/\$\{productSegment\(product\)\}`\} optionId=\{option\.id\} label=\{option\.label\} \/>/.test(editor), true);
  const copy = read("components/option-link-copy.tsx");
  is("its copy link is a real link without scripts and says what it copies", [copy.includes("href={href}"), copy.includes("Copy a link that opens ${label} chosen"), copy.includes("min-h-11")], [true, true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
