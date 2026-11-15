/**
 * The buyer's own currency at checkout (22 [E5] unit 3a, lib/buyer-currency.ts;
 * added 15 November 2026 after the owner's decision of 14 November 2026).
 * Checked:
 *
 *   - the key is off, and while it is, every session keeps Stripe's
 *     conversion off and charges in the store's currency;
 *   - (a) automatic by default; (b) manual prices before it in their
 *     currencies; manual tax rates stop (b) only;
 *   - any application fee, an unknown choice, or a store currency not known
 *     to be the account's settlement currency keeps the store's currency;
 *   - the product checkout writes the plan after the share is set and only
 *     behind the key, and no other checkout turns the conversion on;
 *   - the account read: settles, does not, unknown.
 */
import { readFileSync, readdirSync } from "node:fs";
import {
  BUYER_CURRENCY_LIVE,
  DEFAULT_BUYER_CURRENCY_MODE,
  FEE_FIELDS,
  applyBuyerCurrency,
  buyerCurrencyPlan,
  hasApplicationFee,
  hasTaxRates,
  accountSettlementCurrency,
  settlesIn,
} from "@/lib/buyer-currency";
import { inTheCurrencyShown } from "@/lib/instant-pay";
import { applyShare } from "@/lib/platform-share";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_buyer_currency_only";

let account: Record<string, unknown> | "fail" = {};
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  asked.push(`${init?.method ?? "GET"} ${url.pathname} ${new Headers(init?.headers).get("Stripe-Account") ?? ""}`);
  if (account === "fail") return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  return new Response(JSON.stringify(account), { status: 200 });
}) as typeof fetch;

const read = (file: string) => readFileSync(file, "utf8");

async function main(): Promise<void> {
  part("The key");
  is("off, with (a) automatic as the default way", [BUYER_CURRENCY_LIVE, DEFAULT_BUYER_CURRENCY_MODE], [false, "automatic"]);
  is("written false in the source, never computed", /export const BUYER_CURRENCY_LIVE: boolean = false;/.test(read("lib/buyer-currency.ts")), true);

  part("What decides one session");
  const base = { live: true, mode: "automatic" as const, fee: false, settles: true, manualPrices: false, taxRates: false };
  const plan = (over: Partial<Parameters<typeof buyerCurrencyPlan>[0]>) => buyerCurrencyPlan({ ...base, ...over });
  is("key off: the store's currency, whatever else holds", [plan({ live: false }), plan({ live: false, mode: "manual", manualPrices: true })], [
    { adaptive: false, manual: false, why: "off" },
    { adaptive: false, manual: false, why: "off" },
  ]);
  is("(a) automatic: Stripe converts", plan({}), { adaptive: true, manual: false, why: "automatic" });
  is("(b) manual with the creator's own prices: those first, Stripe converts the rest", plan({ mode: "manual", manualPrices: true }), { adaptive: true, manual: true, why: "manual" });
  is("(b) manual without any of them: automatic in every currency", plan({ mode: "manual" }), { adaptive: true, manual: false, why: "manual-none" });
  is("(b) with manual tax rates: Stripe localizes no manual price, so automatic only", plan({ mode: "manual", manualPrices: true, taxRates: true }), { adaptive: true, manual: false, why: "manual-none" });
  is("an application fee: the store's currency, in both ways", [plan({ fee: true }), plan({ fee: true, mode: "manual", manualPrices: true })].map((p) => p.why), ["fee", "fee"]);
  is("an unknown choice: the store's currency", plan({ mode: "unknown" }), { adaptive: false, manual: false, why: "mode-unknown" });
  is("settlement currency another or unknown: the store's currency", [plan({ settles: false }), plan({ settles: null }), plan({ mode: "manual", manualPrices: true, settles: null })].map((p) => [p.adaptive, p.manual, p.why]), [
    [false, false, "settlement"],
    [false, false, "settlement"],
    [false, false, "settlement"],
  ]);

  part("The fee and tax-rate fields read on the session");
  const fresh = () => new URLSearchParams();
  is("no field, no fee", hasApplicationFee(fresh()), false);
  is("each field a fee", FEE_FIELDS.map((f) => { const b = fresh(); b.set(f, "1"); return hasApplicationFee(b); }), FEE_FIELDS.map(() => true));
  const shared = (recurring: boolean, live: boolean) => {
    const b = fresh();
    // A synthetic store on a plan with a share (the live argument stands in for COMMISSION_LIVE, which stays false).
    applyShare(b, { shared: true, subscriptionActive: true, trialEnds: 0, tier: "creator" } as Parameters<typeof applyShare>[1], { recurring, least: 10_000 }, Date.now() / 1000, live);
    return hasApplicationFee(b);
  };
  is("the share as applyShare writes it, for a payment and a membership: seen when written, absent while the commission is off", [shared(false, true), shared(true, true), shared(false, false), shared(true, false)], [true, true, false, false]);
  const tax = (key: string) => { const b = fresh(); b.set(key, "txr_1"); return hasTaxRates(b); };
  is("manual tax rates, on a line, dynamic, or by default; automatic tax is not one", [tax("line_items[0][tax_rates][0]"), tax("line_items[2][dynamic_tax_rates][0]"), tax("subscription_data[default_tax_rates][0]"), tax("automatic_tax[enabled]"), tax("line_items[0][price_data][tax_behavior]")], [true, true, true, false, false]);

  part("Written on the session");
  const written = (p: ReturnType<typeof buyerCurrencyPlan>) => { const b = fresh(); inTheCurrencyShown(b); applyBuyerCurrency(b, p); return b.getAll("adaptive_pricing[enabled]"); };
  is("on only when the plan says so; one value, never two", [written(plan({})), written(plan({ live: false })), written(plan({ fee: true }))], [["true"], ["false"], ["false"]]);

  part("Where it is wired");
  const checkout = read("lib/store-checkout.ts");
  const share = checkout.indexOf("applyShare(body, store,");
  const wired = checkout.indexOf("applyBuyerCurrency(body,");
  is("the product checkout: after inTheCurrencyShown and after the share, only behind the key", [share > 0, wired > share, checkout.indexOf("inTheCurrencyShown(body);") < wired, /if \(BUYER_CURRENCY_LIVE\) \{\s*applyBuyerCurrency\(body,/.test(checkout)], [true, true, true, true]);
  is("it reads the fee and the tax rates from the session it judges", [checkout.includes("fee: hasApplicationFee(body)"), checkout.includes("taxRates: hasTaxRates(body)"), checkout.includes("settles: settlesIn(store.currency, await settlementCurrencyFor(store))")], [true, true, true]);
  const others = readdirSync("lib").filter((f) => f.endsWith(".ts") && f !== "store-checkout.ts" && f !== "buyer-currency.ts").filter((f) => /applyBuyerCurrency|adaptive_pricing\[enabled\]", "true"|adaptive_pricing\]\[enabled\]=true/.test(read(`lib/${f}`)));
  is("no other checkout turns Stripe's conversion on", others, []);
  is("the buyer-facing answer still says no while the key is off", read("lib/currency-faq.ts").includes("No. Our checkout asks Stripe not to convert"), true);

  part("The account's settlement currency");
  account = { id: "acct_1TestBuyerCcy01", default_currency: "usd" };
  const same = await accountSettlementCurrency("acct_1TestBuyerCcy01");
  account = { id: "acct_1TestBuyerCcy01", default_currency: "EUR" };
  const other = await accountSettlementCurrency("acct_1TestBuyerCcy01");
  account = { id: "acct_1TestBuyerCcy01" };
  const silent = await accountSettlementCurrency("acct_1TestBuyerCcy01");
  account = "fail";
  const failed = await accountSettlementCurrency("acct_1TestBuyerCcy01");
  const none = await accountSettlementCurrency("");
  is("read: the same, another (lowercased), said nothing, failed, no account", [same, other, silent, failed, none], ["usd", "eur", null, null, null]);
  is("compared with the store's currency: settles, does not, unknown", [settlesIn("usd", same), settlesIn("usd", other), settlesIn("usd", silent)], [true, false, null]);
  is("asked of the creator's account, a read only", [...new Set(asked)], ["GET /v1/account acct_1TestBuyerCcy01"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
