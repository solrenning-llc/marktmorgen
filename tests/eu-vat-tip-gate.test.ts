/**
 * EU VAT art. 9a, 789 [IV1] unit 1 (owner's decision IV, 19/11/2026): "Support my work" asks lib/eu-vat-gate.ts
 * consumerGate before anything is sent to Stripe. A gift is no product, so under the gate it is a paid supply of
 * unknown kind: refused to a buyer in the EU or the UK, and asked for the billing country otherwise. The box becomes
 * one form (an amount to choose, another amount, the billing country and one button), so the country is asked once
 * whichever amount is chosen. Synthetic only: the in-memory Redis and a stand-in for Stripe; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, setTips, storeForEmail, type Store } from "@/lib/store";
import { TIPS_WORDS } from "@/lib/buyer-words/tips";
import { BILLING_COUNTRY_FIELD } from "@/lib/eu-vat-evidence";
import { REFUSE_CONSUMERS_DRAFTS, REFUSE_CONSUMERS_OPEN } from "@/lib/deemed-supplier-drafts";
import { POST as tipRoute } from "@/app/api/store/tip/route";
import { StoreTipBox, TIP_PROBLEMS } from "@/components/store-tip-box";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_eu_vat_tip_gate_only";

const sessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    sessions.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"g".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const SHOP = "tipvatgate";
const OWNER = "tipvatgate@example.com";

const ask = (ip: string | null, fields: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const headers: Record<string, string> = { host: "marktmorgen.com", origin: "https://marktmorgen.com" };
  if (ip) headers["x-vercel-ip-country"] = ip;
  return new NextRequest("https://marktmorgen.com/api/store/tip", { method: "POST", body: form, headers });
};

async function html(node: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(node, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, SHOP, "Tip VAT Gate", "");
  await ensureStatsId(OWNER);
  await setTips(OWNER, { on: true, heading: "", line: "", amounts: [] });
  await setStripeAccount(OWNER, "acct_1TipVatGate01", true);
  await setSubscription(OWNER, { customerId: "cus_TipVatGate1", subscriptionId: "sub_TipVatGate1", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const tip = (ip: string | null, fields: Record<string, string> = {}) => tipRoute(ask(ip, { handle: SHOP, ...fields }));
  const where = (response: Response) => [response.status, response.headers.get("location")];
  const back = (problem: string) => [303, `https://marktmorgen.com/@${SHOP}?tip=${problem}#support`];
  const amountSent = () => Number(sessions[sessions.length - 1]?.get("line_items[0][price_data][unit_amount]"));

  part("The route asks the gate before Stripe");
  let before = sessions.length;
  is("an EU buyer: back to the box with abroad", where(await tip("DE", { amount: "500", [BILLING_COUNTRY_FIELD]: "DE" })), back("abroad"));
  is("a UK buyer by billing country alone: abroad", where(await tip(null, { amount: "500", [BILLING_COUNTRY_FIELD]: "GB" })), back("abroad"));
  is("a VPN outside with an EU billing country: abroad", where(await tip("US", { amount: "500", [BILLING_COUNTRY_FIELD]: "IE" })), back("abroad"));
  is("another amount from the EU: abroad", where(await tip("FR", { amount: "other", other: "7", [BILLING_COUNTRY_FIELD]: "FR" })), back("abroad"));
  is("no billing country: asked for it", where(await tip("US", { amount: "500" })), back("country"));
  is("Stripe was never asked for any of them", sessions.length - before, 0);
  before = sessions.length;
  const preset = await tip("US", { amount: "500", [BILLING_COUNTRY_FIELD]: "US" });
  is("outside, an amount chosen: Stripe's page for it", [where(preset), amountSent()], [[303, "https://checkout.stripe.com/c/pay/test"], 500]);
  await tip("CA", { amount: "other", other: "7", [BILLING_COUNTRY_FIELD]: "CA" });
  is("outside, another amount chosen and typed: that amount", amountSent(), 700);
  await tip("US", { other: "8", [BILLING_COUNTRY_FIELD]: "US" });
  is("outside, another amount typed with nothing chosen (Enter in the box): that amount", amountSent(), 800);
  is("three checkouts opened", sessions.length - before, 3);
  is("another amount chosen but left empty: asked for an amount", where(await tip("US", { amount: "other", other: "", [BILLING_COUNTRY_FIELD]: "US" })), back("amount"));

  part("One form: the amount, the country and one button");
  const plain = await html(StoreTipBox({ store, problem: "", rehearsal: false }));
  const forms = plain.match(/<form[^>]*action="\/api\/store\/tip"[\s\S]*?<\/form>/g) ?? [];
  is("one form only", forms.length, 1);
  const form = forms[0] ?? "";
  is("a choice for each amount", (form.match(/<input[^>]*type="radio"[^>]*name="amount"/g) ?? []).length, 4);
  is("and one for another amount", /<input[^>]*type="radio"[^>]*name="amount"[^>]*value="other"|<input[^>]*value="other"[^>]*name="amount"/.test(form), true);
  is("the box for another amount", /<input[^>]*name="other"/.test(form), true);
  is("the billing-country field, required", new RegExp(`<select[^>]*name="${BILLING_COUNTRY_FIELD}"[^>]*required`).test(form), true);
  is("one button", (form.match(/<button/g) ?? []).length, 1);
  is("no field marked invalid on a first visit", /aria-invalid="true"/.test(form), false);
  for (const problem of ["abroad", "country"] as const) {
    const drawn = await html(StoreTipBox({ store, problem, rehearsal: false }));
    is(`${problem}: the notice is shown`, drawn.includes(TIPS_WORDS.en.notices[problem]?.title.replace(/'/g, "&#x27;") ?? "\u0000"), true);
    const field = new RegExp(`<select[^>]*name="${BILLING_COUNTRY_FIELD}"[^>]*>`).exec(drawn)?.[0] ?? "";
    const described = /aria-describedby="([^"]+)"/.exec(field)?.[1] ?? "";
    is(`${problem}: the field is marked invalid`, /aria-invalid="true"/.test(field), true);
    is(`${problem}: the field is described by the notice`, described !== "" && drawn.includes(`id="${described}"`), true);
    is(`${problem}: the store page passes it to the box`, TIP_PROBLEMS.has(problem), true);
  }

  part("The refuse-consumers drafts name this path as gated");
  is("store tips are no longer listed as open", REFUSE_CONSUMERS_OPEN.some((line) => line.startsWith("store tips")), false);
  for (const draft of REFUSE_CONSUMERS_DRAFTS) {
    is(`${draft.jurisdiction}: the route is named`, draft.implementedIn.includes("app/api/store/tip/route.ts"), true);
    is(`${draft.jurisdiction}: this test is named`, draft.evidence.includes("tests/eu-vat-tip-gate.test.ts"), true);
  }

  part("Every language says both");
  for (const [language, words] of Object.entries(TIPS_WORDS)) {
    for (const problem of ["abroad", "country"] as const) {
      const said = words.notices[problem];
      is(`${language}: ${problem} has a title and a body`, !!said && said.title.trim().length > 0 && said.body.trim().length > 0, true);
    }
  }

  done();
}

void main();
