/**
 * EU VAT art. 9a, 789 [IV1] unit 1 (owner's decision IV, 19/11/2026): a payment request asks lib/eu-vat-gate.ts
 * consumerGate before anything is sent to Stripe, as the card checkout and the cart already do. What a request bills
 * is free text, so its kind never reads: under the gate it is a paid sale of unknown kind, refused to a buyer in the
 * EU or the UK and asked for the billing country otherwise. The page draws the billing-country field inside its
 * "Pay" form and says why the last try came back, in the store's language. Synthetic only: the in-memory Redis and a
 * stand-in for Stripe; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { createRequest } from "@/lib/payment-request-store";
import { REQUEST_WORDS } from "@/lib/buyer-words/requests";
import { BILLING_COUNTRY_FIELD } from "@/lib/eu-vat-evidence";
import { POST as payRoute } from "@/app/api/store/pay-request/route";
import PaymentRequestPage from "@/app/[handle]/pay/[request]/page";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_eu_vat_pay_request_gate_only";

const sessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    sessions.push(new URLSearchParams(String(init?.body)));
    const id = `cs_test_${String(sessions.length).padStart(24, "p")}`;
    return new Response(JSON.stringify({ id, status: "open", payment_status: "unpaid", url: "https://checkout.stripe.com/c/pay/test", metadata: {}, created: Math.floor(Date.now() / 1000) }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const SHOP = "payvatgate";
const OWNER = "payvatgate@example.com";

const ask = (ip: string | null, fields: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const headers: Record<string, string> = { host: "marktmorgen.com", origin: "https://marktmorgen.com" };
  if (ip) headers["x-vercel-ip-country"] = ip;
  return new NextRequest("https://marktmorgen.com/api/store/pay-request", { method: "POST", body: form, headers });
};

async function markup(url: string, run: () => Promise<unknown>): Promise<string> {
  answering(new Request(url));
  const node = await run();
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, SHOP, "Pay VAT Gate Studio", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPayVatGate1", true);
  await setSubscription(OWNER, { customerId: "cus_PayVatGate01", subscriptionId: "sub_PayVatGate01", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const made = await createRequest(store, { email: "client@example.com", name: "Sam", lines: [{ text: "Coaching, December", quantity: 1, cents: 12000 }], note: "", dueDate: "", autoReminders: 0, total: 12000 } as Parameters<typeof createRequest>[1]);
  if (!made.ok) throw new Error(`no request: ${made.reason}`);
  const id = made.request.id;
  const pay = (ip: string | null, fields: Record<string, string> = {}) => payRoute(ask(ip, { handle: SHOP, request: id, ...fields }));
  const where = (response: Response) => [response.status, response.headers.get("location")];
  const back = (notice: string) => [303, `https://marktmorgen.com/@${SHOP}/pay/${id}?notice=${notice}`];

  part("The route asks the gate before Stripe");
  let before = sessions.length;
  is("an EU buyer: back to the request with abroad", where(await pay("DE", { [BILLING_COUNTRY_FIELD]: "DE" })), back("abroad"));
  is("a UK buyer by billing country alone: abroad", where(await pay(null, { [BILLING_COUNTRY_FIELD]: "GB" })), back("abroad"));
  is("a VPN outside with an EU billing country: abroad", where(await pay("US", { [BILLING_COUNTRY_FIELD]: "FR" })), back("abroad"));
  is("a connection in the UK with a billing country outside: abroad", where(await pay("GB", { [BILLING_COUNTRY_FIELD]: "US" })), back("abroad"));
  is("no billing country: asked for it", where(await pay("US")), back("country"));
  is("a billing code the field never offers: asked again", where(await pay("US", { [BILLING_COUNTRY_FIELD]: "ZZ" })), back("country"));
  is("Stripe was never asked for any of them", sessions.length - before, 0);
  before = sessions.length;
  const fine = await pay("US", { [BILLING_COUNTRY_FIELD]: "US" });
  is("outside, with the billing country: Stripe's page opens", [fine.status, fine.headers.get("location"), sessions.length - before], [303, "https://checkout.stripe.com/c/pay/test", 1]);

  part("The page draws the field inside the Pay form, and says why it came back");
  const page = (query: Record<string, string>) =>
    markup(`https://marktmorgen.com/@${SHOP}/pay/${id}`, () =>
      PaymentRequestPage({ params: Promise.resolve({ handle: `@${SHOP}`, request: id }), searchParams: Promise.resolve(query) } as Parameters<typeof PaymentRequestPage>[0]),
    );
  const plain = await page({});
  const form = /<form[^>]*action="\/api\/store\/pay-request"[\s\S]*?<\/form>/.exec(plain)?.[0] ?? "";
  is("the Pay form is drawn", form.length > 0, true);
  is("the billing-country field is inside it, required", new RegExp(`<select[^>]*name="${BILLING_COUNTRY_FIELD}"[^>]*required`).test(form), true);
  is("no field is marked invalid on a first visit", /aria-invalid="true"/.test(form), false);
  for (const notice of ["abroad", "country"] as const) {
    const html = await page({ notice });
    const said = REQUEST_WORDS.en.notices[notice];
    is(`${notice}: the notice is shown`, html.includes(said.title.replace(/'/g, "&#x27;")), true);
    const field = new RegExp(`<select[^>]*name="${BILLING_COUNTRY_FIELD}"[^>]*>`).exec(html)?.[0] ?? "";
    const described = /aria-describedby="([^"]+)"/.exec(field)?.[1] ?? "";
    is(`${notice}: the field is marked invalid`, /aria-invalid="true"/.test(field), true);
    is(`${notice}: the field is described by the notice`, described !== "" && html.includes(`id="${described}"`), true);
  }

  part("Every language says both");
  for (const [language, words] of Object.entries(REQUEST_WORDS)) {
    for (const notice of ["abroad", "country"] as const) {
      const said = words.notices[notice];
      is(`${language}: ${notice} has a title and a body`, !!said && said.title.trim().length > 0 && said.body.trim().length > 0, true);
    }
  }

  done();
}

void main();
