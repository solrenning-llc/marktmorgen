/** Independent PR 2742 review: a partial object is unknown payment history. */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { DAY, NOW, paidShop, world } from "./plan-refund-stripe-world";
import { readPlanRefund } from "@/lib/plan-refund";
import { refundPlanPayment } from "@/lib/plan-refund-write";

const stripe = globalThis.fetch;
let answer: { path: string; customer?: string; data: unknown[] } | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (url.hostname === "api.stripe.com" && (init?.method ?? "GET") === "GET" && answer?.path === path && (!answer.customer || answer.customer === url.searchParams.get("customer"))) {
    world.calls.push(`GET ${path}`);
    return new Response(JSON.stringify({ object: path.endsWith("/search") ? "search_result" : "list", data: answer.data, has_more: false, ...(path.endsWith("/search") ? { next_page: null } : {}) }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return stripe(input, init);
}) as typeof fetch;

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  const read = async (shop: Awaited<ReturnType<typeof paidShop>>) => readPlanRefund(await shop.store(), NOW);
  part("Known intact histories remain decided");
  const first = await paidShop();
  is("the complete first-payment control has the guarantee", (await read(first)).refund, { kind: "guarantee", cents: 6_900 });
  const older = await paidShop({ at: NOW - 45 * DAY });
  is("the complete old-payment control is outside the window", (await read(older)).refund, { kind: "none", reason: "outside_window" });

  part("A partial customer search row must not certify no prior person");
  for (const row of [{}, { id: "cus_older0001" }]) {
    answer = { path: "/customers/search", data: [row] };
    is("missing customer identity or email stays unknown", (await read(first)).refund.kind, "unknown");
  }
  answer = null;

  part("A partial older-card search row must not certify no prior card payment");
  for (const row of [{}, { id: "ch_older0001" }]) {
    answer = { path: "/charges/search", data: [row] };
    is("missing charge identity or created time stays unknown", (await read(first)).refund.kind, "unknown");
  }
  answer = null;

  part("A partial own charge history must not become a decided renewal");
  const current = await paidShop();
  const currentStore = await current.store();
  for (const row of [{}, { id: "ch_partial0001", status: "succeeded", paid: true }]) {
    answer = { path: "/charges", customer: currentStore.stripeCustomerId!, data: [row] };
    is("missing charge evidence stays unknown rather than no first payment", (await read(current)).refund.kind, "unknown");
  }
  answer = null;

  part("Intact controls after every override");
  is("the first-payment control recovers without any product edit", (await read(first)).refund.kind, "guarantee");
  is("the old-payment control remains outside the window", (await read(older)).refund, { kind: "none", reason: "outside_window" });
  is("the read-only proof never writes Stripe", world.calls.some((call) => !call.startsWith("GET ")), false);

  part("The actual writer must refuse before any money moves");
  for (const path of ["/customers/search", "/charges/search"]) {
    const shop = await paidShop();
    answer = { path, data: [{}] };
    const made = await refundPlanPayment(await shop.store(), NOW);
    is("partial prior-person evidence cannot authorize the writer", made, { ok: false, reason: "unknown" });
    is("partial prior-person evidence makes no actual stand-in refund", shop.allRefunds().length, 0);
    answer = null;
  }
  done();
}
void main();
