/**
 * "Check what buyers pay" sees how often a membership charges (609 [WP8] unit 2; Claude 4's review of #3536 at
 * fd753735, MÉDIO): lib/price-review.ts compares the interval and its count together, says the count as the editor's
 * list does ("Every 3 months"), and does not review a count the save refuses (everyProblem). Synthetic products.
 */
import { readFileSync } from "node:fs";
import { priceReview, type PricedProduct, type PriceDraft } from "@/lib/price-review";
import { formatMoney, readMoney } from "@/lib/money";
import { done, is, part } from "./check";

const read = (typed: string) => readMoney(typed, "usd");
const money = (cents: number) => formatMoney(cents, "usd");
const NONE = { free: false, membership: false, choose: false };
const monthly: PricedProduct = { hidden: false, options: 0, priceCents: 9000, interval: "month", suggestedCents: null, intro: null, yearlyCents: null, id: "p1", tiers: [], bounds: { min: 100, max: 500_000 }, refuses: NONE, taxOnTop: false, plan: null, planBefore: false, planAfter: () => false };
const quarterly: PricedProduct = { ...monthly, every: 3 };
const draft = (more: Partial<PriceDraft>): PriceDraft => ({ title: "Monthly letters", summary: "", about: "", price: "90", every: "month", pwyw: false, suggested: "", introPrice: "", introCount: "1", yearlyPrice: "", everyCount: "1", ...more });
const rows = (p: PricedProduct, d: Partial<PriceDraft>) => priceReview(p, draft(d), read, money)?.rows.map((x) => [x.label, x.now, x.then, x.field]) ?? null;

part("A change of how often it charges is reviewed");
is("a month to every 3 months, same price: one How buyers pay row, and the price shown", rows(monthly, { everyCount: "3" }), [
  ["How buyers pay", "Every month", "Every 3 months", "every"],
  ["Price", "$90", "$90", "price"],
]);
is("every 3 months to a month, same price: reviewed too", rows(quarterly, { everyCount: "1" }), [
  ["How buyers pay", "Every 3 months", "Every month", "every"],
  ["Price", "$90", "$90", "price"],
]);
is("a month at $90 to every 3 months at $30: said as a schedule change, not a price cut alone", rows(monthly, { price: "30", everyCount: "3" }), [
  ["How buyers pay", "Every month", "Every 3 months", "every"],
  ["Price", "$90", "$30", "price"],
]);
is("the same count and price: nothing to review", rows(quarterly, { everyCount: "3" }), null);
is("a count absent on a product from before: read as 1", rows(monthly, { everyCount: undefined }), null);

part("A count the save refuses is not reviewed");
is("a count not on the list", rows(monthly, { everyCount: "4" }), null);
is("every 3 months beside a set number of payments", rows(monthly, { everyCount: "3", payments: "6" }), null);
is("every 3 months beside an introductory price", rows(monthly, { everyCount: "3", introPrice: "45" }), null);
is("every 3 months on a plan members switch between", rows({ ...monthly, tiers: ["p1"] }, { everyCount: "3" }), null);

part("The editor sends the count and withdraws an open review when it changes");
const editor = readFileSync("components/product-editor.tsx", "utf8");
is("the product's count is passed", /every: product\.recurring \? parseEvery\(product\.recurring\.interval, product\.recurring\.every\) : 1,/.test(editor), true);
is("a changed count withdraws an open review", /next\.everyCount !== draft\.everyCount\) setPriceReview\(null\)/.test(editor), true);

done();
