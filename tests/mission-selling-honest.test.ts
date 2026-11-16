/**
 * /mission says "A feature nobody here can press is not a built feature" and
 * counts the paid plan and the Store assistant as not built while they are not
 * on sale (lib/opening.ts). Selling from a creator's store and the features
 * that exist only on Studio follow the same rule (audit R33, finding 1):
 *
 * - canSell (lib/store-checkout.ts) needs a paid-up plan, and the plan checkout
 *   refuses with billing=not-open while PLANS_ON_SALE is false, so no store can
 *   sell: "Selling: ..." is not under "Built and working".
 * - Studio cannot be bought while plans are closed, so "Email to your list, on
 *   Studio" and "Your store on your own domain, on Studio" are not there either.
 * - The headline figure is the length of the list it heads, never typed.
 *
 * Synthetic env only: the page is rendered to a string; no provider is reached.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import MissionPage from "@/app/mission/page";
import { PLANS_ON_SALE } from "@/lib/opening";
import { isConnectConfigured } from "@/lib/stripe-connect";
import { isDomainsConfigured } from "@/lib/domains";
import { canSell } from "@/lib/store-checkout";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_mission_honest_only";
process.env.VERCEL_API_TOKEN = "synthetic_mission_honest_token";

const strip = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const SELLING = "Selling: the buyer pays on your account and the file is handed over the moment Stripe confirms it";
const STUDIO_MAIL = "Email to your list, on Studio";
const STUDIO_DOMAIN = "Your store on your own domain, on Studio";

function columns() {
  const text = strip(renderToStaticMarkup(MissionPage()));
  const cut = text.indexOf("Not built yet ·");
  return {
    text,
    built: text.slice(text.indexOf("Built and working ·"), cut),
    notBuilt: text.slice(cut),
  };
}

function main(): void {
  part("Control: the deployment state the page reads");
  is("Stripe Connect is set up in this synthetic deployment", isConnectConfigured(), true);
  is("domains can be added in this synthetic deployment", isDomainsConfigured(), true);
  const route = readFileSync("app/api/billing/checkout/route.ts", "utf8");
  is("the plan checkout refuses while plans are closed", route.includes('if (!PLANS_ON_SALE) return away(origin, studio("billing=not-open"));'), true);
  // An ordinary creator's store: Stripe connected and cleared to charge, no plan.
  const store = { handle: "mh", email: "creator@example.com", stripeAccountId: "acct_mission_honest", stripeChargesEnabled: true, subscriptionActive: false, suspended: false } as unknown as Store;
  is("a store without a paid plan cannot sell", canSell(store), false);

  const { text, built, notBuilt } = columns();
  const count = (s: string, label: RegExp) => Number(s.match(label)?.[1] ?? NaN);
  const headline = count(text, /([0-9]+) features built and working/);
  const column = count(built, /Built and working · ([0-9]+)/);
  const notBuiltHeadline = count(text, /([0-9]+) named, and not built yet/);
  const notBuiltColumn = count(notBuilt, /Not built yet · ([0-9]+)/);

  part("The headline figures are the lists they head");
  is("features built and working = the Built and working column", headline, column);
  is("named, and not built yet = the Not built yet column", notBuiltHeadline, notBuiltColumn);

  part(PLANS_ON_SALE ? "Plans are on sale: selling and Studio count as built" : "Plans are closed: what nobody can press is not built");
  is("starting a paid plan is under Built and working only while plans are on sale", built.includes("The subscription that pays us"), PLANS_ON_SALE);
  is(`"Selling" is under Built and working only while a store can sell`, built.includes(SELLING), PLANS_ON_SALE);
  is(`"${STUDIO_MAIL}" is under Built and working only while Studio can be bought`, built.includes(STUDIO_MAIL), PLANS_ON_SALE);
  is(`"${STUDIO_DOMAIN}" is under Built and working only while Studio can be bought`, built.includes(STUDIO_DOMAIN), PLANS_ON_SALE);
  if (!PLANS_ON_SALE) {
    is("selling from a store is named under Not built yet", /Selling from your own store: [^.]*not open until Marktmorgen's plans are on sale/.test(notBuilt), true);
    is(`"${STUDIO_MAIL}" is named under Not built yet`, notBuilt.includes(`${STUDIO_MAIL}:`) && notBuilt.includes("Studio is not on sale until Marktmorgen opens"), true);
    is(`"${STUDIO_DOMAIN}" is named under Not built yet`, notBuilt.includes(`${STUDIO_DOMAIN}:`), true);
    is("connecting Stripe, which anyone can do today, stays under Built and working", built.includes("Connecting your own Stripe account from the studio"), true);
  }
}

main();
done();
