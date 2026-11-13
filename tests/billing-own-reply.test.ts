/**
 * CX-123 rule 30 for the platform's own plan (lib/billing.ts): a Stripe reply decides only for the object it was asked
 * about. The funded paths already check it; the paths without funding did not:
 *
 *   - readStartedSubscription, the checkout's way back: the session read is not checked to be the session asked
 *     about, and the subscription read is not checked to be the session's own subscription and customer. A reply
 *     carrying another subscription (another creator's Scale yearly, say) was adopted as this store's plan, so the
 *     return route would write that plan, and its allowances, on a store that never paid for it.
 *   - switchPlan: the subscription read before the change and the one Stripe answers the change with are not checked
 *     to be the asked subscription, so another subscription's state answered "same" (nothing changed) or "switched"
 *     with that other plan, which the switch route writes on the store.
 *
 * Checked: each reply that names another object adopts nothing, sends no change and writes nothing; healthy own
 * replies read exactly as before (controls). Stripe is a stand-in; synthetic data only.
 */
import { lookupKey, readStartedSubscription, switchPlan } from "@/lib/billing";
import { PLAN_PRICES, parseTier } from "@/lib/plan";
import { claimHandle, storeForEmail } from "@/lib/store";
import "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_billing_own_reply_only";
delete process.env.STRIPE_CONNECT_API_BASE;

const SUB = "sub_AskedPlan00001";
const OTHER = "sub_OtherPlan00001";
const CUSTOMER = "cus_AskedCust001";
const SESSION = "cs_test_AskedSession00001";
const OWNER = "own-reply@example.com";
const HANDLE = "ownreply";
const NOW = Math.floor(Date.now() / 1000);

const priceOf = (key: string) => `price_${key.replace(/[^a-z]/g, "")}`;
/** A healthy subscription reply on the given plan, as Stripe sends one. */
function sub(id: string, customer: string, tier: "creator" | "pro" | "scale", cycle: "month" | "year"): Record<string, unknown> {
  const key = lookupKey(tier, cycle);
  return {
    id, object: "subscription", status: "active", customer, created: NOW - 86_400,
    metadata: { store: HANDLE, tier }, cancel_at: null, cancel_at_period_end: false, pending_update: null,
    items: { object: "list", has_more: false, data: [{
      id: `si_${id.slice(4)}`, quantity: 1, current_period_start: NOW - 86_400, current_period_end: NOW + (cycle === "year" ? 364 : 29) * 86_400,
      price: { id: priceOf(key), currency: "usd", unit_amount: PLAN_PRICES[tier][cycle], lookup_key: key, recurring: { interval: cycle, interval_count: 1 } },
    }] },
  };
}

let sessionReply: Record<string, unknown> = {};
let readReply: Record<string, unknown> = {};
let changeReply: (() => Record<string, unknown>) | null = null;
let changes = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(String(init?.body ?? ""));
  const answer = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (path === `/checkout/sessions/${SESSION}`) return answer(sessionReply);
  if (path === "/prices" && method === "GET") {
    const key = url.searchParams.get("lookup_keys[]") ?? "";
    const [, tier, cycle] = /^nimbus_(\w+)_(month|year)$/.exec(key) ?? [];
    const plan = parseTier(tier);
    if (!plan) return answer({ data: [] });
    return answer({ data: [{ id: priceOf(key), unit_amount: PLAN_PRICES[plan][cycle as "month" | "year"], currency: "usd", lookup_key: key, recurring: { interval: cycle, interval_count: 1 } }] });
  }
  if (path.startsWith("/products/") && method === "GET") return answer({ active: true });
  if (path === `/subscriptions/${SUB}` && method === "GET") return answer(readReply);
  if (path === `/subscriptions/${SUB}` && method === "POST") {
    if (!body.get("items[0][price]")) return answer(readReply);
    changes += 1;
    return answer(changeReply ? changeReply() : readReply);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** What the way back from a checkout gives: the plan adopted, null, or the name of what it threw. */
async function started(store: Parameters<typeof readStartedSubscription>[0]): Promise<string> {
  try {
    const read = await readStartedSubscription(store, SESSION);
    return read ? `${read.subscriptionId} ${read.active ? `${read.tier}/${read.cycle}` : "inactive"}` : "null";
  } catch (error) {
    return error instanceof Error ? "threw" : "threw something";
  }
}

/** What a switch to Store monthly ends in: the result's kind (and plan), or the name of what it threw. */
async function switched(): Promise<string> {
  changes = 0;
  try {
    const result = await switchPlan(SUB, { tier: "creator", cycle: "month" });
    return result.kind === "switched" && result.state.state === "active" ? `switched ${result.state.tier}/${result.state.cycle}` : result.kind;
  } catch (error) {
    return error instanceof Error ? error.name : "not an Error";
  }
}

async function main(): Promise<void> {
  await claimHandle(OWNER, HANDLE, "Own Reply", "Synthetic.");
  const store = (await storeForEmail(OWNER))!;
  const session = (over: Record<string, unknown> = {}) => ({ id: SESSION, object: "checkout.session", mode: "subscription", metadata: { store: HANDLE }, customer: CUSTOMER, subscription: SUB, ...over });

  part("The checkout's way back: controls");
  sessionReply = session();
  readReply = sub(SUB, CUSTOMER, "pro", "month");
  is("the session's own subscription is adopted, as before", await started(store), `${SUB} pro/month`);

  part("The checkout's way back: a reply about another object adopts nothing");
  readReply = sub(OTHER, "cus_SomeoneElse1", "scale", "year");
  const another = await started(store);
  is("another subscription's reply (another creator's Scale yearly) is never adopted", another === "null" || another === "threw", true);
  readReply = sub(SUB, "cus_SomeoneElse1", "scale", "year");
  const foreign = await started(store);
  is("the asked subscription answered as another customer's is never adopted", foreign === "null" || foreign === "threw", true);
  readReply = sub(SUB, CUSTOMER, "pro", "month");
  sessionReply = session({ id: "cs_test_OtherSession00001" });
  const otherSession = await started(store);
  is("a session reply that is another session's is never believed", otherSession === "null" || otherSession === "threw", true);
  sessionReply = session();

  part("A plan switch: controls");
  readReply = sub(SUB, CUSTOMER, "pro", "month");
  changeReply = () => sub(SUB, CUSTOMER, "creator", "month");
  is("Pro monthly to Store monthly: switched, one change sent", [await switched(), changes], ["switched creator/month", 1]);
  readReply = sub(SUB, CUSTOMER, "creator", "month");
  is("already on Store monthly: the same, nothing sent", [await switched(), changes], ["same", 0]);

  part("A plan switch: a reply about another subscription decides nothing");
  readReply = sub(OTHER, "cus_SomeoneElse1", "creator", "month");
  const read = await switched();
  is("the read answered with another subscription on Store monthly: never 'same', nothing sent", [read === "same", changes], [false, 0]);
  readReply = sub(SUB, CUSTOMER, "pro", "month");
  changeReply = () => sub(OTHER, "cus_SomeoneElse1", "creator", "month");
  is("the change answered with another subscription: not confirmed, never 'switched'", await switched(), "SwitchUnconfirmedError");
  changeReply = null;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
