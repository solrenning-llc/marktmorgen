/**
 * Codex X8 money defect (issue #3941): a settled tip whose amount or currency
 * Stripe did not answer in its documented shape was read as 0, in the store's
 * currency (lib/store-tip-checkout.ts readTip), and the tip page thanked the
 * supporter for "$0" or for an amount in a currency Stripe never named.
 *
 * Checked, with the real readTip and the real tip page against the in-memory
 * Redis and a fetch stub standing in for Stripe:
 * - an amount that is missing, a string, fractional, negative, unsafe or null,
 *   or a currency that is missing, empty or not three lowercase letters, keeps
 *   the paid confirmation but with no amount and no currency (rule 24/30:
 *   unknown is never zero), and the page prints no figure for it;
 * - a zero amount with payment_status "paid" contradicts itself and is
 *   unknown too; zero is kept only when Stripe says no payment was required;
 * - controls: 500 in "usd" still reads and prints $5; a valid amount in a
 *   currency other than the store's prints Stripe's currency, never the
 *   store's.
 *
 * Synthetic store, nothing real is called.
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import TipPage from "@/app/[handle]/tip/page";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, setTips, storeForEmail } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { formatMoney } from "@/lib/money";
import { createTipCheckout, readTip } from "@/lib/store-tip-checkout";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "x8-tip-unknown@example.com";
const HANDLE = "x8tipunknown";
process.env.STRIPE_SECRET_KEY = "sk_test_x8_tip_unknown_only";

const OPENED = `cs_test_${"u".repeat(24)}`;
let stripeSession: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") return answer({ id: OPENED, url: "https://checkout.stripe.com/c/pay/test" });
  if (path.startsWith("/checkout/sessions/") && method === "GET") {
    const id = decodeURIComponent(path.slice("/checkout/sessions/".length));
    return id === OPENED ? answer(stripeSession) : answer({ error: { message: "No such checkout.session" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The sentence under the title of the drawn tip page. */
async function bodyOfPage(): Promise<string> {
  answering(new NextRequest(`https://marktmorgen.com/@${HANDLE}/tip?session_id=${OPENED}`, { headers: { "x-forwarded-for": "203.0.113.41" } }));
  const node = await TipPage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve({ session_id: OPENED }) });
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  const html = await new Response(stream).text();
  const found = /<p class="st-muted mt-4 text-lg">([\s\S]*?)<\/p>/.exec(html);
  return found ? found[1].replaceAll("<!-- -->", "") : `no body in ${html.slice(0, 200)}`;
}

const paid = (fields: Record<string, unknown>) => ({ id: OPENED, status: "complete", payment_status: "paid", metadata: { store: HANDLE, kind: "tip" }, ...fields });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Tip Unknown Pottery", "Pots.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_x8tipunknown1", subscriptionId: "sub_x8tipunknown1", active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_x8tipunknown01", true);
  await setTips(OWNER, { on: true, heading: "", line: "", amounts: [] });
  const store = (await storeForEmail(OWNER))!;
  await createTipCheckout(store, "https://marktmorgen.com", 500);
  const locale = speech(store).lang.locale;
  const storeCurrency = store.currency;

  part("Control: an amount and a currency Stripe answered are read and printed as they are");
  stripeSession = paid({ amount_total: 500, currency: "usd" });
  is("500 usd is read as it is", await readTip(store, OPENED), { state: "paid", amount: 500, currency: "usd" });
  is("and the page prints it", (await bodyOfPage()).includes(formatMoney(500, "usd", locale)), true);
  const foreign = storeCurrency === "eur" ? "gbp" : "eur";
  stripeSession = paid({ amount_total: 500, currency: foreign });
  is(`500 ${foreign}: Stripe's currency, not the store's`, await readTip(store, OPENED), { state: "paid", amount: 500, currency: foreign });
  is(`and the page prints ${foreign}`, (await bodyOfPage()).includes(formatMoney(500, foreign, locale)), true);
  stripeSession = paid({ payment_status: "no_payment_required", amount_total: 0, currency: "usd" });
  is("zero with no payment required: kept as zero", await readTip(store, OPENED), { state: "paid", amount: 0, currency: "usd" });

  part("An amount Stripe did not answer as a whole, safe, non-negative number is unknown, never zero");
  const amounts: [string, Record<string, unknown>][] = [
    ["missing", {}],
    ["null", { amount_total: null }],
    ["a string", { amount_total: "500" }],
    ["fractional", { amount_total: 5.5 }],
    ["negative", { amount_total: -500 }],
    ["unsafe", { amount_total: 2 ** 53 }],
    ["zero although paid", { amount_total: 0 }],
  ];
  for (const [label, fields] of amounts) {
    stripeSession = paid({ currency: "usd", ...fields });
    is(`${label}: paid, with no amount and no currency`, await readTip(store, OPENED), { state: "paid", amount: null, currency: null });
    const body = await bodyOfPage();
    is(`${label}: the page thanks without a figure`, [body.includes("has reached"), /\d/.test(body), body.includes("$")], [true, false, false]);
  }

  part("A currency Stripe did not answer as three lowercase letters is unknown, never the store's");
  const currencies: [string, Record<string, unknown>][] = [
    ["missing", {}],
    ["empty", { currency: "" }],
    ["two letters", { currency: "us" }],
    ["a number", { currency: 840 }],
    ["four letters", { currency: "usdd" }],
  ];
  for (const [label, fields] of currencies) {
    stripeSession = paid({ amount_total: 500, ...fields });
    is(`${label}: paid, with no amount and no currency`, await readTip(store, OPENED), { state: "paid", amount: null, currency: null });
    const body = await bodyOfPage();
    is(`${label}: the page prints no figure and no guessed currency`, [body.includes("has reached"), /\d/.test(body), body.includes("$")], [true, false, false]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
