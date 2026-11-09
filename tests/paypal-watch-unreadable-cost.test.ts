/**
 * The PayPal refund watch's looks at a sale whose paid record does not read (readPaidExact answers "unknown": text
 * that is not JSON, or a field out of its format). On claude5/paypal-capture-account such an order went back on the
 * watch an hour later every time, until its record ended at 400 days: up to 9,600 looks a sale, each the record's GET
 * and the watch's ZADD, with no line in the cost registry.
 *
 * Now its looks follow the same schedule as a capture whose read fails (lookAfterFailure), by the sale's age read from
 * what is left of the record's life (its TTL; settle writes it once, SET NX EX PAID_KEPT_SECONDS): hourly for the first
 * week, then less, once a day for a month past PayPal's refund window, then once a week until the record ends, when
 * the order leaves. A record whose life does not read is looked at once a week. The purchase is never taken back nor
 * the order marked refunded for what is not known. The looks are the company's cost, PAYPAL_WATCH_UNREADABLE_LOOKS in
 * tests/plan-cost-registry.ts, beside PAYPAL_WATCH_LOOKS.
 *
 * Every figure is read from what the real return route and the real sweep do, the clock moved to the very second each
 * look is due. Synthetic only: a stand-in for PayPal's API, the Redis stub, the real return route and sweep.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { MAX_PAID_BYTES, openOrder } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const SELLER = "7KNGBPH2U58GQ";
const DAY = 86_400;
const WEEK = 7 * DAY;
const WINDOW = 180 * DAY;
const DAILY_PAST = 30 * DAY;
const KEPT = 400 * DAY;
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `5O190127TN36473${String(n).padStart(2, "0")}`;
const captureOf = (order: string) => `3C679366HH9089${order.slice(-2)}`;
let buyerFor = "a@example.com";
/** Every capture read, by capture id. */
const captureReads: string[] = [];

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
    captureReads.push(cap);
    // Refunded in full: were the watch ever to read past the record that does not read, it would take the purchase back.
    return json({ id: cap, status: "REFUNDED" });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
type Commands = (string | number)[][];

/** The registry's line for these looks (optional chaining below kept from the RED, when it was not there yet). */
const LOOKS: typeof registry.PAYPAL_WATCH_UNREADABLE_LOOKS | undefined = registry.PAYPAL_WATCH_UNREADABLE_LOOKS;

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

/** Puts `value` in place of a paid record, its expiry kept (to the second). Returns when the sale was paid. */
async function spoil(order: string, value: string): Promise<number> {
  const key = `nl:ppsell:paid:${order}`;
  const [raw, endsMs] = await redis.pipeline([["GET", key], ["PEXPIRETIME", key]]);
  await redis.pipeline([["SET", key, value], ["EXPIREAT", key, Math.floor(Number(endsMs) / 1000)]]);
  return (JSON.parse(String(raw)) as { at: number }).at;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_watch_unreadable";
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
  const refundedKey = `nl:ppsell:refunded:${statsId}`;
  const owned = async (buyer: string) => (await importedFor(await fresh(), buyer)).length;
  const scoreOf = async (order: string) => (await redis.pipeline([["ZSCORE", watchKey, order]]))[0];

  const garbled = await buy(await fresh(), added.product.id, "garbled@example.com");
  const shaped = await buy(await fresh(), added.product.id, "shaped@example.com");
  is("two sales handed over", [await owned("garbled@example.com"), await owned("shaped@example.com")], [1, 1]);
  const paidAt = new Map<string, number>();
  paidAt.set(garbled, await spoil(garbled, "{not json"));
  // A record in JSON, every field there, its capture id out of its format: readPaidExact answers "unknown" for it too.
  const [shapedRaw] = await redis.pipeline([["GET", `nl:ppsell:paid:${shaped}`]]);
  paidAt.set(shaped, await spoil(shaped, JSON.stringify({ ...(JSON.parse(String(shapedRaw)) as object), capture: "not a capture!" })));

  // Every command each sweep sends about one order (its paid record and its place on the watch), by order.
  const pipeline = redis.pipeline.bind(redis);
  let sent: Commands = [];
  redis.pipeline = (async (commands: Commands) => {
    sent.push(...commands);
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const about = (order: string) => sent.filter((c) => c[1] === `nl:ppsell:paid:${order}` || (c[1] === watchKey && c[0] !== "ZRANGEBYSCORE" && c[c.length - 1] === order));

  part("Every look made at the very second it is due, until each sale leaves the watch or 3,000 looks have passed");
  const looks = new Map<string, { age: number; commands: number }[]>();
  let sweeps = 0;
  for (; sweeps < 3_000; sweeps += 1) {
    const [due] = await pipeline([["ZRANGEBYSCORE", watchKey, "-inf", "+inf", "WITHSCORES", "LIMIT", "0", "1"]]);
    const next = Array.isArray(due) && due.length === 2 ? Number(due[1]) : null;
    if (next === null) break;
    ahead = next * 1000 + 500 - realNow();
    sent = [];
    await sweepPayPal(await fresh(), Date.now() + 10_000);
    const now = Math.floor(Date.now() / 1000);
    for (const order of [garbled, shaped]) {
      const commands = about(order);
      if (commands.some((c) => c[0] === "GET")) looks.set(order, [...(looks.get(order) ?? []), { age: now - paidAt.get(order)!, commands: commands.length }]);
    }
  }
  is("every sale left the watch", [await scoreOf(garbled), await scoreOf(shaped)], [null, null]);
  for (const [order, kind] of [[garbled, "a record that is not JSON"], [shaped, "a record with a field out of its format"]] as const) {
    const ages = (looks.get(order) ?? []).map((look) => look.age);
    const inWindow = ages.filter((age) => age <= WINDOW).length;
    const past = ages.filter((age) => age > WINDOW);
    is(`${kind}: the looks inside the refund window are the registry's, at the most`, inWindow <= (LOOKS?.inWindowPerSaleMost ?? -1), true);
    is(`${kind}: ... and the watch's own schedule, exactly (hourly the first week, six-hourly to day 30, daily to day 180)`, inWindow, 410);
    is(`${kind}: the looks after it are the registry's, at the most`, past.length <= (LOOKS?.pastWindowPerSaleMost ?? -1), true);
    is(`${kind}: once a day for a month past the window (days 181 to 209)`, past.filter((age) => age < WINDOW + DAILY_PAST).length, 29);
    const weekly = past.filter((age) => age >= WINDOW + DAILY_PAST && age <= KEPT - DAY);
    const gaps = weekly.slice(1).map((age, i) => age - weekly[i]);
    is(`${kind}: then a week apart from day 210, the last on the record's last day`, [weekly[0], gaps.length > 0 && gaps.every((gap) => gap === WEEK), weekly[weekly.length - 1]], [WINDOW + DAILY_PAST, true, KEPT - DAY]);
    is(`${kind}: never looked at once the record has ended`, ages.every((age) => age <= KEPT), true);
    const commands = (looks.get(order) ?? []).map((look) => look.commands);
    is(`${kind}: each look sends the registry's commands about the order, no more`, Math.max(...commands) <= (LOOKS?.commandsPerLook ?? -1), true);
  }
  is("PayPal is never asked about a capture whose record does not read", captureReads, []);
  is("the purchases are kept: nothing taken back for what is not known", [await owned("garbled@example.com"), await owned("shaped@example.com")], [1, 1]);
  is("and neither order is marked refunded", await pipeline([["ZSCORE", refundedKey, garbled], ["ZSCORE", refundedKey, shaped]]), [null, null]);

  part("A record whose life does not read is looked at once a week, never every hour");
  redis.pipeline = pipeline as typeof redis.pipeline;
  ahead = 0;
  const persisted = await buy(await fresh(), added.product.id, "persisted@example.com");
  await spoil(persisted, "{not json");
  await pipeline([["PERSIST", `nl:ppsell:paid:${persisted}`], ["ZADD", watchKey, "0", persisted]]);
  await sweepPayPal(await fresh(), Date.now() + 10_000);
  is("a record without its expiry: next look a week on", Number(await scoreOf(persisted)) - Math.floor(Date.now() / 1000), WEEK);
  const odd = await buy(await fresh(), added.product.id, "odd@example.com");
  await spoil(odd, "{not json");
  await pipeline([["ZADD", watchKey, "0", odd]]);
  redis.pipeline = (async (commands: Commands) => (commands.length === 1 && commands[0][0] === "TTL" ? ["soon"] : pipeline(commands))) as typeof redis.pipeline;
  await sweepPayPal(await fresh(), Date.now() + 10_000);
  redis.pipeline = pipeline as typeof redis.pipeline;
  is("a life whose reply does not read: next look a week on", Number(await scoreOf(odd)) - Math.floor(Date.now() / 1000), WEEK);
  is("both purchases kept", [await owned("persisted@example.com"), await owned("odd@example.com")], [1, 1]);

  part("The registry's line: the company's cost, beside PAYPAL_WATCH_LOOKS");
  is("the line is there", typeof LOOKS, "object");
  is("as many looks a sale as a capture whose read fails, the same schedule", [LOOKS?.inWindowPerSaleMost, LOOKS?.pastWindowPerSaleMost], [registry.PAYPAL_WATCH_LOOKS.inWindowPerSaleMost, registry.PAYPAL_WATCH_LOOKS.pastWindowPerSaleMost]);
  is("three commands a look (the record's GET, its TTL, the watch's ZADD or ZREM), the record at its heaviest, no PayPal call", [LOOKS?.commandsPerLook, LOOKS?.bytesPerLookMost, LOOKS?.paypalCallsPerLook], [3, MAX_PAID_BYTES, 0]);
  is("its ceiling is not approved", LOOKS?.approvedCeiling, false);
  const why = registry.NOT_A_COST.UNANSWERED_WEEKLY_SECONDS ?? "";
  is("NOT_A_COST says why these looks are the company's, with the function that spaces them", [why.includes("lookAfterUnreadable"), why.includes("PAYPAL_WATCH_UNREADABLE_LOOKS")], [true, true]);
  const saleUsd: unknown = registry.PAYPAL_WATCH_UNREADABLE_SALE_REDIS_USD;
  is("a sale's Redis for its whole life, every record unreadable, is counted and not zero", typeof saleUsd === "number" && saleUsd > 0, true);
  console.log(`PayPal watch, unreadable records: ${sweeps} sweeps; a sale's life ${typeof saleUsd === "number" ? `$${saleUsd.toFixed(5)}` : "no line"} of Redis.`);
  done();
}
main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
