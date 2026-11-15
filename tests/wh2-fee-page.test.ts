/**
 * 253 [WH2]: the public fee page (/pricing/fees) shows every fee in a sale,
 * each with its official source and the day it was read, one worked sale with
 * no forecast, and says plainly when the figures are more than 90 days old.
 *
 * What fails here: a figure without an official https source on stripe.com; a
 * checked-on date that is not a real date, or a broken date read as fresh; the
 * 90-day rule off by a day; the worked sale's arithmetic; the page missing a
 * country, a figure, a source link, who pays, the plan prices from lib/plan.ts,
 * Marktmorgen's share in lib/fee-words.ts's words, or the overdue notice; the
 * page forecasting income; the pricing page not linking to it.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COUNTRY_FEES,
  FEES_CHECKED_ON,
  REVIEW_DAYS,
  STANDARD_PAYOUT,
  checkedOnWords,
  exampleSale,
  feeScheduleDue,
} from "@/lib/fee-schedule";
import { FeeSchedule } from "@/components/fee-schedule";
import { feeWords } from "@/lib/fee-words";
import { PLAN_NAMES, PUBLISHED_PLAN_PRICES, TIERS } from "@/lib/plan";
import { done, is, part } from "./check";

const day = 86_400_000;
const checked = Date.parse(`${FEES_CHECKED_ON}T00:00:00Z`);
const flat = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

part("Every figure has an official source and a real date");
is("the checked-on date is a real day", Number.isFinite(checked) && /^\d{4}-\d{2}-\d{2}$/.test(FEES_CHECKED_ON), true);
is("four countries: US, Canada, UK, an EEA example", COUNTRY_FEES.map((c) => c.country), ["us", "ca", "gb", "ie"]);
for (const c of COUNTRY_FEES) {
  for (const url of [c.source, c.methodsSource]) is(`${c.country}: ${url} is an official stripe.com page`, /^https:\/\/stripe\.com\/[a-z/-]*pricing(\/local-payment-methods)?$/.test(url), true);
  for (const figure of [c.domesticCard, c.currencyConversion, c.disputeReceived, c.disputeCountered, c.instantPayout, c.klarna, ...c.otherCards.map((o) => o.fee)]) {
    is(`${c.country}: "${figure}" is a figure, not a blank`, /\d/.test(figure), true);
  }
}

part("The 90-day rule");
is("fresh on the day it was read", feeScheduleDue(checked), false);
is(`fresh on day ${REVIEW_DAYS}`, feeScheduleDue(checked + REVIEW_DAYS * day), false);
is(`due the day after day ${REVIEW_DAYS}`, feeScheduleDue(checked + (REVIEW_DAYS + 1) * day), true);
is("a broken date is due, never fresh", feeScheduleDue(checked, "2026-13-45"), true);
is("a date in another shape is due", feeScheduleDue(checked, "15/11/2026"), true);
is("an unreadable clock is due", feeScheduleDue(Number.NaN), true);
is("the date in words", checkedOnWords("2026-11-15"), "November 15, 2026");

part("One worked sale, arithmetic only");
const sale = exampleSale(5000, 0);
is("$50 on a US card: 2.9% + 30¢ = $1.75", sale.domesticFeeCents, 175);
is("from outside the US: + 1.5% = $2.50", sale.internationalFeeCents, 250);
is("and converted: + 1% = $3.00", sale.convertedFeeCents, 300);
is("a price that is not a positive whole number of cents is refused", (() => { try { exampleSale(0, 0); return "taken"; } catch { return "refused"; } })(), "refused");

part("The page");
const html = flat(renderToStaticMarkup(createElement(FeeSchedule, { now: checked })));
for (const c of COUNTRY_FEES) {
  is(`${c.name} shown`, html.includes(c.name), true);
  for (const figure of [c.domesticCard, c.currencyConversion, c.disputeReceived, c.instantPayout, c.klarna, ...c.otherCards.map((o) => o.fee)]) is(`${c.country}: "${figure}" shown`, html.includes(figure), true);
  is(`${c.country}: Afterpay shown or said not listed`, c.afterpay ? html.includes(c.afterpay.fee) : html.includes("Not listed on Stripe's page for this country"), true);
}
const raw = renderToStaticMarkup(createElement(FeeSchedule, { now: checked }));
for (const c of COUNTRY_FEES) is(`${c.country}: links to its source`, raw.includes(`href="${c.source}"`) && raw.includes(`href="${c.methodsSource}"`), true);
is("standard payouts said", html.includes(STANDARD_PAYOUT), true);
is("the day the figures were read is shown", html.includes(checkedOnWords()), true);
is("Marktmorgen's share, in fee-words' own sentence", html.includes(feeWords().takes), true);
for (const tier of TIERS) {
  const month = `$${(PUBLISHED_PLAN_PRICES[tier].month / 100).toLocaleString("en-US")}`;
  is(`${PLAN_NAMES[tier]}'s monthly price from lib/plan.ts`, html.includes(PLAN_NAMES[tier]) && html.includes(month), true);
}
is("who pays Stripe's fees", /Stripe's fees are charged on the creator's own Stripe account/.test(html), true);
is("the worked sale's figures", ["$50.00", "$1.75", "$2.50", "$3.00"].every((v) => html.includes(v)), true);
is("no forecast of income", /you (will|could) (earn|make)|per month in sales|projected|forecast/i.test(html), false);
is("no overdue notice while fresh", html.includes("may be out of date"), false);
const late = flat(renderToStaticMarkup(createElement(FeeSchedule, { now: checked + (REVIEW_DAYS + 1) * day })));
is("an overdue notice, with Stripe's page, once older than 90 days", late.includes("may be out of date") && late.includes("more than 90 days"), true);
is("the figures stay visible beside the notice", late.includes(COUNTRY_FEES[0].domesticCard), true);
is("a table caption names each table", (raw.match(/<caption/g) ?? []).length >= 2, true);
is("header cells carry their scope", /<th scope="col"/.test(raw) && /<th scope="row"/.test(raw), true);

part("The pricing page points to it");
is("/pricing links to /pricing/fees", readFileSync("app/pricing/page.tsx", "utf8").includes('href="/pricing/fees"'), true);

done();
