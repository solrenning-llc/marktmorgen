/**
 * Sweep app1 proof (CX-123 rules 24 and 30), synthetic only, through app/api/store/currency/route.ts.
 *
 * Part 1. The store's currency is never changed while a series of calls runs (637 [GL5]; each series is charged in
 * the currency it was booked in). The route asks `runningSeries(store)` (route line ~41), which is
 * lib/call-series-open.ts:53-54:
 *   const [count] = await redisPipeline([["ZCOUNT", ...]]);
 *   return Number(count) || 0;
 * A ZCOUNT lost or in another shape is "none running", and the currency is changed under running series. Rule 30:
 * app/api/store/tax/route.ts asks the same function before switching tax on (outside this range).
 *
 * Part 2. The currency must be one the creator's Stripe account can charge (route lines ~25-29):
 *   const allowed = await chargeableCurrencies(store);
 *   if (allowed && !allowed.includes(wanted)) return ... "unsupported";
 * chargeableCurrencies (lib/payment-methods.ts:217-243) answers null when Stripe could not be asked, and the route
 * reads null as "any currency": the store is moved to a currency its account cannot charge, and the creator is told
 * it is saved. Stripe here is a stand-in for `fetch`; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStoreId, setProductCall, setStripeAccount, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import type { CallSetup } from "@/lib/call-setup";
import { markSeriesOpen, runningSeries } from "@/lib/call-series-open";
import { POST as currencyRoute } from "@/app/api/store/currency/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sweep_app1_currency";

const weekly = {
  kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [], [], [], [], []], noticeHours: 12, horizonDays: 30,
  bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;

let stripeDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if (stripeDown && path === "/account") return new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 503 });
  if (path === "/account") return new Response(JSON.stringify({ id: "acct_1TestSweepCur01", country: "US" }));
  if (path === "/country_specs/US") return new Response(JSON.stringify({ id: "US", supported_payment_currencies: ["usd", "cad"] }));
  if (path === "/subscriptions") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
let zcount: "real" | "lost" | "text" | "null" = "real";
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (zcount === "real" || !(commands.length === 1 && commands[0][0] === "ZCOUNT")) return real(commands);
  const replies = await real(commands);
  return zcount === "lost" ? [] : [zcount === "text" ? "QUEUED" : null, ...replies.slice(1)];
}) as typeof redis.pipeline;

async function shop(owner: string, handle: string) {
  await claimHandle(owner, handle, handle, "");
  await ensureStoreId(owner);
  const session = await openSession(owner);
  return async (body: Record<string, unknown>) => {
    const response = await currencyRoute(new NextRequest("https://marktmorgen.com/api/store/currency", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; running?: number } };
  };
}

async function main(): Promise<void> {
  redis.clear();
  part("1. Healthy control: a series running keeps the currency");
  const owner = "sweepseries@example.com";
  const post = await shop(owner, "sweepseries");
  const call = await addProduct(owner, "Coaching Call", "", "80", null);
  if (!call.ok) throw new Error("no product");
  await setProductCall(owner, call.product.id, weekly);
  const store = (await storeForEmail(owner))!;
  await markSeriesOpen({ ...store, callsId: store.callsId! }, "a".repeat(32), Date.now() + 21 * 86_400_000);
  is("one series running", await runningSeries(store), 1);
  const refused = await post({ currency: "eur", confirm: true });
  is("refused with the running series", [refused.status, refused.body.error, refused.body.running], [409, "series", 1]);

  for (const as of ["lost", "text", "null"] as const) {
    part(`1. DEFECT: the running-series count ${as}`);
    zcount = as;
    is(`DEFECT (${as}): none running`, await runningSeries(store), 0);
    const changed = await post({ currency: as === "lost" ? "eur" : as === "text" ? "gbp" : "usd", confirm: true });
    zcount = "real";
    is(`DEFECT (${as}): the currency is changed under the running series`, changed.body.ok, true);
  }
  is("the series is still running", await runningSeries(store), 1);

  part("2. Healthy control: a currency the Stripe account cannot charge is refused");
  const owner2 = "sweepcur@example.com";
  const post2 = await shop(owner2, "sweepcur");
  await setStripeAccount(owner2, "acct_1TestSweepCur01", true);
  const unsupported = await post2({ currency: "eur" });
  is("eur on an account that charges usd and cad: unsupported", [unsupported.status, unsupported.body.error], [400, "unsupported"]);
  is("the store stays in usd", (await storeForEmail(owner2))!.currency, "usd");

  part("2. DEFECT: Stripe's account read fails (the subscription count still answers: none running)");
  for (const key of redis.keys().filter((k: string) => k.includes("acct_1TestSweepCur01"))) await real([["DEL", key]]);
  stripeDown = true;
  const saved = await post2({ currency: "eur" });
  stripeDown = false;
  is("DEFECT: told it is saved", saved.body.ok, true);
  is("DEFECT: the store now prices in a currency its account cannot charge", (await storeForEmail(owner2))!.currency, "eur");
  done();
}
main();
