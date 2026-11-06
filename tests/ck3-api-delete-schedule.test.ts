/**
 * 511 [CK3], review of #3006 (rule 30, sibling of the studio's "Switch it
 * off"): switching a code off through the public API (DELETE /api/v1/codes)
 * must drop its schedule first, as the studio does, so the five-minute job
 * never switches it back on. A synthetic Stripe in memory and the in-memory
 * Redis stand-in only.
 */
import { DELETE } from "@/app/api/v1/codes/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { activateScheduledCodes, DUE_KEY, scheduleCode } from "@/lib/discount-schedule";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "ck3-api-delete@example.com";
const ACCOUNT = "acct_Ck3ApiDelete01";
process.env.STRIPE_SECRET_KEY = "sk_test_ck3_api_delete_stand_in";

type Promo = Record<string, unknown>;
const promos = new Map<string, Promo>();
let writes: string[] = [];
let n = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || new Headers(init?.headers).get("Stripe-Account") !== ACCOUNT) throw new Error(`unexpected ${url}`);
  const form = new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");
  if (init?.method === "GET" && url.pathname === "/v1/promotion_codes") {
    return Response.json({ object: "list", has_more: false, data: [...promos.values()] });
  }
  if (init?.method === "POST" && url.pathname === "/v1/coupons") {
    return Response.json({ id: `co_${++n}`, object: "coupon", percent_off: Number(form.get("percent_off")), amount_off: null, currency: null, duration: "once" });
  }
  if (init?.method === "POST" && url.pathname === "/v1/promotion_codes") {
    const id = `promo_${++n}`;
    const row: Promo = {
      id, object: "promotion_code", code: form.get("code") ?? "", active: form.get("active") !== "false", times_redeemed: 0, max_redemptions: null,
      expires_at: form.get("expires_at") ? Number(form.get("expires_at")) : null,
      restrictions: { minimum_amount: null, minimum_amount_currency: null, first_time_transaction: false },
      promotion: { type: "coupon", coupon: { id: form.get("promotion[coupon]"), percent_off: 15, amount_off: null, currency: null, duration: "once" } },
    };
    promos.set(id, row);
    return Response.json(row);
  }
  const one = url.pathname.match(/^\/v1\/promotion_codes\/(promo_\w+)$/);
  if (init?.method === "POST" && one) {
    const row = promos.get(one[1]);
    if (!row) return Response.json({ error: { message: "No such promotion code" } }, { status: 404 });
    row.active = form.get("active") === "true";
    writes.push(`${row.active ? "on" : "off"} ${one[1]}`);
    return Response.json(row);
  }
  throw new Error(`unexpected ${init?.method} ${url}`);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "ck3-api-delete-shop", "CK3 API Delete Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Ck3ApiDelete1", subscriptionId: "sub_Ck3ApiDelete1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const shop = async () => (await storeForEmail(OWNER)) as Store;
  const writer = await makeKey((await shop()).sid, "Synthetic writer", Date.now(), true);
  if (!writer.ok) throw new Error("no synthetic key");
  await setStripeAccount(OWNER, ACCOUNT, true);
  const store = await shop();
  const stop = async (id: string) => {
    const r = await DELETE(new Request(`https://marktmorgen.com/api/v1/codes?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${writer.key}` } }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  const now = Math.floor(Date.now() / 1000);
  const start = now + 2 * 3600;
  const end = start + 48 * 3600;
  const made = await scheduleCode(store, { code: "LATER15", off: { kind: "percent", percent: 15 }, maxRedemptions: null, minimum: null }, { start, end }, now);
  if (!made.ok) throw new Error(`not scheduled: ${made.reason}`);
  const id = made.code.id;
  const member = `${store.sid}|${store.statsId}|${id}`;
  const kept = () => redis.pipeline([["HGET", `nl:dsched:${store.statsId}`, id], ["ZSCORE", DUE_KEY, member]]);

  part("While another change holds the store's schedules, the API does not switch the code off");
  await redis.pipeline([["SET", `nl:dsched:lock:${store.statsId}`, "someone-else", "EX", 60]]);
  writes = [];
  const busy = await stop(id);
  is("409 busy, Stripe not asked", [busy.status, busy.body.error, writes.length], [409, "busy", 0]);
  is("the schedule is still kept", (await kept()).every((reply) => reply !== null), true);
  await redis.pipeline([["DEL", `nl:dsched:lock:${store.statsId}`]]);

  part("Switching a scheduled code off through the API drops its schedule first");
  writes = [];
  const off = await stop(id);
  is("switched off", [off.status, writes], [200, [`off ${id}`]]);
  is("its schedule is gone from the store and from the job's list", await kept(), [null, null]);
  writes = [];
  await activateScheduledCodes(Date.now() + 5_000, start + 60);
  is("the five-minute job never switches it back on", writes.filter((w) => w === `on ${id}`), []);

  done();
}

void main();
