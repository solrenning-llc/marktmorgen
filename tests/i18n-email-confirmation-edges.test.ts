/**
 * The buyer's purchase confirmation (lib/purchase-email.ts) with edge data,
 * in every store language:
 *
 *   - currencies with 0, 2 and 3 decimals (JPY, KRW, USD, EUR, KWD), and
 *     amounts of 0, 19.99 and a very large one;
 *   - a store name with <, >, &, quotes, an emoji and Arabic, and a product
 *     title of 80 characters, Hebrew letters with markup characters;
 *   - a one-time product, a payment plan, a membership with a trial and a
 *     set number of payments, and one with an introductory price.
 *
 * Nothing in the subject or the text may read "undefined", "NaN", "null",
 * "[object", "Infinity" or a placeholder left in braces; the amount is the
 * one charged, written with the currency's own decimals; and every name is
 * kept as typed (the email is plain text, so nothing is escaped).
 *
 * Synthetic store and buyer; nothing is sent.
 */
import { addProduct, claimHandle, ensureStatsId, setLanguage, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmationFor } from "@/lib/purchase-email";
import { speechFor } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

const OWNER = "owner@example.com";
const STORE_NAME = `Ünïcødé <Store> & "Co" 🍞 مخبز`;
/** At the store's 80-character limit for a title, so it is kept whole. */
const TITLE = `${"ש".repeat(74)} <b>&"`;
const BROKEN = /undefined|NaN|\bnull\b|\[object|Infinity|\{[A-Za-z]+\}/;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_confirmation_edges";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle(OWNER, "edges", STORE_NAME, "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestEdges000001", true);
  await setSubscription(OWNER, { customerId: "cus_Edges000001", subscriptionId: "sub_Edges000001", active: true, period: paidPeriod() });
  const one = await addProduct(OWNER, TITLE, "", "49", null);
  const club = await addProduct(OWNER, "Club", "", "20", { interval: "month", trialDays: 7, payments: 3 });
  if (!one.ok || !club.ok) throw new Error("no product");
  await setProductLink(OWNER, one.product.id, "https://example.com/one");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const now = Math.floor(Date.now() / 1000);
  const kinds = [
    { name: "one-time", product: one.product.id, mode: "payment", meta: {} },
    { name: "payment plan", product: one.product.id, mode: "payment", meta: { kind: "plan", plan_payments: "3", plan_interval: "week" } },
    { name: "membership with a trial", product: club.product.id, mode: "subscription", meta: { trial_days: "7", ends_after: "3" } },
    { name: "introductory price", product: club.product.id, mode: "subscription", meta: { intro: "2", intro_cents: "500", regular_cents: "2000" } },
  ];

  for (const language of LANGUAGE_CODES) {
    part(language);
    await setLanguage(OWNER, language);
    const store = (await storeForEmail(OWNER))!;
    const listings = [(await readListing(store, one.product.id))!, (await readListing(store, club.product.id))!];
    let written = 0;
    const broken: string[] = [];
    let unkept = 0;
    for (const currency of ["usd", "eur", "jpy", "krw", "kwd"]) {
      for (const amount of [0, 1999, 123456789]) {
        for (const kind of kinds) {
          // A trial charges nothing today; the other kinds are paid.
          if (kind.name === "membership with a trial" && amount !== 0) continue;
          const session = {
            id: "cs_test_edges000000000001", object: "checkout.session", status: "complete",
            payment_status: amount ? "paid" : "no_payment_required", mode: kind.mode, currency,
            amount_total: amount, amount_subtotal: amount, created: now, customer_details: { email: "buyer@example.com" },
            metadata: { store: "edges", product: kind.product, ...kind.meta },
          };
          const letter = confirmationFor(store, session as never, now, [], listings);
          if (!letter) continue;
          written += 1;
          const all = `${letter.subject}\n${letter.text}`;
          if (BROKEN.test(all)) broken.push(`${currency} ${amount} ${kind.name}: ${all.match(BROKEN)?.[0]}`);
          if (!letter.text.includes(STORE_NAME) || (kind.product === one.product.id && !letter.text.includes(TITLE))) unkept += 1;
        }
      }
    }
    is("every checkout is confirmed", written, 5 * 3 * 3 + 5);
    is("nothing unreplaced, unknown or not a number", broken, []);
    is("names kept as typed", [unkept, listings[0].title], [0, TITLE]);

    const said = (currency: string, amount: number) => {
      const session = {
        id: "cs_test_edges000000000002", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
        currency, amount_total: amount, amount_subtotal: amount, created: now, customer_details: { email: "buyer@example.com" },
        metadata: { store: "edges", product: one.product.id },
      };
      return confirmationFor(store, session as never, now, [], listings)?.text ?? "";
    };
    const money = (currency: string, amount: number) => speechFor(language, currency).money(amount);
    is("1999 cents of a dollar is 19.99", said("usd", 1999).includes(money("usd", 1999)) && /19.99/.test(money("usd", 1999)), true);
    is("1999 yen is 1,999 yen, never 19.99", said("jpy", 1999).includes(money("jpy", 1999)) && !/19.99/.test(money("jpy", 1999)) && /1.?999/.test(money("jpy", 1999)), true);
    is("1999 won is 1,999 won", said("krw", 1999).includes(money("krw", 1999)) && /1.?999/.test(money("krw", 1999)), true);
    is("1999 fils is 1.999 dinars", said("kwd", 1999).includes(money("kwd", 1999)) && /1.999/.test(money("kwd", 1999)), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
