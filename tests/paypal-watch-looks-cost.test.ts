/**
 * The PayPal refund watch's looks at one sale, as the cost registry states them (PAYPAL_WATCH_LOOKS and
 * NOT_A_COST.UNANSWERED_WEEKLY_SECONDS in tests/plan-cost-registry.ts). On claude5/paypal-capture-account a capture
 * whose read fails for a fault (not the account's own refusal) was asked about once a day from the end of PayPal's
 * 180-day refund window until its paid record ended at 400 days: 219 looks more a sale, each a PayPal call and the
 * watch's Redis, with no line in the registry. Now it is asked once a day for a month past the window
 * (UNANSWERED_DAILY_SECONDS) and then once a week (UNANSWERED_WEEKLY_SECONDS), with a last look on the record's last
 * day (lib/paypal-sales.ts, lookAfterFailure), and a refund made inside the window is still seen.
 *
 * Each figure is read from what the real return route and the real sweep do, at their worst: the clock is moved to the
 * very second each look is due, so no look is lost to the five-minute job's own delays, and every read fails for the
 * sale's whole life. Synthetic only: a stand-in for PayPal's API, the Redis stub, the real return route and sweep.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { lookAfterFailure, nextLook, openOrder, MAX_PAID_BYTES, UNANSWERED_DAILY_SECONDS, UNANSWERED_WEEKLY_SECONDS } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { NOT_A_COST, PAYPAL_WATCH_LOOK_REDIS_USD, PAYPAL_WATCH_LOOKS, PAYPAL_WATCH_SALE_REDIS_USD, paypalWatchStoreMonthRedisUsd } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const SELLER = "7KNGBPH2U58GQ";
const DAY = 86_400;
const WINDOW = 180 * DAY;
const KEPT = 400 * DAY;
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `5O190127TN36473${String(n).padStart(2, "0")}`;
const captureOf = (order: string) => `3C679366HH9089${order.slice(-2)}`;
let buyerFor = "a@example.com";
/** When each capture was paid, in seconds, read back from its paid record. */
const paidAt = new Map<string, number>();
/** Captures whose reads PayPal answers 503 for the sale's whole life. */
const unavailable = new Set<string>();
/** Captures whose reads never get an answer (the request rejects). */
const unreachable = new Set<string>();
/** A capture PayPal is down for from day 175 to day 300 of its life, refunded in full on day 178. */
let lateOutage = "";
/** Every capture read, with the second it was made. */
const captureReads: { capture: string; at: number }[] = [];
const nowSeconds = () => Math.floor(Date.now() / 1000);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    const body = {
      id: capture,
      status: "COMPLETED",
      payer: { email_address: buyerFor, payer_id: "QYR5Z8XDVJNXQ" },
      purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: captureOf(capture), status: "COMPLETED", amount: { currency_code: "USD", value: "49.00" } }] } }],
    };
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9-]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") {
    captureReads.push({ capture: cap, at: nowSeconds() });
    if (unreachable.has(cap)) throw new TypeError("fetch failed");
    if (unavailable.has(cap)) return json({ name: "SERVICE_UNAVAILABLE" }, 503);
    const age = nowSeconds() - (paidAt.get(cap) ?? 0);
    if (cap === lateOutage && age >= 175 * DAY && age < 300 * DAY) return json({ name: "SERVICE_UNAVAILABLE" }, 503);
    return json({ id: cap, status: cap === lateOutage && age >= 178 * DAY ? "REFUNDED" : "COMPLETED" });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
type Commands = (string | number)[][];

async function buy(store: Store, productId: string, buyer: string): Promise<string> {
  const product = (await readListing(store, productId))!;
  const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
  buyerFor = buyer;
  await paypalReturn(
    new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${opened.order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${made}` } }),
  );
  return opened.order;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_watch_looks";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const statsId = (await fresh()).statsId!;
  const watchKey = `nl:ppsell:watch:${statsId}`;
  const owned = async (buyer: string) => (await importedFor(await fresh(), buyer)).length;
  const watched = async (order: string) => (await redis.pipeline([["ZSCORE", watchKey, order]]))[0];

  const down = await buy(await fresh(), added.product.id, "down@example.com");
  const lost = await buy(await fresh(), added.product.id, "lost@example.com");
  const late = await buy(await fresh(), added.product.id, "late@example.com");
  is("three sales handed over", [await owned("down@example.com"), await owned("lost@example.com"), await owned("late@example.com")], [1, 1, 1]);
  for (const order of [down, lost, late]) {
    const [raw] = await redis.pipeline([["GET", `nl:ppsell:paid:${order}`]]);
    paidAt.set(captureOf(order), (JSON.parse(String(raw)) as { at: number }).at);
    is(`the paid record of ${order} weighs no more than a look counts`, Buffer.byteLength(String(raw)) <= PAYPAL_WATCH_LOOKS.bytesPerLookMost, true);
  }
  unavailable.add(captureOf(down));
  unreachable.add(captureOf(lost));
  lateOutage = captureOf(late);

  // Every command each sweep sends about one order (its paid record and its place on the watch), by order.
  const perLook = new Map<string, number[]>();
  const pipeline = redis.pipeline.bind(redis);
  let sent: Commands = [];
  redis.pipeline = (async (commands: Commands) => {
    sent.push(...commands);
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const about = (order: string) => sent.filter((c) => c[1] === `nl:ppsell:paid:${order}` || (c[1] === watchKey && c[0] !== "ZRANGEBYSCORE" && c[c.length - 1] === order)).length;

  part("Every look made at the very second it is due, every read failing, until each sale leaves the watch");
  let sweeps = 0;
  for (; sweeps < 2_000; sweeps += 1) {
    const [due] = await redis.pipeline([["ZRANGEBYSCORE", watchKey, "-inf", "+inf", "WITHSCORES", "LIMIT", "0", "1"]]);
    const next = Array.isArray(due) && due.length === 2 ? Number(due[1]) : null;
    if (next === null) break;
    ahead = next * 1000 + 500 - realNow();
    sent = [];
    const reads = captureReads.length;
    await sweepPayPal(await fresh(), Date.now() + 10_000);
    for (const order of [down, lost, late]) {
      const looked = captureReads.slice(reads).some((r) => r.capture === captureOf(order));
      const commands = about(order);
      if (commands) perLook.set(order, [...(perLook.get(order) ?? []), looked ? commands : -commands]);
    }
  }
  is("every sale left the watch", [await watched(down), await watched(lost), await watched(late)], [null, null, null]);
  for (const [order, kind] of [[down, "a 503 on every read"], [lost, "no answer to any read"]] as const) {
    const reads = captureReads.filter((r) => r.capture === captureOf(order)).map((r) => r.at - paidAt.get(captureOf(order))!);
    const inWindow = reads.filter((age) => age <= WINDOW).length;
    const past = reads.filter((age) => age > WINDOW);
    is(`${kind}: the looks inside the refund window are the registry's, exactly`, inWindow, PAYPAL_WATCH_LOOKS.inWindowPerSaleMost);
    // The record ends PAID_KEPT_SECONDS after it was written, a moment after the sale's whole second `at`: a look due on
    // that very second may still find it (one more look, which the registry's 58 counts), never one a day later.
    const atEnd = past.filter((age) => age > KEPT - DAY);
    is(`${kind}: the looks after it are 57 at the exact times, one more when the record outlives its second`, past.length - atEnd.length, 57);
    is(`${kind}: ... which the registry's figure covers`, past.length <= PAYPAL_WATCH_LOOKS.pastWindowPerSaleMost, true);
    is(`${kind}: once a day for a month past the window (days 181 to 209)`, past.filter((age) => age < WINDOW + UNANSWERED_DAILY_SECONDS).length, 29);
    const weekly = past.filter((age) => age >= WINDOW + UNANSWERED_DAILY_SECONDS && age <= KEPT - DAY);
    const gaps = weekly.slice(1).map((age, i) => age - weekly[i]);
    is(`${kind}: then a week apart from day 210, the last on the record's last day`, [weekly[0], gaps.every((gap) => gap === UNANSWERED_WEEKLY_SECONDS), weekly[weekly.length - 1]], [WINDOW + UNANSWERED_DAILY_SECONDS, true, KEPT - DAY]);
    is(`${kind}: never asked about once the paid record has ended`, atEnd.length <= 1 && atEnd.every((age) => age <= KEPT), true);
    const looks = perLook.get(order) ?? [];
    is(`${kind}: each look sends the registry's commands about the order, no more`, Math.max(...looks.map(Math.abs)), PAYPAL_WATCH_LOOKS.commandsPerLook);
    is(`${kind}: and the look that finds the record gone asks PayPal nothing`, looks[looks.length - 1], -PAYPAL_WATCH_LOOKS.commandsPerLook);
  }
  is("the purchases are kept and never taken for refunded without PayPal's word", [await owned("down@example.com"), await owned("lost@example.com")], [1, 1]);

  part("A refund made inside the window while PayPal is down (day 175 to day 300) is still seen, at the next weekly look");
  is("taken back", await owned("late@example.com"), 0);
  const lateReads = captureReads.filter((r) => r.capture === lateOutage).map((r) => r.at - paidAt.get(lateOutage)!);
  const answered = lateReads.filter((age) => age >= 300 * DAY);
  is("by the first look PayPal answered, within a week of it answering again", [answered.length, answered[0] < 300 * DAY + UNANSWERED_WEEKLY_SECONDS], [1, true]);

  part("Fewer looks with the five-minute job's delays, never more: a later time never gives an earlier look");
  let monotonic = true;
  let sooner = false;
  for (let age = 0; age < KEPT + 2 * DAY; age += 600) {
    for (const refused of [false, true]) {
      const a = lookAfterFailure(0, age, refused);
      const b = lookAfterFailure(0, age + 300, refused);
      if (a !== null && (b === null ? !refused : b < a)) monotonic = false;
      const scheduled = nextLook(0, age);
      if (a !== null && (a <= age || (scheduled !== null && a < scheduled))) sooner = true;
    }
  }
  is("each answer is never earlier than for a sooner time", monotonic, true);
  is("never asked sooner than the watch's own schedule, nor at the same second", sooner, false);
  is("the account's refusal ends the watch a month past the window, as before", [lookAfterFailure(0, WINDOW + UNANSWERED_DAILY_SECONDS - 1, true), lookAfterFailure(0, WINDOW + UNANSWERED_DAILY_SECONDS, true)], [WINDOW + UNANSWERED_DAILY_SECONDS - 1 + DAY, null]);

  part("The registry's figures and their bounds");
  const source = readFileSync(join(process.cwd(), "lib/paypal-sales.ts"), "utf8");
  const limit = /\["ZRANGEBYSCORE", watchKey\(statsId\), "0", String\(now\), "LIMIT", "0", (?:"(\d+)"|String\(PAYPAL_WATCH_BATCH\))\]/.exec(source);
  const batch = limit?.[1] ?? /export const PAYPAL_WATCH_BATCH = (\d+);/.exec(source)?.[1];
  is("one sweep of a store looks at no more orders of its watch than the registry says", Number(batch), PAYPAL_WATCH_LOOKS.ordersPerStoreRunMost);
  const crons = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
  is("the sweep runs every five minutes, the registry's runs a day", [crons.crons.find((c) => c.path === "/api/cron/mail")?.schedule, PAYPAL_WATCH_LOOKS.runsPerDay], ["*/5 * * * *", 288]);
  is("the job that runs it is the sweep", /sweepCheckouts/.test(readFileSync(join(process.cwd(), "app/api/cron/mail/route.ts"), "utf8")), true);
  is("a look's record is the heaviest a paid record weighs", PAYPAL_WATCH_LOOKS.bytesPerLookMost, MAX_PAID_BYTES);
  is("PayPal's price for a call is unknown, and the ceiling is not approved", [PAYPAL_WATCH_LOOKS.paypalCallUsd, PAYPAL_WATCH_LOOKS.approvedCeiling], [null, false]);
  is("the company's cost, said in NOT_A_COST with the function that spaces the looks", [typeof NOT_A_COST.UNANSWERED_WEEKLY_SECONDS, NOT_A_COST.UNANSWERED_WEEKLY_SECONDS.includes("lookAfterFailure"), typeof NOT_A_COST.UNANSWERED_DAILY_SECONDS], ["string", true, "string"]);
  is("a sale's Redis for its whole life is the looks at the dearest look", PAYPAL_WATCH_SALE_REDIS_USD, (PAYPAL_WATCH_LOOKS.inWindowPerSaleMost + PAYPAL_WATCH_LOOKS.pastWindowPerSaleMost) * PAYPAL_WATCH_LOOK_REDIS_USD);
  is("and is not zero", PAYPAL_WATCH_SALE_REDIS_USD > 0 && paypalWatchStoreMonthRedisUsd() > 0, true);
  console.log(
    `PayPal watch: ${sweeps} sweeps; a look $${PAYPAL_WATCH_LOOK_REDIS_USD.toExponential(3)} of Redis; a sale's life ${PAYPAL_WATCH_LOOKS.inWindowPerSaleMost} + ${PAYPAL_WATCH_LOOKS.pastWindowPerSaleMost} looks = $${PAYPAL_WATCH_SALE_REDIS_USD.toFixed(5)} (past the window $${(PAYPAL_WATCH_LOOKS.pastWindowPerSaleMost * PAYPAL_WATCH_LOOK_REDIS_USD).toFixed(5)}, daily to the end it was $${(219 * PAYPAL_WATCH_LOOK_REDIS_USD).toFixed(5)}); a store's month at most $${paypalWatchStoreMonthRedisUsd().toFixed(2)}; PayPal's calls unknown.`,
  );
  done();
}
main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
