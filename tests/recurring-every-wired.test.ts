/**
 * 609 [WP8], unit 2: billing every N weeks or months, wired (on #3520's
 * rules, lib/recurring-every-rules.ts). Stripe is played by a stand-in for
 * `fetch`. What is checked:
 *
 *   - a membership keeps its count only when it is more than one, so every
 *     record written before reads exactly as it did; a count that is not a
 *     choice is refused, never rounded;
 *   - the checkout sends Stripe the interval and its count, and a monthly
 *     membership's checkout is unchanged;
 *   - every price line a buyer reads says the exact interval, in every buyer
 *     language: the product page, the card, the button, the confirmation
 *     email and its product card, the affiliate directory and the API; with a
 *     count of one each line is word for word what it was;
 *   - what is still counted in single weeks or months is refused with its
 *     reason: an introductory price, a yearly price, a set number of payments
 *     and plans members switch between;
 *   - the studio offers only the listed counts, by name.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { everyOf, membershipPrice, parseRecurring, readRecurring } from "@/lib/product-recurring";
import { everyPhrase, membershipLine, speechFor, wordsIn } from "@/lib/buyer-words";
import { membershipWords } from "@/lib/buyer-words/membership";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { canTier } from "@/lib/tier-rules";
import { yearlyProblem } from "@/lib/yearly-price";
import { introProblem } from "@/lib/intro-price";
import { mailPriceLabel } from "@/lib/mail-product-price";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct, readListing } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { BuyBox, pricePill } from "@/components/store-product";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "every-owner@example.com";
const checkouts: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"e".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_every_only_a_stand_in";

  part("Kept on the product, and only when it is more than one");
  is("every 3 months, read from the editor", readRecurring("month", "", "", "3"), { interval: "month", trialDays: 0, payments: 0, every: 3 });
  is("every 2 weeks", readRecurring("week", "", "", 2), { interval: "week", trialDays: 0, payments: 0, every: 2 });
  is("1, empty or absent keeps the record exactly as before", [readRecurring("month", "", "", "1"), readRecurring("month", "", ""), readRecurring("month")], [{ interval: "month", trialDays: 0, payments: 0 }, { interval: "month", trialDays: 0, payments: 0 }, { interval: "month", trialDays: 0, payments: 0 }]);
  is("a count that is not a choice is refused, never rounded", [readRecurring("month", "", "", "4"), readRecurring("year", "", "", "2"), readRecurring("week", "", "", "3"), readRecurring("month", "", "", "3.5")], ["every", "every", "every", "every"]);
  is("read back as kept; a kept one that is not a choice is 1", [parseRecurring({ interval: "month", trialDays: 0, payments: 0, every: 6 }), parseRecurring({ interval: "month", every: 5 }), parseRecurring({ interval: "month" })], [{ interval: "month", trialDays: 0, payments: 0, every: 6 }, { interval: "month", trialDays: 0, payments: 0 }, { interval: "month", trialDays: 0, payments: 0 }]);
  is("everyOf: 1 unless it says more", [everyOf({ interval: "month" }), everyOf({ interval: "month", every: 3 }), everyOf({ interval: "year", every: 3 })], [1, 3, 1]);

  part("The words a buyer reads");
  const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
  const quarterly = { ...monthly, every: 3 };
  is("English, as the store assistant and the studio say it", [membershipPrice(quarterly, "$90"), membershipPrice({ ...quarterly, trialDays: 7 }, "$90")], ["$90 every 3 months", "7-day free trial, then $90 every 3 months"]);
  is("and a monthly one exactly as before", [membershipPrice(monthly, "$9"), membershipPrice({ ...monthly, trialDays: 7 }, "$9"), membershipPrice({ ...monthly, payments: 12 }, "$9")], ["$9 a month", "7-day free trial, then $9 a month", "12 monthly payments of $9"]);
  const say = (language: string) => ({ language, currency: "usd" });
  is("in every buyer language, the line names the exact interval", LANGUAGE_CODES.filter((code) => !membershipLine(say(code), quarterly, "$90").includes(membershipWords(code).every("month", 3))), []);
  is("and never reads as the monthly line", LANGUAGE_CODES.filter((code) => membershipLine(say(code), quarterly, "$90") === membershipLine(say(code), monthly, "$90")), []);
  is("with a free trial too, the trial's own words kept, in every language", LANGUAGE_CODES.filter((code) => {
    const line = membershipLine(say(code), { ...quarterly, trialDays: 7 }, "$90");
    return !(line.includes("7") && line.endsWith(membershipWords(code).every("month", 3)) && line !== `$90 ${membershipWords(code).every("month", 3)}`);
  }), []);
  is("with a count of one, word for word the line of before, in every language", LANGUAGE_CODES.every((code) => membershipLine(say(code), monthly, "$9") === wordsIn(code).membershipPrice(0, 0, "month", "$9")), true);
  is("the interval alone: a month, every 3 months, every 2 weeks", [everyPhrase(say("en"), "month"), everyPhrase(say("en"), "month", 3), everyPhrase(say("en"), "week", 2), everyPhrase(say("de"), "month", 1) === speechFor("de", "usd").w.every("month")], ["a month", "every 3 months", "every 2 weeks", true]);
  is("an email's product card says it too", [mailPriceLabel(say("en"), { free: false, priceCents: 9000, fromCents: 9000, optionCount: 0, interval: "month", every: 3, pwyw: false, sale: null, taxOnTop: false }, 0), mailPriceLabel(say("en"), { free: false, priceCents: 900, fromCents: 900, optionCount: 0, interval: "month", pwyw: false, sale: null, taxOnTop: false }, 0)], ["$90 every 3 months", "$9 a month"]);

  part("What still counts single weeks or months is refused");
  const member = (recurring: object) => ({ id: "p1", priceCents: 9000, recurring, options: [] as unknown[], pwyw: null });
  is("plans members switch between", [canTier(member(quarterly) as never), canTier(member(monthly) as never)], [false, true]);
  is("a yearly price beside it", yearlyProblem(member(quarterly) as never, { cents: 30000 }, 50), "month");
  is("an introductory price on it", introProblem(member(quarterly) as never, { cents: 500, count: 1 }, 50), "count");
  const route = read("app/api/store/product/route.ts");
  is("the product route reads the count and refuses each with its reason before saving", [
    route.includes("readRecurring(text(body.every, 10), body.trial, body.payments, body.everyCount)"),
    route.includes('recurring === "every"'),
    /everyProblem\(everyOf\(recurring\), \{[\s\S]{0,300}payments: recurring\.payments,[\s\S]{0,120}`every_\$\{problem\}`/.test(route),
    route.indexOf("everyProblem(") < route.indexOf("await addProduct(ref, title, summary, price, recurring, suggested)"),
  ], [true, true, true, true]);

  part("At checkout, and on the store");
  await claimHandle(OWNER, "everyshop", "Every Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestEvery00001", true);
  await setSubscription(OWNER, { customerId: "cus_Every000001", subscriptionId: "sub_Every000001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Seasonal Box", "", "90", quarterly);
  const plain = await addProduct(OWNER, "Supper Club", "", "9", monthly);
  if (!made.ok || !plain.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/box");
  await setProductLink(OWNER, plain.product.id, "https://example.com/club");
  const store = (await storeForEmail(OWNER))!;
  const open = async (id: string) => {
    checkouts.length = 0;
    await createCheckout(store, (await readProduct(store, id))!, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT });
    return checkouts[0];
  };
  const sent = await open(made.product.id);
  is("Stripe is sent the interval and its count", [sent.get("line_items[0][price_data][recurring][interval]"), sent.get("line_items[0][price_data][recurring][interval_count]"), sent.get("line_items[0][price_data][unit_amount]")], ["month", "3", "9000"]);
  const plainSent = await open(plain.product.id);
  is("a monthly membership's checkout is unchanged: no count", [plainSent.get("line_items[0][price_data][recurring][interval]"), plainSent.has("line_items[0][price_data][recurring][interval_count]")], ["month", false]);
  const listing = (await readListing(store, made.product.id))!;
  is("kept on the listing the store reads", listing.recurring, quarterly);
  is("the store card's price", pricePill(store, listing), "$90 every 3 months");
  const box = renderToStaticMarkup(createElement(BuyBox, { store, product: listing, related: [], remaining: null, writes: false, selling: true }));
  is("the buy box says every 3 months and never a month", [box.includes("every 3 months"), box.includes("a month")], [true, false]);
  const thanks = read("app/[handle]/thanks/page.tsx");
  is("the page after paying says it as charged", thanks.includes("everyPhrase(store, paidEvery, order.product.recurring.every)") && !thanks.includes("speech(store).w.every(paidEvery))"), true);
  const email = read("lib/purchase-email.ts");
  is("and the confirmation email", email.includes('every === "year" ? w.every("year") : everyPhrase({ language: store.language, currency }, every, product.recurring.every)'), true);
  const api = read("lib/api-read.ts");
  is("the API names the count beside the interval", api.includes("interval_count: p.recurring ? everyOf(p.recurring) : null"), true);
  const affiliates = read("components/affiliate-directory.tsx");
  is("the affiliate directory says a payment every 3 months", affiliates.includes("`a payment every ${product.every} ${product.interval}s`"), true);

  part("The studio");
  const editor = read("components/product-editor.tsx");
  is("a choice of the listed counts, each named in full, under its own label", [
    editor.includes("Charge it every"),
    editor.includes("{EVERY_CHOICES[draft.every].map((n) => ("),
    editor.includes("everyName(draft.every as Interval, n)"),
    editor.includes("everyCount: draft.every ? parseEvery(draft.every, Number(draft.everyCount)) : 1,"),
  ], [true, true, true, true]);
  is("each refusal said in plain words", ["every_intro", "every_yearly", "every_tiers", "every_payments"].every((code) => editor.includes(`${code}: EVERY_PROBLEM_WORDS.`)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
