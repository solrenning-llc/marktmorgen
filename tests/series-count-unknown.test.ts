/**
 * The count of a store's running call series is read only in its exact shape (sweep APP3, CX-123 rules 24 and 30;
 * proof on claude5/sweep-app-3, tests/sweep-app3-series.proof.test.ts). runningSeries (lib/call-series-open.ts) read
 * its ZCOUNT with `Number(count) || 0`, so a reply in another shape counted as "no series running", and the two
 * guards that stand on it let through what they exist to refuse:
 *   - app/api/store/tax/route.ts: sales tax switched on while a series runs (its later sessions are charged with no
 *     Checkout for Stripe Tax to add the tax to);
 *   - app/api/store/currency/route.ts: the store's currency changed while a series booked in the old one runs.
 * Now an unknown reply throws UnknownReplyError and both routes answer 503 "unavailable", with nothing changed.
 * Synthetic only: the in-memory Redis double; a stand-in for Stripe's GET /v1/tax/settings answers "active".
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStoreId, setProductCall, setStripeAccount, storeForEmail } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import { markSeriesOpen, runningSeries, seriesOpenKey } from "@/lib/call-series-open";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as currencyRoute } from "@/app/api/store/currency/route";
import { POST as taxRoute } from "@/app/api/store/tax/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.STRIPE_SECRET_KEY = "sk_test_series_count_unknown";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/tax/settings") return Response.json({ object: "tax.settings", status: "active" });
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/subscriptions") return Response.json({ object: "list", data: [], has_more: false });
  // The account's currencies, so the currency route reaches the series check (an unknown list is refused first).
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/account") return Response.json({ id: "acct_1SerCountUnk1", country: "US" });
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/country_specs/US") return Response.json({ id: "US", supported_payment_currencies: ["usd", "eur"] });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const weekly = {
  kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [], [], [], [], []], noticeHours: 12,
  horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;

const original = redis.pipeline.bind(redis);
/** Every pipeline holding this diary's ZCOUNT answers `bend(replies)` while `work` runs; everything else is real. */
async function withBent<T>(key: string, bend: (replies: unknown[]) => unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original(commands);
    return commands.some((c) => c[0] === "ZCOUNT" && c[1] === key) ? bend(replies) : replies;
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}
const countAs = (reply: unknown) => (replies: unknown[]) => replies.map(() => reply);

async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    return `answered ${JSON.stringify(await work())}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `threw ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "series.count@example.com";
  await claimHandle(owner, "seriescount", "Series Count Shop", "");
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
  const state = async () => {
    const now = (await storeForEmail(owner))!;
    return [now.currency, now.tax.enabled];
  };

  part("Known replies are read as before");
  is("no series: none running", await runningSeries(store), 0);
  is("a store with no call diary has none, without asking Redis", await runningSeries({ callsId: null }), 0);
  await markSeriesOpen(diary, "a".repeat(32), Date.now() + 21 * 86_400_000);
  is("one series booked: one running", await runningSeries(store), 1);

  part("A count in another shape is unknown, never zero");
  const shapes: [string, (replies: unknown[]) => unknown][] = [
    ["no reply", countAs(undefined)],
    ["null", countAs(null)],
    ["text", countAs("QUEUED")],
    ["a number as text", countAs("1")],
    ["an object", countAs({ n: 1 })],
    ["a fraction", countAs(0.5)],
    ["a negative count", countAs(-1)],
    ["not a number", countAs(Number.NaN)],
    ["no replies at all", () => []],
    ["two replies for one command", (replies) => [...replies, 0]],
    ["not a list", () => ({ 0: 0, length: 1 })],
  ];
  for (const [label, bend] of shapes) {
    is(`${label}: runningSeries throws UnknownReplyError`, await thrown(() => withBent(key, bend, () => runningSeries(store))), "UnknownReplyError");
  }
  is("the series is still in the diary", (await original([["ZCARD", key]]))[0], 1);

  part("The currency route refuses, with nothing changed");
  for (const [label, bend] of shapes.slice(0, 3)) {
    is(`${label}: 503 unavailable`, await withBent(key, bend, () => send(currencyRoute, "currency", { currency: "eur", confirm: true })), [503, "unavailable"]);
  }
  is("the store still charges in dollars", await state(), ["usd", false]);

  part("The tax route refuses, with nothing changed");
  await setStripeAccount(owner, "acct_1SerCountUnk1", true);
  for (const [label, bend] of shapes.slice(0, 3)) {
    is(`${label}: 503 unavailable`, await withBent(key, bend, () => send(taxRoute, "tax", taxOn)), [503, "unavailable"]);
  }
  is("sales tax is still off", await state(), ["usd", false]);

  part("Healthy control: the running series still refuses both with \"series\"");
  is("currency refused", await send(currencyRoute, "currency", { currency: "eur", confirm: true }), [409, "series"]);
  is("tax refused", await send(taxRoute, "tax", taxOn), [409, "series"]);
  is("nothing changed", await state(), ["usd", false]);

  part("The studio says it honestly");
  const taxEditor = readFileSync("components/tax-editor.tsx", "utf8");
  is("the tax editor no longer says stores are not switched on for an unread answer", taxEditor.includes("Stores are not switched on yet"), false);
  is("the tax editor says nothing was saved and to try again", /unavailable: "[^"]*nothing was saved[^"]*Try again/.test(taxEditor), true);
  const panel = readFileSync("components/payments-panel.tsx", "utf8");
  is("the currency panel says nothing was changed and to try again", /unavailable: "[^"]*Nothing was changed[^"]*try again/i.test(panel), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
