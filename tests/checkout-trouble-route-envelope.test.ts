/**
 * The real single-product checkout, cart and payment request that Stripe refuses on purpose (a 400), with the work
 * each leaves for after its answer (noteCheckoutTrouble's fenced count, checkout-trouble-live:v1, row 104 of #5010),
 * still fit one order's ORDER_COMPUTE (Claude 1 coord's rule 964c: every fence measured on its whole route, at its
 * worst, against its scope's envelope; Claude 7 xAF's MÉDIO on #5188). A refused checkout or cart keeps its order
 * admission, so it is one order of the month; a payment request's opens are inside that request's own ORDER_COMPUTE.
 * Every command sent and every byte sent and read is counted, and each EVAL with every redis.call its source names.
 * Synthetic store, the in-memory Redis and a stand-in Stripe and Resend only.
 */
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { POST as cartRoute } from "@/app/api/store/cart/route";
import { POST as payRequestRoute } from "@/app/api/store/pay-request/route";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest } from "@/lib/payment-request-store";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { withConsent } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { COMMAND, DB_BYTE, ORDER_COMPUTE } from "./plan-cost-registry";

process.env.STRIPE_SECRET_KEY = "sk_test_cotrouble_route_only";
process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const OWNER = "cotrouble-route@example.com";
const HANDLE = "cotrouble-route";
const ACCOUNT = "acct_1TestCoTrblRte0";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") return json({ id: "email_cotrouble_route" });
  if (url.hostname !== "api.stripe.com") throw new Error(`Unexpected provider: ${url.hostname}`);
  if (url.pathname.startsWith("/v2/core/accounts/") && method === "GET") {
    return json({ id: ACCOUNT, configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } }, requirements: {} });
  }
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
    return json({ error: { type: "invalid_request_error", message: "Synthetic refusal from the account." } }, 400);
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type Command = (string | number)[];

/** Runs one route with Stripe refusing, then the work it left to after(), and checks the whole against ORDER_COMPUTE. */
async function measure(what: string, run: () => Promise<Response>, back: string): Promise<void> {
  part(`${what}: refused by Stripe, with its after() work, fits one order's ORDER_COMPUTE`);
  // Each route at its worst: the day's mark not yet taken, so the count, the mark and the creator's email all happen.
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  redis.run(["DEL", `nl:cotrouble:${statsId}`, `nl:cotrouble:mail:${statsId}:${new Date().toISOString().slice(0, 10)}`]);
  const real = redis.pipeline.bind(redis);
  const seen: Command[] = [];
  let bytes = 0;
  const beforeCalls = redis.scriptCalls;
  redis.pipeline = (async (commands: Command[]) => {
    seen.push(...commands);
    const replies = await real(commands);
    bytes += JSON.stringify(commands).length + JSON.stringify(replies).length;
    return replies;
  }) as typeof redis.pipeline;
  let location: string | null = null;
  try {
    afterTasks.length = 0;
    location = (await run()).headers.get("location");
    for (const task of afterTasks.splice(0)) await (task as () => Promise<unknown>)();
  } finally {
    redis.pipeline = real;
  }
  is(`${what}: the buyer is sent back`, location?.includes(back) ?? false, true);
  const fenced = seen.filter((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:checkout-trouble-live:")).length;
  is(`${what}: the refusal was counted through the fenced script once`, fenced, 1);
  // Each EVAL at the most its script can call: every redis.call or redis.pcall its source text names, never fewer.
  const innerMost = seen.filter((c) => c[0] === "EVAL").reduce((sum, c) => sum + (String(c[1]).match(/redis\.p?call\(/g) ?? []).length, 0);
  const measured = seen.length + Math.max(redis.scriptCalls - beforeCalls, 0) + innerMost;
  const usd = measured * COMMAND + bytes * DB_BYTE;
  console.log("CHECKOUT_TROUBLE_ROUTE", JSON.stringify({ what, external: seen.length, scriptCalls: redis.scriptCalls - beforeCalls, innerMost, measured, bytes, usd, orderCompute: ORDER_COMPUTE }));
  is(`${what}: ${measured} commands and ${bytes} bytes ($${usd.toFixed(6)}) fit one order's ORDER_COMPUTE ($${ORDER_COMPUTE})`, usd <= ORDER_COMPUTE, true);
}

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Trouble route", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_CoTrblRoute001", subscriptionId: "sub_CoTrblRoute001", active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Synthetic guide", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");

  await measure("The single-product checkout", () => {
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("billing_country", "US");
    form.set("product", made.product.id);
    return checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(form), headers: { host: "marktmorgen.com" } }));
  }, `/@${HANDLE}?status=error`);

  await measure("The cart", () => {
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("billing_country", "US");
    form.set("id", made.product.id);
    return cartRoute(new NextRequest("https://marktmorgen.com/api/store/cart", { method: "POST", body: withConsent(form), headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com" } }));
  }, `/@${HANDLE}`);

  const store = (await storeForEmail(OWNER))!;
  const draft = readDraft({ email: "client-route@example.com", name: "Client", lines: [{ text: "Coaching, November", quantity: 1, amount: "120" }], note: "", dueDate: "", autoReminders: 0, consent: true }, store.currency);
  if (!draft.ok) throw new Error(`draft ${draft.problem}`);
  const asked = await createRequest(store, draft.draft);
  if (!asked.ok) throw new Error(asked.reason);
  await measure("A payment request", () => {
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("billing_country", "US");
    form.set("request", asked.request.id);
    return payRequestRoute(new NextRequest("https://marktmorgen.com/api/store/pay-request", { method: "POST", body: form, headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com" } }));
  }, `/@${HANDLE}/pay/${asked.request.id}?notice=`);
  done();
}

void main();
