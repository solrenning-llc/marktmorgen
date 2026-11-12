/**
 * A plan switch whose answer from Stripe is lost or unreadable may already have
 * moved the subscription and charged for it. `switchPlan` (lib/billing.ts) must
 * then say "not confirmed" (SwitchUnconfirmedError), never fail like a refusal,
 * so the switch route never tells the creator "Nothing changed and nothing was
 * charged". A refusal Stripe states (a 4xx with its reason), or a failure before
 * the change is sent, stays an ordinary error: there, nothing changed.
 *
 * Synthetic only: Stripe is a stand-in, no network, no real subscription.
 */
import { BillingError, lookupKey, switchPlan } from "@/lib/billing";
import { PLAN_PRICES, parseTier } from "@/lib/plan";
import { done, is, part } from "./check";

type Answer = "ok" | "500" | "network" | "garbage" | "402" | "400";
/** What Stripe does with each request to change the price, in order; the last one repeats. */
let changeAnswers: Answer[] = ["ok"];
let readAnswer: "ok" | "500" | "network" = "ok";
let changesSent = 0;
let held: Record<string, unknown> = {};

const priceOf = (key: string) => `price_${key.replace(/[^a-z]/g, "")}`;
const start = () => ({
  id: "sub_Unconfirmed0001",
  status: "active",
  items: { data: [{ id: "si_Unconfirmed0001", price: { id: priceOf(lookupKey("pro", "month")), lookup_key: lookupKey("pro", "month"), unit_amount: PLAN_PRICES.pro.month, recurring: { interval: "month" } } }] },
  metadata: { tier: "pro" },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(String(init?.body ?? ""));
  const answer = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (path === "/prices" && method === "GET") {
    const key = url.searchParams.get("lookup_keys[]") ?? "";
    const [, tier, cycle] = /^nimbus_(\w+)_(month|year)$/.exec(key) ?? [];
    const plan = parseTier(tier);
    if (!plan) return answer({ data: [] });
    return answer({ data: [{ id: priceOf(key), unit_amount: PLAN_PRICES[plan][cycle as "month" | "year"], currency: "usd", lookup_key: key, recurring: { interval: cycle, interval_count: 1 } }] });
  }
  if (path.startsWith("/products/") && method === "GET") return answer({ active: true });
  if (path.startsWith("/subscriptions/") && method === "GET") {
    if (readAnswer === "network") throw new TypeError("TEST ONLY network down before any change");
    if (readAnswer === "500") return answer({ error: { type: "api_error", message: "TEST ONLY read failed" } }, 500);
    return answer(held);
  }
  if (path.startsWith("/subscriptions/") && method === "POST") {
    const price = body.get("items[0][price]");
    if (!price) return answer(held);
    const now = changeAnswers[Math.min(changesSent, changeAnswers.length - 1)];
    changesSent += 1;
    // Stripe applies the change in each of these: only the answer is lost or unreadable.
    if (now === "500" || now === "network" || now === "garbage") {
      held = { ...held, items: { data: [{ id: "si_Unconfirmed0001", price: { id: price, lookup_key: lookupKey("creator", "year"), unit_amount: PLAN_PRICES.creator.year, recurring: { interval: "year" } } }] } };
      if (now === "500") return answer({ error: { type: "api_error", message: "TEST ONLY reply failed after the change" } }, 500);
      if (now === "network") throw new TypeError("TEST ONLY connection reset after the request was sent");
      return new Response("<html>TEST ONLY not JSON</html>", { status: 200 });
    }
    // Stripe refuses and says why: nothing changed.
    if (now === "402") return answer({ error: { code: "card_declined", message: "TEST ONLY refused" } }, 402);
    if (now === "400") return answer({ error: { code: "resource_missing", message: "TEST ONLY no such price" } }, 400);
    held = { ...held, items: { data: [{ id: "si_Unconfirmed0001", price: { id: price, lookup_key: lookupKey("creator", "year"), unit_amount: PLAN_PRICES.creator.year, recurring: { interval: "year" } } }] } };
    return answer(held);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** What the switch ends in: the result's kind, or the name of what it threw. */
async function ending(changes: Answer[], read: typeof readAnswer = "ok"): Promise<string> {
  held = start();
  changeAnswers = changes;
  readAnswer = read;
  changesSent = 0;
  try {
    return (await switchPlan("sub_Unconfirmed0001", { tier: "creator", cycle: "year" })).kind;
  } catch (error) {
    if (error instanceof BillingError) return `BillingError ${error.status}`;
    return error instanceof Error ? error.name : "not an Error";
  }
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_unconfirmed_only_a_stand_in";

  part("Control: Stripe confirms the switch");
  is("switched", await ending(["ok"]), "switched");
  is("one change sent", changesSent, 1);

  part("The change was sent and its answer is lost or unreadable");
  for (const lost of ["500", "network", "garbage"] as const) {
    is(`not confirmed, never a plain failure (${lost})`, await ending([lost]), "SwitchUnconfirmedError");
    is(`the change was sent once (${lost})`, changesSent, 1);
  }
  is("after a refused stale price, a lost answer to the retry is not confirmed either", await ending(["400", "500"]), "SwitchUnconfirmedError");
  is("both changes were sent", changesSent, 2);

  part("Stripe refuses and says why: nothing changed");
  is("a stated refusal stays Stripe's refusal", await ending(["402"]), "BillingError 402");
  is("a refusal of the retry too", await ending(["400", "400"]), "BillingError 400");

  part("A failure before the change is sent: nothing changed");
  is("the read fails at Stripe", await ending(["ok"], "500"), "BillingError 500");
  is("no change sent after a failed read", changesSent, 0);
  is("the network fails on the read", await ending(["ok"], "network"), "TypeError");
  is("no change sent when the read never arrived", changesSent, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
