/**
 * Paying yearly for a monthly membership (lib/yearly-price.ts, added 10
 * October 2026). What is checked: kept only on a monthly membership that runs
 * until canceled, at one price, outside the plans members switch between,
 * not beside an introductory price, and always saving against twelve monthly
 * payments; a product changed after it was set stops offering it; at
 * checkout, the year's price once a year only when the buyer picked it; the
 * confirmation says "a year"; the words in every store language.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { activeYearly, yearlyProblem, yearlySaving } from "@/lib/yearly-price";
import { introProblem } from "@/lib/intro-price";
import { canTier } from "@/lib/tier-rules";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { addProduct, claimHandle, ensureStatsId, setProductIntro, setProductLink, setProductYearly, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { confirmationFor } from "@/lib/purchase-email";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const checkouts: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"y".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
const member = (over: Record<string, unknown> = {}) => ({ id: "p1", priceCents: 2000, recurring: monthly, options: [] as unknown[], pwyw: null, ...over });

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_yearly_only_a_stand_in";

  part("Only where it can be kept");
  const yearly = { cents: 20000 };
  is("a monthly membership that runs until canceled", yearlyProblem(member(), yearly, 50), null);
  is("not a single sale, nor a weekly or yearly membership", [yearlyProblem(member({ recurring: null }), yearly, 50), yearlyProblem(member({ recurring: { ...monthly, interval: "week" } }), yearly, 50)], ["membership", "month"]);
  is("not on a set number of payments, several prices, or a chosen price", [yearlyProblem(member({ recurring: { ...monthly, payments: 6 } }), yearly, 50), yearlyProblem(member({ options: [{}] }), yearly, 50), yearlyProblem(member({ pwyw: { suggestedCents: 900 } }), yearly, 50)], ["payments", "options", "pwyw"]);
  is("not on plans members switch between, and neither of those can be one", [yearlyProblem(member(), yearly, 50, ["p1", "p2"]), canTier(member({ yearly }))], ["tiers", false]);
  is("one offer at a time: not beside an introductory price, either way round", [yearlyProblem(member({ intro: { cents: 500, count: 1 } }), yearly, 50), introProblem(member({ yearly }), { cents: 500, count: 1 }, 50)], ["intro", "yearly"]);
  is("a free trial before it is fine", yearlyProblem(member({ recurring: { ...monthly, trialDays: 7 } }), yearly, 50), null);
  is("always saving against twelve monthly payments", [yearlyProblem(member(), { cents: 24000 }, 50), yearlyProblem(member(), { cents: 23999 }, 50), yearlySaving(2000, yearly)], ["price", null, 4000]);
  is("a product changed after it was set stops offering it", [activeYearly(member({ yearly })), activeYearly(member({ yearly, priceCents: 1500 })), activeYearly(member({ yearly, recurring: { ...monthly, payments: 6 } }))], [yearly, null, null]);

  part("Said in every store language");
  const lines = LANGUAGE_CODES.map((code) => wordsIn(code)).map((w) => [w.billMonthly, w.billYearly, w.yearSave("$40"), w.yearlyFact("$200", "$40")]);
  is("each its own words", new Set(lines.map((l) => l.join("|"))).size, 7);
  is("each with the price and what it saves", lines.every(([, , save, fact]) => save.includes("$40") && fact.includes("$200") && fact.includes("$40")), true);
  is("in English", wordsIn("en").yearlyFact("$200", "$40"), "Or $200 a year, which saves $40");

  part("At checkout");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Supper Club", "", "20", monthly);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/club");
  is("refused when it would not save anything", (await setProductYearly(OWNER, made.product.id, { cents: 24000 })).ok, false);
  is("kept when it does", (await setProductYearly(OWNER, made.product.id, yearly)).ok, true);
  is("and then no introductory price beside it", (await setProductIntro(OWNER, made.product.id, { cents: 500, count: 1 })).ok, false);
  const open = async (more: Parameters<typeof createCheckout>[4] = {}) => {
    checkouts.length = 0;
    const store = (await storeForEmail(OWNER))!;
    await createCheckout(store, (await readProduct(store, made.product.id))!, "https://marktmorgen.com", "", { ...more, digitalConsent: TEST_CONSENT });
    return checkouts[0];
  };
  let sent = await open();
  is("monthly unless the buyer picks yearly", [sent.get("line_items[0][price_data][unit_amount]"), sent.get("line_items[0][price_data][recurring][interval]"), sent.get("metadata[every]")], ["2000", "month", null]);
  sent = await open({ yearly: true });
  is("picked: the year's price, once a year, said on the order", [sent.get("line_items[0][price_data][unit_amount]"), sent.get("line_items[0][price_data][recurring][interval]"), sent.get("metadata[every]"), sent.get("subscription_data[metadata][every]")], ["20000", "year", "year", "year"]);
  await setProductYearly(OWNER, made.product.id, null);
  sent = await open({ yearly: true });
  is("taken off, a yearly pick is the monthly price, never a made-up one", [sent.get("line_items[0][price_data][unit_amount]"), sent.get("line_items[0][price_data][recurring][interval]")], ["2000", "month"]);

  part("The confirmation says a year");
  const store = (await storeForEmail(OWNER))!;
  const listing = (await readListing(store, made.product.id))!;
  const session = {
    id: "cs_test_yearly0000001",
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "subscription",
    // As Stripe returns it: the price before discounts too, which says nothing came off (lib/purchase-email.ts).
    amount_subtotal: 20000,
    amount_total: 20000,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
    customer_details: { email: "buyer@example.com" },
    metadata: { store: "harbor", product: made.product.id, every: "year" },
  };
  const text = confirmationFor(store, session as never, Date.now() / 1000, [], [listing])?.text ?? "";
  is("what was paid, a year, and that it renews yearly", [text.includes("$200.00 a year") || text.includes("$200 a year"), /year/i.test(text.split("\n").find((l) => /renew/i.test(l)) ?? "")], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
