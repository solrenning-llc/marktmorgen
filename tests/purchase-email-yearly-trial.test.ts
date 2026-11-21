/**
 * A monthly membership paid yearly (lib/yearly-price.ts) may have a free trial
 * before it: nothing is charged today, and the first payment, when the trial
 * ends, is the year's price, since the subscription is made at it
 * (lib/store-checkout.ts sets the yearly unit amount and `metadata[every]`).
 *
 * The buyer's confirmation (lib/purchase-email.ts) said the first payment was
 * the monthly price: "Your first payment of $20 ... when the 7-day trial
 * ends", then "This renews once a year". It now says the year's price, in
 * every store language. A monthly checkout of the same product still says
 * the monthly price.
 *
 * Synthetic store and buyer; nothing is sent.
 */
import { addProduct, claimHandle, ensureStatsId, setLanguage, setProductLink, setProductYearly, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmationFor } from "@/lib/purchase-email";
import { speechFor } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

const OWNER = "owner@example.com";
/** Whether a line says this amount, as a whole: "$20" is not found inside "$200". */
const says = (line: string, amount: string) => new RegExp(`(?<![\\d.,])${amount.replace(/[.*+?^${}()|[\]\\$]/g, "\\$&")}(?!\\d|[.,]\\d)`).test(line);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_yearly_trial_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 7, payments: 0 });
  if (!club.ok) throw new Error("no membership");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const yearly = await setProductYearly(OWNER, club.product.id, { cents: 20000 });
  if (!yearly.ok) throw new Error(`no yearly price: ${yearly.reason}`);
  const now = Math.floor(Date.now() / 1000);
  const session = (every: "year" | null) => ({
    id: every ? "cs_test_yearlytrial000001" : "cs_test_monthlytrial00001",
    object: "checkout.session", status: "complete", payment_status: "no_payment_required", mode: "subscription",
    currency: "usd", amount_total: 0, amount_subtotal: 0, created: now, customer_details: { email: "buyer@example.com" },
    metadata: { store: "harbor", product: club.product.id, trial_days: "7", ...(every ? { every } : {}) },
  });

  for (const language of LANGUAGE_CODES) {
    part(`${language}: a 7-day trial before the yearly price`);
    await setLanguage(OWNER, language);
    const store = (await storeForEmail(OWNER))!;
    const listing = (await readListing(store, club.product.id))!;
    const money = speechFor(language, "usd").money;
    const year = confirmationFor(store, session("year") as never, now, [], [listing])?.text ?? "";
    const month = confirmationFor(store, session(null) as never, now, [], [listing])?.text ?? "";
    // The paragraph that says when the first payment is taken: the one with the trial's end date in it.
    const firstOn = speechFor(language, "usd").date((now + 7 * 86400) * 1000);
    const yearLine = year.split("\n").find((line) => line.includes(firstOn)) ?? "";
    const monthLine = month.split("\n").find((line) => line.includes(firstOn)) ?? "";
    is("the first payment is the year's price", says(yearLine, money(20000)), true);
    is("and never the monthly price", says(yearLine, money(2000)), false);
    is("a monthly checkout still says the monthly price", [says(monthLine, money(2000)), says(monthLine, money(20000))], [true, false]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
