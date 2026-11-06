/**
 * Opt-in evidence only for the closing-plan worker. The product file is
 * occupied by #1969 and is deliberately not changed here.
 */
import { settleOne, UNDO_KEY } from "@/lib/closing-plan-guard";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const unknown = "sub_c2unknown01";
const control = "sub_c2control01";
const since = Date.UTC(2026, 10, 5);
let refunds = 0;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "DELETE" && path === `/subscriptions/${unknown}`) {
    return json({ id: unknown, status: "canceled", created: Math.floor(since / 1000) + 60 });
  }
  if (method === "DELETE" && path === `/subscriptions/${control}`) {
    return json({ id: control, status: "canceled", created: Math.floor(since / 1000) + 60 });
  }
  if (method === "GET" && path === "/invoices" && url.searchParams.get("subscription") === unknown) {
    // The list envelope is present, but its required data field is absent.
    return json({ object: "list", has_more: false });
  }
  if (method === "GET" && path === "/invoices" && url.searchParams.get("subscription") === control) {
    return json({
      object: "list",
      data: [{
        id: "in_c2control01",
        status: "paid",
        amount_paid: 6_900,
        payment_intent: "pi_c2control01",
        created: Math.floor(since / 1000) + 120,
        status_transitions: { paid_at: Math.floor(since / 1000) + 120 },
      }],
      has_more: false,
    });
  }
  if (method === "GET" && path === "/payment_intents/pi_c2control01") {
    return json({
      id: "pi_c2control01",
      latest_charge: {
        id: "ch_c2control01",
        amount: 6_900,
        amount_refunded: 0,
        currency: "usd",
        disputed: false,
      },
    });
  }
  if (method === "GET" && path === "/refunds") {
    return json({ object: "list", data: [], has_more: false });
  }
  if (method === "POST" && path === "/refunds") {
    refunds += 1;
    return json({ id: "re_c2control01", status: "succeeded", amount: 6_900, currency: "usd" });
  }
  return json({ error: { message: `missing synthetic route: ${method} ${path}` } }, 404);
}) as typeof fetch;

const queued = () => JSON.stringify({
  h: "synthetic-store",
  c: "cus_c2synthetic01",
  to: "",
  name: "",
  since,
  ended: since - 86_400_000,
  at: since,
  n: 0,
  t: 1,
});

async function state(id: string): Promise<{ done?: number; n?: number } | null> {
  const [raw] = await redisPipeline([["HGET", UNDO_KEY, id]]);
  return typeof raw === "string" ? JSON.parse(raw) : null;
}

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_c2_closing_plan_unknown";
  await redisPipeline([
    ["HSET", UNDO_KEY, unknown, queued()],
    ["HSET", UNDO_KEY, control, queued()],
  ]);

  part("an unreadable invoice page is unknown, never an empty settled account");
  const unknownResult = await settleOne(unknown);
  const unknownState = await state(unknown);
  is(
    "missing invoice data stays in the retry queue and is not marked done",
    [unknownResult, Boolean(unknownState?.done), unknownState?.n, refunds],
    [false, false, 1, 0],
  );

  part("an exact paid invoice is refunded and then may be marked done");
  const controlResult = await settleOne(control);
  const controlState = await state(control);
  is(
    "the exact control refunds once and settles",
    [controlResult, Boolean(controlState?.done), refunds],
    [true, true, 1],
  );
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
