/**
 * Rule 24: an offer after paying is answered once (lib/upsell.ts, takeUpsell).
 * Its "once" mark is a SET NX, and only "OK" makes this press the one that
 * answers: a reply cut short, a number or an object is read back, never taken
 * as this press's own. Otherwise two presses at the same moment both ran the
 * whole answer: the order counted twice in the plan's month, the paid answer
 * written back as pending, and the payment sent to Stripe twice (one charge
 * only by the idempotency key), with its after-payment steps twice.
 *
 * Synthetic only: a stand-in for the creator's Stripe account (which does NOT
 * collapse a repeated idempotency key, so a second POST shows here).
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readUpsell, takeUpsell, newUpsellKey } from "@/lib/upsell";
import { shownRef } from "./upsell-ref-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_claim_only";
process.env.RESEND_API_KEY = "re_test_upsell_claim_only";

const OWNER = "baker@example.com";
const BUYER = "buyer@example.com";
const ACCOUNT = "acct_1TestUpsell0001";
const NOW = Math.floor(Date.now() / 1000);

type Charge = { body: URLSearchParams; key: string };
const charges: Charge[] = [];
const made: Record<string, unknown>[] = [];
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const key = String((init?.headers as Record<string, string>)["Idempotency-Key"] ?? "");
    charges.push({ body, key });
    const pi = {
      id: `pi_test_${String(charges.length).padStart(10, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      status: "succeeded",
      receipt_email: body.get("receipt_email"),
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
    };
    made.push(pi);
    return answer(pi);
  }
  if (path === "/payment_intents" && method === "GET") {
    return answer({ object: "list", data: url.searchParams.get("customer") === "cus_TestBuyer01" ? made : [], has_more: false });
  }
  const one = /^\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = made.find((pi) => pi.id === one[1]);
    return found ? answer(found) : answer({ error: { message: "no such payment" } }, 404);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A paid checkout of the front product, as Stripe reports it, with the browser key it carried. */
function paidCheckout(id: string, product: string, fingerprint: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: "complete",
    payment_status: "paid",
    created: NOW - 60,
    customer: "cus_TestBuyer01",
    currency: "usd",
    metadata: { store: "harbor", product, upsell_key: fingerprint },
    customer_details: { email: BUYER },
    payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01" } },
    ...over,
  };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Sourdough Course", "49");
  const upsell = await add("Starter Kit Guide", "29");
  const saved = await setProductFunnel(OWNER, front, {
    steps: [{ id: "kit001", productId: upsell, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }],
  });
  if (!saved.ok) throw new Error("no funnel");
  const store = (await storeForEmail(OWNER))!;
  const origin = "https://marktmorgen.com";
  const browser = newUpsellKey();
  const take = async (session: string) =>
    takeUpsell({ store, session, secret: browser.secret, origin, step: await shownRef(store, "kit001"), answer: "yes", consent: TEST_CONSENT });

  type Batch = (string | number)[][];
  const pipeline = redis.pipeline.bind(redis);
  const onceMark = (batch: Batch) => batch.length === 1 && batch[0][0] === "SET" && String(batch[0][1]).startsWith("nl:upsell:") && batch[0].includes("NX");

  let n = 0;
  for (const [label, reply] of [
    ["cut short", [] as unknown[]],
    ["a number", [7]],
    ["an object", [{ result: "OK" }]],
  ] as [string, unknown[]][]) {
    n += 1;
    part(`Two presses at the same moment, the "once" mark answered ${label}`);
    const session = `cs_test_claim000000000${n}`;
    sessions[session] = paidCheckout(session, front, browser.fingerprint);
    const before = charges.length;
    // The mark is written as Redis would write it; only its answer comes back in another shape.
    redis.pipeline = (async (batch: Batch) => {
      const real = await pipeline(batch);
      return onceMark(batch) ? reply : real;
    }) as typeof redis.pipeline;
    let kinds: string[];
    try {
      kinds = (await Promise.all([take(session), take(session)])).map((r) => r.kind);
    } finally {
      redis.pipeline = pipeline;
    }
    is("the offer is sent to Stripe once, not once a press", charges.length - before, 1);
    is("both presses answer done", kinds, ["done", "done"]);
    is("the paid answer is kept as paid", (await readUpsell(session, ""))?.state, "paid");
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
