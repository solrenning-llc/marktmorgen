/**
 * Sweep APP3 proof (CX-123 rules 24 and 30), synthetic only. lib/call-series-open.ts:51-55 runningSeries:
 *   const [count] = await redisPipeline([["ZCOUNT", seriesOpenKey(store.callsId), `(${now}`, "+inf"]]);
 *   return Number(count) || 0;
 * A ZCOUNT that answers in another shape (no reply, text, an object) reads as "no series running". Two guards stand
 * on it (C2-94):
 *   - app/api/store/tax/route.ts:31-33: sales tax is not switched on while a series runs, because a series' later
 *     sessions are charged off-session with no Checkout for Stripe Tax to work the tax out (lib/call-series-billing.ts,
 *     seriesBillingProblem "tax"): the tax promised on top would go uncollected or the charge would be refused.
 *   - app/api/store/currency/route.ts:67-68 (rule 30 sibling, outside the p–z range): the store's currency is not
 *     changed while a series runs, so its pages never state the booked sessions in another currency.
 * Unknown → tax switched on / currency changed with a series running.
 * Nothing real is called: the in-memory Redis double; a stand-in for Stripe's GET /v1/tax/settings answers "active".
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStoreId, setProductCall, setStripeAccount, storeForEmail } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import { markSeriesOpen, runningSeries, seriesOpenKey } from "@/lib/call-series-open";
import { POST as currencyRoute } from "@/app/api/store/currency/route";
import { POST as taxRoute } from "@/app/api/store/tax/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.STRIPE_SECRET_KEY = "sk_test_sweepapp3_series";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/tax/settings") return Response.json({ object: "tax.settings", status: "active" });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const weekly = {
  kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [], [], [], [], []], noticeHours: 12,
  horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;

const original = redis.pipeline.bind(redis);
/** Every ZCOUNT of this diary's running series answers `reply` while `work` runs; everything else is real. */
async function withBentZcount<T>(key: string, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original(commands);
    return replies.map((r, i) => (commands[i][0] === "ZCOUNT" && commands[i][1] === key ? reply : r));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "series.app3@example.com";
  await claimHandle(owner, "seriesapp3", "Series Shop", "");
  await ensureStoreId(owner);
  const call = await addProduct(owner, "Coaching Call", "", "80", null);
  if (!call.ok) throw new Error("no product");
  await setProductCall(owner, call.product.id, weekly);
  const store = (await storeForEmail(owner))!;
  const diary = { ...store, callsId: store.callsId! };
  const key = seriesOpenKey(diary.callsId);
  const session = await openSession(owner);
  const send = async (route: typeof taxRoute, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    const read = (await response.json()) as { error?: string };
    return [response.status, read.error ?? "ok"];
  };
  const taxOn = { enabled: true, included: false, ids: false, invoices: false };
  await markSeriesOpen(diary, "a".repeat(32), Date.now() + 21 * 86_400_000);

  part("Healthy control: one series runs");
  is("runningSeries counts it", await runningSeries(store), 1);
  is("changing the currency is refused", await send(currencyRoute, "currency", { currency: "eur", confirm: true }), [409, "series"]);
  is("switching sales tax on is refused", await send(taxRoute, "tax", taxOn), [409, "series"]);
  is("currency and tax unchanged", [(await storeForEmail(owner))!.currency, (await storeForEmail(owner))!.tax.enabled], ["usd", false]);

  for (const [label, reply] of [["no reply", undefined], ["text", "QUEUED"], ["an object", { n: 1 }]] as const) {
    part(`DEFECT (${label}): the ZCOUNT of the running series answers in another shape`);
    is(`DEFECT (${label}): read as no series running`, await withBentZcount(key, reply, () => runningSeries(store)), 0);
    is(`DEFECT (${label}): while the series is still in the diary`, (await original([["ZCARD", key]]))[0], 1);
  }

  part("DEFECT: through the routes, with the series still running");
  // The route's last step, next/server `after` (the notice to the creator), is outside a request scope here and
  // answers 500 after the change is written; what matters is that the series guard let it through.
  const changed = await withBentZcount(key, undefined, () => send(currencyRoute, "currency", { currency: "eur", confirm: true }));
  is("DEFECT: the currency route is not stopped by the series guard", changed[1] !== "series", true);
  is("DEFECT: the store now states its prices in euros while the series booked in dollars runs", (await storeForEmail(owner))!.currency, "eur");
  await setStripeAccount(owner, "acct_sweepapp3series", true);
  is("DEFECT: sales tax is switched on", await withBentZcount(key, "QUEUED", () => send(taxRoute, "tax", taxOn)), [200, "ok"]);
  is("DEFECT: and is on, with the series running", [(await storeForEmail(owner))!.tax.enabled, await runningSeries(store)], [true, 1]);
  done();
}

main();
