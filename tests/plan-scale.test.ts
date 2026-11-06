/**
 * The plan above Pro: what it gives, how a subscription on it is read, and
 * that moving up to it asks Stripe for the right price.
 *
 * Why it exists (lib/plan.ts): the store this one was first measured against
 * sold a flat $29 and $99 with nothing to move up to, so a creator who grew
 * paid the same forever, and a list that outgrew its month could only wait.
 * Scale has its own explicit email and storage allowances, and nothing taken from Pro to
 * make it look better — which is the first thing checked here.
 */
import { AI_MONTHLY } from "@/lib/ai-rules";
import { aiAllowance } from "@/lib/ai";
import { ensurePrice, lookupKey, planOf, switchPlan } from "@/lib/billing";
import { canUseDomain } from "@/lib/domains";
import { monthlyAllowance } from "@/lib/mail";
import { PLAN_NAMES, PLAN_PRICES, PRO_MONTHLY_EMAILS, SCALE_MONTHLY_EMAILS, TIERS, TRIAL_MONTHLY_EMAILS, canUse, hasPro, monthlyEmails, parseTier, priceWords, yearSaving } from "@/lib/plan";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

type Sent = { method: string; path: string; body: URLSearchParams };
const sent: Sent[] = [];
/** The subscription as Stripe holds it, changed by the stand-in when a new price is posted. */
let held: Record<string, unknown> = {};
let catalogIntervalCount = 1;
let madePriceMode: "ok" | "partial" | "wrong" = "ok";

const priceOf = (key: string) => `price_${key.replace(/[^a-z]/g, "")}`;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(String(init?.body ?? ""));
  sent.push({ method, path, body });
  const answer = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (path === "/prices" && method === "GET") {
    // Every plan's price already exists at Stripe, under the name it is found by.
    const key = url.searchParams.get("lookup_keys[]") ?? "";
    const [, tier, cycle] = /^nimbus_(\w+)_(month|year)$/.exec(key) ?? [];
    const plan = parseTier(tier);
    if (!plan) return answer({ data: [] });
    return answer({ data: [{ id: priceOf(key), unit_amount: PLAN_PRICES[plan][cycle as "month" | "year"], currency: "usd", lookup_key: key, recurring: { interval: cycle, interval_count: catalogIntervalCount } }] });
  }
  if (path.startsWith("/products/") && method === "GET") return answer({ active: true });
  if (path === "/prices" && method === "POST") {
    const id = priceOf(body.get("lookup_key") ?? "") + "_new";
    if (madePriceMode === "partial") return answer({ id });
    return answer({
      id, unit_amount: Number(body.get("unit_amount")) + (madePriceMode === "wrong" ? 1 : 0),
      currency: body.get("currency"),
      recurring: { interval: body.get("recurring[interval]"), interval_count: Number(body.get("recurring[interval_count]")) },
    });
  }
  if (path.startsWith("/subscriptions/") && method === "GET") return answer(held);
  if (path.startsWith("/subscriptions/") && method === "POST") {
    const price = body.get("items[0][price]");
    if (price) {
      const key = ["creator", "pro", "scale"].flatMap((t) => ["month", "year"].map((c) => `nimbus_${t}_${c}`)).find((k) => priceOf(k) === price) ?? "";
      const [, tier, cycle] = /^nimbus_(\w+)_(month|year)$/.exec(key) ?? [];
      const plan = parseTier(tier) ?? "creator";
      held = { ...held, items: { data: [{ id: "si_Item00000001", price: { id: price, lookup_key: key, unit_amount: PLAN_PRICES[plan][cycle as "month" | "year"], recurring: { interval: cycle } } }] } };
    }
    return answer(held);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const subscription = (price: Record<string, unknown>, metadata: Record<string, string> = {}) => ({ items: { data: [{ price }] }, metadata });
const store = (over: Partial<Store>) => ({ subscriptionActive: true, tier: "creator", trialEnds: 0, mail: null, listId: null, ...over }) as unknown as Store;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_scale_only_a_stand_in";

  part("What it is");
  is("three plans, the least first", TIERS, ["creator", "pro", "scale"]);
  is("the price, monthly and yearly", [priceWords("scale", "month"), priceWords("scale", "year"), yearSaving("scale") / 100], ["$999 a month", "$9,990 a year", 1998]);
  is("what a receipt calls it", PLAN_NAMES.scale, "Marktmorgen Scale");
  is("it is read as a plan", [parseTier("scale"), parseTier("enterprise")], ["scale", null]);
  is("it has everything Pro switches on", [hasPro("creator"), hasPro("pro"), hasPro("scale")], [false, true, true]);
  is("email, the domain and the rest are on for it", [canUse(store({ tier: "scale" }), "email"), canUseDomain(store({ tier: "scale" })), canUse(store({ tier: "scale", subscriptionActive: false }), "email")], [true, true, false]);

  part("What it gives");
  is("Scale has the larger explicit email allowance", [monthlyEmails("pro"), monthlyEmails("scale"), SCALE_MONTHLY_EMAILS / PRO_MONTHLY_EMAILS], [7_000, 10_000, 10 / 7]);
  is("a store on it may send that many", monthlyAllowance(store({ tier: "scale" })), SCALE_MONTHLY_EMAILS);
  is("Pro is left exactly as it was", [monthlyAllowance(store({ tier: "pro" })), aiAllowance(store({ tier: "pro" }))], [PRO_MONTHLY_EMAILS, AI_MONTHLY.pro]);
  is("and the plan under it still sends none", monthlyAllowance(store({ tier: "creator" })), 0);
  is("a trial on it is a trial: the small allowance, so it cannot be used to spam", monthlyAllowance(store({ tier: "scale", trialEnds: Math.floor(Date.now() / 1000) + 86_400 })), TRIAL_MONTHLY_EMAILS);
  is("more AI drafts than Pro", [aiAllowance(store({ tier: "scale" })), AI_MONTHLY.scale > AI_MONTHLY.pro], [AI_MONTHLY.scale, true]);

  part("Reading a subscription");
  const named = (tier: string, cycle: string) => planOf(subscription({ lookup_key: `nimbus_${tier}_${cycle}`, unit_amount: 1, recurring: { interval: cycle } }));
  is("by the name of its price", [named("scale", "month").tier, named("scale", "year").cycle, named("pro", "month").tier], ["scale", "year", "pro"]);
  const priced = (cents: number, interval: string, meta: Record<string, string> = {}) => planOf(subscription({ unit_amount: cents, recurring: { interval } }, meta)).tier;
  is("an unnamed price, by what it charges a month", [priced(2900, "month"), priced(9900, "month"), priced(24900, "month")], ["creator", "pro", "scale"]);
  is("and a year", [priced(30000, "year"), priced(94800, "year"), priced(238800, "year")], ["creator", "pro", "scale"]);
  is("a yearly Pro is not taken for Scale because its number is large", priced(94800, "year"), "pro");
  is("the note on the subscription is believed too", [priced(0, "month", { tier: "scale" }), priced(0, "month", { tier: "pro" })], ["scale", "pro"]);

  part("Catalog evidence is validated before a price can be used");
  catalogIntervalCount = 2;
  sent.length = 0;
  const replacement = await ensurePrice("creator", "year");
  const made = sent.find((row) => row.path === "/prices" && row.method === "POST");
  is("a doubled interval is replaced rather than reused", replacement, priceOf(lookupKey("creator", "year")) + "_new");
  is("the replacement explicitly requests one unchanged annual interval", [made?.body.get("unit_amount"), made?.body.get("recurring[interval]"), made?.body.get("recurring[interval_count]")], [String(PLAN_PRICES.creator.year), "year", "1"]);
  const cachedCount = sent.length;
  await ensurePrice("creator", "year");
  is("the validated replacement is cached without another request", sent.length, cachedCount);

  for (const mode of ["partial", "wrong"] as const) {
    madePriceMode = mode;
    sent.length = 0;
    let refused = false;
    try { await ensurePrice("pro", "year"); } catch { refused = true; }
    is(`${mode}: a bare or contradictory new price is refused`, refused, true);
    is(`${mode}: unconfirmed output was not cached from the prior attempt`, sent.some((row) => row.path === "/prices" && row.method === "POST"), true);
  }
  madePriceMode = "ok";
  is("a later fully confirmed price can recover", await ensurePrice("pro", "year"), priceOf(lookupKey("pro", "year")) + "_new");

  catalogIntervalCount = 1;
  sent.length = 0;
  is("a valid existing one-interval price is reused", await ensurePrice("scale", "year"), priceOf(lookupKey("scale", "year")));
  is("no replacement is created for valid catalog evidence", sent.some((row) => row.method === "POST"), false);
  const validCount = sent.length;
  await ensurePrice("scale", "year");
  is("the validated existing price is also cached", sent.length, validCount);

  part("Moving up from Pro");
  held = { id: "sub_Owner00000001", status: "active", cancel_at: null, cancel_at_period_end: false, items: { data: [{ id: "si_Item00000001", price: { lookup_key: lookupKey("pro", "month"), unit_amount: PLAN_PRICES.pro.month, recurring: { interval: "month" } } }] }, metadata: { tier: "pro" } };
  sent.length = 0;
  const moved = await switchPlan("sub_Owner00000001", { tier: "scale", cycle: "month" });
  const change = sent.find((s) => s.method === "POST" && s.body.has("items[0][price]"));
  is("Stripe is asked for Scale's own price", change?.body.get("items[0][price]"), priceOf(lookupKey("scale", "month")));
  is("charged now for the difference, and nothing changes if the bank refuses", [change?.body.get("proration_behavior"), change?.body.get("payment_behavior")], ["always_invoice", "pending_if_incomplete"]);
  is("the store is then on Scale", moved.kind === "switched" && moved.state.state === "active" ? [moved.state.tier, moved.state.cycle] : moved.kind, ["scale", "month"]);
  is("and the note on the subscription says so", sent.some((s) => s.method === "POST" && s.body.get("metadata[tier]") === "scale"), true);

  sent.length = 0;
  const again = await switchPlan("sub_Owner00000001", { tier: "scale", cycle: "month" });
  is("asked for the plan it is already on, nothing is changed", [again.kind, sent.some((s) => s.method === "POST")], ["same", false]);

  const back = await switchPlan("sub_Owner00000001", { tier: "pro", cycle: "month" });
  is("and back to Pro whenever they like", back.kind === "switched" && back.state.state === "active" ? back.state.tier : back.kind, "pro");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
