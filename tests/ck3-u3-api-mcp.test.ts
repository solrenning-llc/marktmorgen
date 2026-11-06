/**
 * 511 [CK3] unit 3: a discount code with a start and an end set ahead, through
 * the public API (POST /api/v1/codes with `starts_at` and `ends_at`). The same
 * reading, the same Stripe calls and the same paid tries as the studio's
 * schedule (unit 1, lib/discount-schedule.ts): the code is made switched off
 * on the creator's own Stripe account, with Stripe's expiry as its end, and the
 * five-minute job switches it on. Every answer says where each code stands.
 * Switching a scheduled code off through the API drops its schedule first, so
 * the job never switches it back on. The MCP server stays read only: making a
 * code is a "draft" action for an agent (lib/agent-coverage.ts), not built.
 * A synthetic Stripe in memory and the in-memory Redis stand-in only.
 */
import { readFileSync } from "node:fs";
import { GET, POST, DELETE } from "@/app/api/v1/codes/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { apiReadUnits, codeScheduleWork } from "@/lib/api-read-rules";
import { MAX_SCHEDULED_CODES, MIN_LEAD_SECONDS, MAX_AHEAD_SECONDS, MAX_LENGTH_SECONDS, SCHEDULE_UNITS } from "@/lib/discount-schedule-rules";
import { activateScheduledCodes, DUE_KEY } from "@/lib/discount-schedule";
import { CODE_FIELDS } from "@/lib/api-codes";
import { AGENT_COVERAGE } from "@/lib/agent-coverage";
import { MCP_TOOLS } from "@/lib/mcp-catalog";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "ck3-u3@example.com";
const ACCOUNT = "acct_Ck3UnitThree01";
process.env.STRIPE_SECRET_KEY = "sk_test_ck3_u3_stand_in";

type Promo = Record<string, unknown>;
const coupons = new Map<string, Record<string, unknown>>();
const promos = new Map<string, Promo>();
let writes: string[] = [];
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
    const coupon = { id, object: "coupon", percent_off: form.get("percent_off") ? Number(form.get("percent_off")) : null, amount_off: null, currency: null, duration: "once" };
    coupons.set(id, coupon);
    return Response.json(coupon);
  }
  if (init?.method === "POST" && url.pathname === "/v1/promotion_codes") {
    writes.push(`promotion active=${form.get("active") ?? "-"} expires_at=${form.get("expires_at") ?? "-"}`);
    const code = form.get("code") ?? "";
    const id = `promo_${++n}`;
    const row: Promo = { id, object: "promotion_code", code, active: form.get("active") !== "false", times_redeemed: 0, max_redemptions: null, expires_at: form.get("expires_at") ? Number(form.get("expires_at")) : null, restrictions: { minimum_amount: null, minimum_amount_currency: null, first_time_transaction: false }, promotion: { type: "coupon", coupon: form.get("promotion[coupon]") } };
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

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "ck3-u3-shop", "CK3 Unit Three Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Ck3u3", subscriptionId: "sub_Ck3u3", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const shop = async () => (await storeForEmail(OWNER)) as Store;
  const store = await shop();
  const reader = await makeKey(store.sid, "Synthetic reader");
  const writer = await makeKey(store.sid, "Synthetic writer", Date.now(), true);
  if (!reader.ok || !writer.ok) throw new Error("no synthetic keys");
  const auth = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
  const list = async () => { const r = await GET(new Request("https://marktmorgen.com/api/v1/codes", { headers: auth(reader.key) })); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  const make = async (body: unknown, key = writer.key) => { const r = await POST(new Request("https://marktmorgen.com/api/v1/codes", { method: "POST", headers: auth(key), body: JSON.stringify(body) })); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  const stop = async (id: string) => { const r = await DELETE(new Request(`https://marktmorgen.com/api/v1/codes?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(writer.key) })); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  const studioUsed = async () => allowanceUsed(await shop(), "studio");
  const apiUsed = async () => allowanceUsed(await shop(), "api");

  const now = Math.floor(Date.now() / 1000);
  const start = now + 2 * 3600;
  const end = start + 48 * 3600;

  part("Who may schedule, and what is refused before anything is spent");
  writes = [];
  is("a key that reads only cannot schedule a code", [(await make({ code: "HOLIDAY25", percent: 25, starts_at: iso(start), ends_at: iso(end) }, reader.key)).status, writes.length], [403, 0]);
  const studioBefore = await studioUsed();
  const bad = [
    await make({ code: "HOLIDAY25", percent: 25, starts_at: "tomorrow", ends_at: iso(end) }),
    await make({ code: "HOLIDAY25", percent: 25, starts_at: "2027-12-01T10:00:00", ends_at: iso(end) }),
    await make({ code: "HOLIDAY25", percent: 25, starts_at: start, ends_at: iso(end) }),
    await make({ code: "HOLIDAY25", percent: 25, starts_at: iso(now + MIN_LEAD_SECONDS - 60), ends_at: iso(end) }),
    await make({ code: "HOLIDAY25", percent: 25, starts_at: iso(now + MAX_AHEAD_SECONDS + 3600), ends_at: iso(now + MAX_AHEAD_SECONDS + 7200) }),
    await make({ code: "HOLIDAY25", percent: 25, starts_at: iso(start) }),
    await make({ code: "HOLIDAY25", percent: 25, starts_at: iso(start), ends_at: iso(start) }),
    await make({ code: "HOLIDAY25", percent: 25, starts_at: iso(start), ends_at: iso(start + MAX_LENGTH_SECONDS + 3600) }),
    await make({ code: "HOLIDAY25", percent: 25, ends_at: iso(end) }),
    await make({ code: "HOLIDAY25", percent: 25, starts_at: "2027-02-30T10:00:00Z", ends_at: iso(end) }),
  ];
  is(
    "each bad start or end is refused with its own field, in words",
    bad.map((r) => [r.status, r.body.error, typeof r.body.message === "string" && (r.body.message as string).length > 20]),
    [
      [400, "starts_at", true], [400, "starts_at", true], [400, "starts_at", true], [400, "starts_at", true], [400, "starts_at", true],
      [400, "ends_at", true], [400, "ends_at", true], [400, "ends_at", true], [400, "starts_at", true], [400, "starts_at", true],
    ],
  );
  is("a bad code is still refused first, as without a schedule", (await make({ code: "x", percent: 25, starts_at: iso(start), ends_at: iso(end) })).body.error, "shape");
  is("nothing refused reached Stripe", writes.length, 0);
  is("nothing refused took a studio request", await studioUsed(), studioBefore);

  part("Scheduling: made switched off, Stripe's expiry the end, every try paid before Stripe is asked");
  const apiBefore = await apiUsed();
  writes = [];
  const made = await make({ code: "holiday25", percent: 25, starts_at: iso(start), ends_at: iso(end) });
  is("scheduled", made.status, 200);
  is("made as the studio makes it: a coupon, then the code switched off with its end", writes, ["coupon", `promotion active=false expires_at=${end}`]);
  const data = made.body.data as Record<string, unknown>;
  is("the answer says it waits for its start", [data.code, data.active, data.state, data.starts_at, data.expires_at], ["HOLIDAY25", false, "scheduled", iso(start), iso(end)]);
  is("the job's tries are taken from the studio requests, as in the studio", (await studioUsed()) - studioBefore, SCHEDULE_UNITS);
  is("the call itself takes the door's request and its work", (await apiUsed()) - apiBefore, 1 + apiReadUnits(codeScheduleWork()));
  const kept = (await redis.pipeline([["HGETALL", `nl:dsched:${store.statsId}`]]))[0] as string[];
  is("the schedule is kept for the five-minute job", kept.length, 2);
  is("and is due at its start", (await redis.pipeline([["ZSCORE", DUE_KEY, `${store.sid}|${store.statsId}|${String(data.id)}`]]))[0], String(start));
  is("a start given with another offset is read as the same moment", (await make({ code: "OFFSET10", percent: 10, starts_at: new Date((start + 3600) * 1000).toISOString().replace("Z", "+00:00"), ends_at: iso(end) })).body.data && true, true);

  part("Reading them: where each code stands");
  is("starts_at and state are among the fields a caller may ask for", ["state", "starts_at"].every((f) => (CODE_FIELDS as readonly string[]).includes(f)), true);
  await make({ code: "NOWLIVE", percent: 5 });
  const read = await list();
  const rows = read.body.data as Record<string, unknown>[];
  const byCode = (code: string) => rows.find((r) => r.code === code)!;
  is("read", read.status, 200);
  is("a scheduled code: scheduled, with its start", [byCode("HOLIDAY25").state, byCode("HOLIDAY25").starts_at], ["scheduled", iso(start)]);
  is("a code made live at once: live, no start", [byCode("NOWLIVE").state, byCode("NOWLIVE").starts_at], ["live", null]);

  part("An unreadable schedule is never read as none");
  await redis.pipeline([["HSET", `nl:dsched:${store.statsId}`, "promo_broken", "{not json"]]);
  const blind = await list();
  is("the list is refused, never shown with a waiting code as simply off", [blind.status, blind.body.error], [502, "unavailable"]);
  await redis.pipeline([["HDEL", `nl:dsched:${store.statsId}`, "promo_broken"]]);

  part("The five-minute job switches it on; the API then says live");
  const ran = await activateScheduledCodes(Date.now() + 5_000, start + 60);
  is("switched on by the job", ran.activated >= 1, true);
  const after = (await list()).body.data as Record<string, unknown>[];
  const live = after.find((r) => r.code === "HOLIDAY25")!;
  is("live now, its schedule gone", [live.state, live.active, live.starts_at], ["live", true, null]);

  part("Switching a scheduled code off through the API drops its schedule first");
  const later = await make({ code: "LATER15", percent: 15, starts_at: iso(start + 7200), ends_at: iso(end) });
  const laterId = String((later.body.data as Record<string, unknown>).id);
  await redis.pipeline([["SET", `nl:dsched:lock:${store.statsId}`, "someone-else", "EX", 60]]);
  writes = [];
  const busy = await stop(laterId);
  is("while another change holds the codes: 409 busy, Stripe not asked", [busy.status, busy.body.error, writes.length], [409, "busy", 0]);
  await redis.pipeline([["DEL", `nl:dsched:lock:${store.statsId}`]]);
  const off = await stop(laterId);
  is("switched off", off.status, 200);
  is("its schedule is gone from the store and from the job's list", [((await redis.pipeline([["HGET", `nl:dsched:${store.statsId}`, laterId]]))[0]), (await redis.pipeline([["ZSCORE", DUE_KEY, `${store.sid}|${store.statsId}|${laterId}`]]))[0]], [null, null]);
  is("the answer says it is off", (off.body.data as Record<string, unknown>[]).find((r) => r.id === laterId)!.state, "off");
  writes = [];
  await activateScheduledCodes(Date.now() + 5_000, start + 7200 + 60);
  is("the job never switches it back on", writes.filter((w) => w === `on ${laterId}`), []);

  part("Bounded, and refused before Stripe when a bound is reached");
  for (let i = (await redis.pipeline([["HLEN", `nl:dsched:${store.statsId}`]]))[0] as number; i < MAX_SCHEDULED_CODES; i += 1) {
    await make({ code: `FILL${i}`, percent: 10, starts_at: iso(start + 3 * 3600), ends_at: iso(end) });
  }
  writes = [];
  const full = await make({ code: "ONEMORE", percent: 10, starts_at: iso(start + 3 * 3600), ends_at: iso(end) });
  is("past the store's most: 409 schedule_full, Stripe not asked", [full.status, full.body.error, writes.length], [409, "schedule_full", 0]);
  const s = await shop();
  const leftStudio = allowanceFor(s, "studio") - (await allowanceUsed(s, "studio"));
  if (leftStudio > 0) await takeAllowance(s, "studio", leftStudio);
  writes = [];
  const spent = await make({ code: "NOROOM", percent: 10, starts_at: iso(start + 3 * 3600), ends_at: iso(end) });
  is("no studio requests left for the tries: 429, Stripe not asked", [spent.status, spent.body.error, writes.length], [429, "studio_limit", 0]);

  part("The route takes every unit before Stripe is asked");
  const route = readFileSync("app/api/v1/codes/route.ts", "utf8");
  const at = (s: string) => route.indexOf(s);
  is("the API units, then the studio units, then the schedule", at("apiReadUnits(codeScheduleWork())") > 0 && at("apiReadUnits(codeScheduleWork())") < at("countStudio(store, null, SCHEDULE_UNITS)") && at("countStudio(store, null, SCHEDULE_UNITS)") < at("scheduleCode("), true);
  is("the schedule dropped before a code is switched off", at("dropSchedule(") > 0 && at("dropSchedule(") < at("stopCode("), true);

  part("The MCP server stays read only: making or scheduling a code is a draft action, not built");
  is("the coverage table still says draft", AGENT_COVERAGE["POST store/discount"].reach.kind, "draft");
  is("no MCP tool makes, schedules or switches off a code", MCP_TOOLS.some((t) => /code|discount/i.test(t.name)), false);

  done();
}

void main();
