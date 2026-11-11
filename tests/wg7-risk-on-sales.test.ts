/**
 * 647 [WG7], unit 2: the studio's list of sales says the risk Stripe gave
 * each charge, read off the charge expanded on the same two reads the list
 * already makes (no new Stripe call), and never says "normal" when the risk
 * cannot be read. A membership that started with a free trial charged
 * nothing at checkout, so it has no risk to show.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousApi = process.env.STRIPE_CONNECT_API_BASE;
  process.env.STRIPE_SECRET_KEY = "sk_test_wg7_risk_only_a_stand_in";
  process.env.STRIPE_CONNECT_API_BASE = "http://127.0.0.1:4998";
  let sessions: unknown = { data: [] };
  let intents: unknown = { data: [] };
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "http://127.0.0.1:4998" || (init?.method ?? "GET") !== "GET") {
      throw new Error("Only synthetic sale reads are allowed");
    }
    calls.push(url);
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify(sessions));
    if (url.pathname === "/v1/payment_intents") return new Response(JSON.stringify(intents));
    throw new Error("Unexpected synthetic endpoint");
  }) as typeof fetch;
  try {
    redis.clear();
    const { claimHandle, setStripeAccount, setSubscription, storeForEmail } = await import("@/lib/store");
    const { listSales } = await import("@/lib/store-checkout");
    const email = "wg7-risk-proof@example.test";
    await claimHandle(email, "wg7riskproof", "Risk proof", "");
    await setStripeAccount(email, "acct_fixture647", true);
    await setSubscription(email, { customerId: "cus_Wg7RiskProof1", subscriptionId: "sub_Wg7RiskProof1", active: true, period: paidPeriod() });
    const store = (await storeForEmail(email))!;
    const now = Math.floor(Date.now() / 1000);
    const charge = (id: string, outcome: unknown) => ({ id, object: "charge", outcome });
    const checkout = (id: string, paymentIntent: unknown, extra: Record<string, string> = {}, created = now) => ({
      id, status: "complete", payment_status: "paid", created, amount_total: 4900, currency: "usd",
      metadata: { store: store.handle, title: `Sale ${id}`, ...extra },
      customer_details: { email: "synthetic-buyer@example.test" },
      payment_intent: paymentIntent,
    });

    sessions = { data: [
      checkout("cs_test_normal", { id: "pi_n", object: "payment_intent", latest_charge: charge("ch_n", { risk_level: "normal" }) }, {}, now - 1),
      checkout("cs_test_elevated", { id: "pi_e", object: "payment_intent", latest_charge: charge("ch_e", { risk_level: "elevated" }) }, {}, now - 2),
      checkout("cs_test_highest", { id: "pi_h", object: "payment_intent", latest_charge: charge("ch_h", { risk_level: "highest" }) }, {}, now - 3),
      checkout("cs_test_notassessed", { id: "pi_x", object: "payment_intent", latest_charge: charge("ch_x", { risk_level: "not_assessed" }) }, {}, now - 4),
      checkout("cs_test_unexpanded", "pi_unexpanded", {}, now - 5),
      checkout("cs_test_chargeid", { id: "pi_c", object: "payment_intent", latest_charge: "ch_only_an_id" }, {}, now - 6),
      checkout("cs_test_nointent", null, {}, now - 7),
      checkout("cs_test_lowword", { id: "pi_l", object: "payment_intent", latest_charge: charge("ch_l", { risk_level: "low" }) }, {}, now - 8),
      checkout("cs_test_trial", null, { trial_days: "7" }, now - 9),
      checkout("cs_test_customerobj", { id: "cus_x", object: "customer", latest_charge: charge("ch_c", { risk_level: "highest" }) }, {}, now - 12),
      checkout("cs_test_noobject", { id: "pi_y", latest_charge: charge("ch_y", { risk_level: "normal" }) }, {}, now - 13),
    ] };
    intents = { data: [
      { id: "pi_upsell_risky", object: "payment_intent", status: "succeeded", created: now - 10, amount: 900, currency: "usd",
        metadata: { kind: "upsell", store: store.handle, title: "Extra" }, latest_charge: charge("ch_u", { risk_level: "highest" }) },
      { id: "pi_upsell_plain", object: "payment_intent", status: "succeeded", created: now - 11, amount: 900, currency: "usd",
        metadata: { kind: "upsell", store: store.handle, title: "Extra two" }, latest_charge: "ch_unexpanded" },
    ] };

    part("The risk comes from the reads the list already makes");
    const before = calls.length;
    const list = await listSales(store);
    is("still exactly two reads of Stripe", calls.length - before, 2);
    const [sessionRead, intentRead] = calls.slice(before);
    is("the checkouts read expands each payment's charge", sessionRead.searchParams.getAll("expand[]").includes("data.payment_intent.latest_charge"), true);
    is("the one-click extras read expands each charge", intentRead.searchParams.getAll("expand[]").includes("data.latest_charge"), true);
    if (list.state !== "ok") throw new Error("Expected a readable list");
    const risk = new Map(list.sales.map((sale) => [sale.reference, sale.risk]));

    part("Stripe's three levels are said as Stripe says them");
    is("normal", risk.get("cs_test_normal"), "normal");
    is("elevated", risk.get("cs_test_elevated"), "elevated");
    is("highest", risk.get("cs_test_highest"), "highest");
    is("an extra taken after paying has its own risk", risk.get("pi_upsell_risky"), "highest");

    part("A risk that cannot be read is never normal");
    is("not assessed", risk.get("cs_test_notassessed"), "not_available");
    is("payment not expanded", risk.get("cs_test_unexpanded"), "not_available");
    is("charge not expanded", risk.get("cs_test_chargeid"), "not_available");
    is("no payment on the checkout", risk.get("cs_test_nointent"), "not_available");
    is("a word Stripe does not send", risk.get("cs_test_lowword"), "not_available");
    is("another kind of object in the payment's place (Codex C2 on #3647)", risk.get("cs_test_customerobj"), "not_available");
    is("a payment that does not say what it is", risk.get("cs_test_noobject"), "not_available");
    is("an extra whose charge was not expanded", risk.get("pi_upsell_plain"), "not_available");

    part("A free trial charged nothing, so it shows no risk");
    is("trial has no risk", risk.get("cs_test_trial"), null);

    part("The studio shows the risk in words on each sale");
    const page = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
    is("the sales list reads the shared words", /RISK_WORDS\[sale\.risk\]/.test(page), true);
    is("the words come from lib/payment-risk.ts", /import \{[^}]*\bRISK_WORDS\b[^}]*\} from "@\/lib\/payment-risk"/.test(page), true);
    done();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousApi === undefined) delete process.env.STRIPE_CONNECT_API_BASE; else process.env.STRIPE_CONNECT_API_BASE = previousApi;
  }
}
void main();
