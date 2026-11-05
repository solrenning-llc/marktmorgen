/**
 * 630 [HN6](19) unit 2: discount codes through the API, read, made and
 * switched off on the creator's own Stripe account exactly as in the studio,
 * with the same reading of what is asked (lib/discount-input.ts). A
 * synthetic Stripe in memory; nothing leaves this machine.
 */
import { GET, POST, DELETE } from "@/app/api/v1/codes/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { CODE_PROBLEMS } from "@/lib/discount";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "api-codes@example.com";
const ACCOUNT = "acct_ApiCodesTest01";
process.env.STRIPE_SECRET_KEY = "sk_test_api_codes_stand_in";

type Promo = Record<string, unknown>;
const coupons = new Map<string, Record<string, unknown>>();
const promos = new Map<string, Promo>();
const writes: string[] = [];
let n = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || new Headers(init?.headers).get("Stripe-Account") !== ACCOUNT) throw new Error(`unexpected ${url}`);
  const form = new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");
  if (init?.method === "GET" && url.pathname === "/v1/promotion_codes") {
    return Response.json({ object: "list", has_more: false, data: [...promos.values()].map((p) => ({ ...p, promotion: { type: "coupon", coupon: coupons.get(String((p.promotion as { coupon: string }).coupon)) } })) });
  }
  if (init?.method === "POST" && url.pathname === "/v1/coupons") {
    writes.push("coupon");
    const id = `co_${++n}`;
    const coupon = { id, object: "coupon", percent_off: form.get("percent_off") ? Number(form.get("percent_off")) : null, amount_off: form.get("amount_off") ? Number(form.get("amount_off")) : null, currency: form.get("currency"), duration: form.get("duration") ?? "once" };
    coupons.set(id, coupon);
    return Response.json(coupon);
  }
  if (init?.method === "POST" && url.pathname === "/v1/promotion_codes") {
    writes.push("promotion");
    const code = form.get("code") ?? "";
    if ([...promos.values()].some((p) => p.code === code && p.active)) return Response.json({ error: { type: "invalid_request_error", message: "A promotion code with this code already exists." } }, { status: 400 });
    const id = `promo_${++n}`;
    const row: Promo = { id, object: "promotion_code", code, active: true, times_redeemed: 0, max_redemptions: form.get("max_redemptions") ? Number(form.get("max_redemptions")) : null, expires_at: null, restrictions: { minimum_amount: form.get("restrictions[minimum_amount]") ? Number(form.get("restrictions[minimum_amount]")) : null, minimum_amount_currency: form.get("restrictions[minimum_amount_currency]"), first_time_transaction: false }, promotion: { type: "coupon", coupon: form.get("promotion[coupon]") } };
    promos.set(id, row);
    return Response.json(row);
  }
  const stop = url.pathname.match(/^\/v1\/promotion_codes\/(promo_\w+)$/);
  if (init?.method === "POST" && stop) {
    writes.push(`stop ${stop[1]}`);
    const row = promos.get(stop[1]);
    if (!row) return Response.json({ error: { message: "No such promotion code" } }, { status: 404 });
    row.active = false;
    return Response.json(row);
  }
  throw new Error(`unexpected ${init?.method} ${url}`);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "api-codes-shop", "API Codes Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ApiCodes1", subscriptionId: "sub_ApiCodes1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const reader = await makeKey(store.sid, "Synthetic reader");
  const writer = await makeKey(store.sid, "Synthetic writer", Date.now(), true);
  if (!reader.ok || !writer.ok) throw new Error("no synthetic keys");
  const auth = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
  const list = async () => { const r = await GET(new Request("https://marktmorgen.com/api/v1/codes", { headers: auth(reader.key) })); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  const make = async (body: unknown, key = writer.key) => { const r = await POST(new Request("https://marktmorgen.com/api/v1/codes", { method: "POST", headers: auth(key), body: JSON.stringify(body) })); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  const stop = async (id: string, key = writer.key) => { const r = await DELETE(new Request(`https://marktmorgen.com/api/v1/codes?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(key) })); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };

  part("Only while the store takes payments, as in the studio");
  is("no Stripe account: every way refused, Stripe not asked", [(await list()).status, (await make({ code: "LAUNCH20", percent: "20" })).status, (await stop("promo_1")).status, writes.length], [409, 409, 409, 0]);
  await setStripeAccount(OWNER, ACCOUNT, true);

  part("Making a code");
  is("a key that reads only cannot make one", [(await make({ code: "LAUNCH20", percent: 20 }, reader.key)).status, writes.length], [403, 0]);
  const bad = await Promise.all([make({ code: "x", percent: 20 }), make({ code: "LAUNCH20", percent: 0 }), make({ code: "LAUNCH20", kind: "amount", amount: "0" }), make({ code: "LAUNCH20", percent: 20, uses: "1.5" }), make({ code: "LAUNCH20", percent: 20, minimum: "-3" })]);
  is("each refusal says what to fix, in the studio's words", bad.map((r) => [r.status, r.body.error]), [[400, "shape"], [400, "percent"], [400, "amount"], [400, "uses"], [400, "minimum"]]);
  is("the words are the studio's", bad[0].body.message, CODE_PROBLEMS.shape);
  is("nothing reached Stripe for a refused code", writes.length, 0);
  const made = await make({ code: "launch20", percent: 20, uses: "50", minimum: "30" });
  is("made, as the studio makes it: a coupon, then the code", [made.status, writes], [200, ["coupon", "promotion"]]);
  const data = made.body.data as Record<string, unknown>;
  is("the code as the API gives it out", [data.code, data.off, data.max_redemptions, data.minimum, data.active, data.times_redeemed], ["LAUNCH20", { kind: "percent", percent: 20 }, 50, { amount_cents: 3000, currency: "usd" }, true, 0]);
  is("the checkout's code box is switched on", (await storeForEmail(OWNER))!.hasDiscounts, true);
  is("numbers sent as numbers are read the same as text", (await make({ code: "TEN-OFF", kind: "amount", amount: 10 })).body.data && true, true);
  is("the same letters twice: refused as taken", [(await make({ code: "LAUNCH20", percent: 10 })).status], [409]);

  part("Reading them");
  const read = await list();
  is("every code, read from Stripe", [read.status, (read.body.data as { code: string }[]).map((c) => c.code).sort()], [200, ["LAUNCH20", "TEN-OFF"]]);
  is("an amount off is said in cents, with its currency", (read.body.data as { code: string; off: unknown }[]).find((c) => c.code === "TEN-OFF")!.off, { kind: "amount", amount_cents: 1000, currency: "usd" });

  part("Switching one off");
  is("a key that reads only cannot", (await stop(String(data.id), reader.key)).status, 403);
  is("an id that is not Stripe's shape is refused", (await stop("12345")).status, 400);
  const before = writes.length;
  is("an id that is not one of this store's codes: 404, nothing sent to Stripe", [(await stop("promo_999")).status, writes.length], [404, before]);
  const off = await stop(String(data.id));
  is("switched off, never deleted, and the list as Stripe says now", [off.status, (off.body.data as { id: string; active: boolean }[]).find((c) => c.id === data.id)!.active], [200, false]);
  const ten = (read.body.data as { id: string; code: string }[]).find((c) => c.code === "TEN-OFF")!;
  await stop(ten.id);
  is("with no live code left, the checkout's code box goes", (await storeForEmail(OWNER))!.hasDiscounts, false);

  done();
}

void main();
