/**
 * 609 [WP8]: the words after paying say how often the membership is charged
 * as its checkout sent it to Stripe, never as the product reads now. Stripe is
 * played by a stand-in for `fetch`; synthetic store, no email sent.
 *
 *   - the checkout keeps the interval and its count on the order, only when
 *     the count is more than one (a monthly checkout is unchanged);
 *   - the confirmation email's "Paid:" line, its line after a discount and
 *     its renewal line say "every 3 months" for one charged every 3 months, in
 *     every buyer language;
 *   - a creator who changes the product while a checkout is open does not
 *     change what the buyer is told: an order charged every 3 months still
 *     says so after the product went monthly, and an order charged monthly
 *     still says a month after the product went to every 3 months;
 *   - the page after paying reads the same record.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { membershipWords } from "@/lib/buyer-words/membership";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { confirmationFor } from "@/lib/purchase-email";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "every-paid-owner@example.com";
const checkouts: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"p".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_every_paid_only_a_stand_in";
  const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
  const quarterly = { ...monthly, every: 3 };
  await claimHandle(OWNER, "everypaid", "Every Paid", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestEveryPaid1", true);
  await setSubscription(OWNER, { customerId: "cus_EveryPaid01", subscriptionId: "sub_EveryPaid01", active: true, period: paidPeriod() });
  const box = await addProduct(OWNER, "Seasonal Box", "", "90", quarterly);
  const club = await addProduct(OWNER, "Supper Club", "", "9", monthly);
  if (!box.ok || !club.ok) throw new Error("no product");
  await setProductLink(OWNER, box.product.id, "https://example.com/box");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const store = (await storeForEmail(OWNER))!;

  part("The checkout keeps how often it charges on the order");
  const open = async (id: string) => {
    checkouts.length = 0;
    await createCheckout(store, (await readProduct(store, id))!, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT });
    return checkouts[0];
  };
  const sent = await open(box.product.id);
  is("every 3 months: the interval and its count, beside what Stripe is sent", [sent.get("metadata[every_n]"), sent.get("line_items[0][price_data][recurring][interval_count]")], ["month:3", "3"]);
  const plainSent = await open(club.product.id);
  is("a monthly checkout is unchanged: nothing more on the order", [plainSent.has("metadata[every_n]"), plainSent.has("subscription_data[metadata][every_n]")], [false, false]);

  part("The confirmation email, as the order was charged");
  const boxListing = (await readListing(store, box.product.id))!;
  const now = Math.floor(Date.now() / 1000);
  const session = (every_n: string | null, extra: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
    object: "checkout.session", id: "cs_test_everypaid0000000001", status: "complete", payment_status: "paid", mode: "subscription",
    currency: "usd", created: now, customer_details: { email: "buyer@example.com" }, amount_subtotal: 9000, amount_total: 9000,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    metadata: { store: "everypaid", product: box.product.id, ...(every_n ? { every_n } : {}), ...meta },
    ...extra,
  });
  const text = (s: typeof store, sess: unknown, listing = boxListing) => confirmationFor(s, sess as never, now, [], [listing])?.text ?? "";
  const line = (body: string, start: string) => body.split("\n").find((l) => l.startsWith(start)) ?? "";
  const charged = text(store, session("month:3"));
  is("Paid: every 3 months", line(charged, "Paid:"), "Paid: $90 every 3 months");
  const renews = (body: string) => line(body, "This renews").split(". ")[0];
  is("and it renews every 3 months, never once a month", [renews(charged), charged.includes("once a month")], ["This renews once every 3 months until you cancel it", false]);
  const coded = text(store, session("month:3", { amount_total: 4500, total_details: { amount_discount: 4500, amount_shipping: 0, amount_tax: 0 } }, { code: "LAUNCH" }));
  is("after a discount on the first charge, each charge after it every 3 months", line(coded, "Paid:"), "Paid: $45 today, with your discount. Each charge after this one: $90 every 3 months, less your discount for as long as it lasts.");
  // Twice: the "Paid:" line and the renewal line.
  is("in every buyer language, the price and the renewal both name the exact interval", LANGUAGE_CODES.filter((code) => text({ ...store, language: code }, session("month:3")).split(membershipWords(code).every("month", 3)).length < 3), []);

  part("A product changed while the checkout was open does not change what the buyer is told");
  const nowMonthly = { ...boxListing, recurring: monthly };
  const after = text(store, session("month:3"), nowMonthly);
  is("charged every 3 months, product now monthly: still every 3 months", [line(after, "Paid:"), renews(after)], ["Paid: $90 every 3 months", "This renews once every 3 months until you cancel it"]);
  const before = text(store, session(null));
  is("charged monthly, product now every 3 months: a month", [line(before, "Paid:"), renews(before)], ["Paid: $90 a month", "This renews once a month until you cancel it"]);
  const weeks = text(store, session("week:2"), nowMonthly);
  is("charged every 2 weeks, product now monthly: every 2 weeks", line(weeks, "Paid:"), "Paid: $90 every 2 weeks");

  part("The page after paying reads the same record");
  const thanks = readFileSync(join(process.cwd(), "app/[handle]/thanks/page.tsx"), "utf8");
  is("from the order, not from the product as it is now", [thanks.includes("paidEveryOf("), thanks.includes("order.product.recurring.every")], [true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
