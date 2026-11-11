/**
 * PayPal sales on the Path (12 [D9], unit 1; the money reviews on #3443).
 *
 * A PayPal order the store's own server captured (lib/paypal-sales.ts) counts
 * toward the first real sale and the levels only when:
 *   - the order itself says it was taken through PayPal's live API (written on
 *     the paid record when it was captured, never the reader's own setting:
 *     Claude 6's M3);
 *   - its refunds can be seen: the platform is a PayPal partner and the store
 *     is still connected to the very PayPal account that took it, so the
 *     refund watch asks about it (Claude 5's N1);
 *   - PayPal never said it was refunded in part or reversed (Claude 6's M2,
 *     L3): such a sale is taken off whole, since the amount kept is not read.
 * Refunds PayPal confirmed in full are taken off, matched by the capture; a
 * refund of a sale the Path did not count is never taken off another sale
 * (L2). A sale the refund watch could not read at its last look (PayPal
 * refused it, 403 or 401, because the seller took the permission back inside
 * PayPal; PayPal down; an answer without a status) leaves the count until the
 * watch reads PayPal's answer again (Claude 5's N1b). A reply off its shape is unknown: the money is null, never "no
 * refunds" (M1), and a sales read off its shape is partial (L1).
 * Synthetic store, orders, Stripe and PayPal stand-ins, in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, ensureStoreId, setPayPalSeller, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readPathMoney, soldOf } from "@/lib/path-facts";
import { startPath, visitPath } from "@/lib/path";
import { readAnswers } from "@/lib/path-rules";
import { payPalSale } from "@/lib/stats";
import { captureOrder, paypalPaymentId, readPayPalSales, watchPayPal, type Paid } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const PARTNER = { PAYPAL_PARTNER_CLIENT_ID: "AZpartnerClientId0123456789", PAYPAL_PARTNER_SECRET: "EPpartnerSecret0123456789", PAYPAL_PARTNER_MERCHANT_ID: "PARTNERMERCH01", PAYPAL_BN_CODE: "NimbusLabs_SP" };
const partnerOn = () => Object.assign(process.env, PARTNER);
const partnerOff = () => { for (const key of Object.keys(PARTNER)) delete process.env[key]; };
process.env.STRIPE_SECRET_KEY = "sk_test_path_paypal";
delete process.env.PAYPAL_ENV;
delete process.env.PAYPAL_API_BASE;

const OWNER = "paypal-path@example.test";
const SELLER = "MERCHANTPP01";
const ACCOUNT = "acct_fixturepp01";
const order = (n: number) => `ORDER${String(n).padStart(10, "0")}`;
const now = Math.floor(Date.now() / 1000);

/** PayPal's word on each capture (GET /v2/payments/captures/:id), and what a capture POST answers. */
const captureStatus = new Map<string, string>();
/** Captures PayPal refuses to show, by the HTTP status it answers (403 or 401: the seller took the permission back). */
const captureRefused = new Map<string, number>();
let sessions: Record<string, unknown>[] = [];
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    const path = url.pathname.replace(/^\/v1/, "");
    if (path === "/checkout/sessions") return answer({ object: "list", data: sessions, has_more: false });
    if (path === "/payment_intents" || path === "/refunds") return answer({ object: "list", data: [], has_more: false });
    return answer({}, 404);
  }
  if (url.hostname !== "api-m.paypal.com") return answer({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return answer({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  const captured = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (captured && method === "POST") {
    return answer({
      id: captured,
      status: "COMPLETED",
      payer: { email_address: "Buyer9@Example.test" },
      purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: "CAPTURE9", status: "COMPLETED", amount: { currency_code: "USD", value: "29.00" } }] } }],
    });
  }
  const cap = /^\/v2\/payments\/captures\/([A-Za-z0-9-]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET" && captureRefused.has(cap)) {
    const code = captureRefused.get(cap)!;
    return answer(code === 200 ? { id: cap } : { name: code === 401 ? "AUTHENTICATION_FAILURE" : code === 403 ? "NOT_AUTHORIZED" : "INTERNAL_SERVER_ERROR" }, code);
  }
  if (cap && method === "GET") return answer({ id: cap, status: captureStatus.get(cap) ?? "COMPLETED" });
  return answer({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

/** Replies bent on their way back, for the replies-off-their-shape checks; null leaves every reply as Redis gave it. */
let bend: ((commands: (string | number)[][], replies: unknown[]) => unknown) | null = null;
const realPipeline = redis.pipeline.bind(redis);
/** Commands not run at all, their reply off its shape: a write Redis may not have made. */
let lost: ((commands: (string | number)[][]) => boolean) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (lost?.(commands)) return ["x"];
  const replies = await realPipeline(commands);
  return bend ? bend(commands, replies) : replies;
}) as typeof redis.pipeline;
const bendFirst = (prefix: string, verb: string, to: (replies: unknown[]) => unknown) => (commands: (string | number)[][], replies: unknown[]) =>
  commands[0]?.[0] === verb && String(commands[0]?.[1]).startsWith(prefix) ? to(replies) : replies;

function paid(statsId: string, n: number, cents: number, at: number, over: Partial<Paid> & Record<string, unknown> = {}): Paid {
  return { store: statsId, order: order(n), capture: `CAPTURE${n}`, email: `buyer${n}@example.test`, product: "p1", cents, currency: "usd", at, live: true, merchant: SELLER, ...over } as Paid;
}

function writePaid(p: Paid, listed = true): void {
  redis.run(["SET", `nl:ppsell:paid:${p.order}`, JSON.stringify(p)]);
  if (listed) redis.run(["ZADD", `nl:ppsell:sales:${p.store}`, String(p.at), p.order]);
}

/** A store with Stripe and PayPal connected, three live PayPal sales (2900, 4900 refunded in full, 1500), no Stripe sale. */
async function setup(): Promise<{ store: Store; statsId: string }> {
  redis.clear();
  partnerOn();
  captureStatus.clear();
  captureRefused.clear();
  sessions = [];
  bend = null;
  lost = null;
  await claimHandle(OWNER, "paypalpath", "PayPal Path", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_pp", subscriptionId: "sub_pp", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setPayPalSeller(OWNER, SELLER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  for (const p of [paid(statsId, 1, 2900, now - 300), paid(statsId, 2, 4900, now - 200), paid(statsId, 3, 1500, now - 100)]) writePaid(p);
  redis.run(["ZADD", `nl:ppsell:refunded:${statsId}`, String(now - 50), order(2)]);
  return { store, statsId };
}

const money = async (store: Store) => {
  const read = await readPathMoney(store, now * 1000);
  return [read?.real, read?.cents];
};

async function main(): Promise<void> {
  part("A PayPal order, as the path reads it: by its own record");
  {
    const live = payPalSale(paid("stats", 1, 2900, now));
    is("taken on the live API, its refunds watched: a real sale", soldOf(live, SELLER), { cents: 2900, currency: "usd", intent: paypalPaymentId("CAPTURE1"), live: true });
    is("its refunds not watched (no partner or no PayPal connected): not counted", soldOf(live, null).live, null);
    is("watched under another PayPal account than the one that took it: not counted", soldOf(live, "OTHERMERCH01").live, null);
    is("taken on PayPal's sandbox: neither real nor a test purchase", soldOf(payPalSale(paid("stats", 1, 2900, now, { live: false })), SELLER).live, null);
    is("a record from before the API was written on it: not counted", soldOf(payPalSale(paid("stats", 1, 2900, now, { live: undefined })), SELLER).live, null);
    is("PayPal said it was refunded in part: not counted", soldOf(payPalSale(paid("stats", 1, 2900, now, { takenOff: "PARTIALLY_REFUNDED" })), SELLER).live, null);
    is("PayPal said it was reversed: not counted", soldOf(payPalSale(paid("stats", 1, 2900, now, { takenOff: "REVERSED" })), SELLER).live, null);
    is("the refund watch could not read it at its last look: not counted", soldOf(payPalSale(paid("stats", 1, 2900, now, { blind: now })), SELLER).live, null);
    is("a Stripe sale keeps its own livemode", soldOf({ cents: 1000, currency: "usd", paymentIntent: "pi_1", row: { livemode: false } }, SELLER).live, false);
  }

  part("Live PayPal sales counted, the one refunded in full taken off");
  {
    const { store } = await setup();
    is("two real sales kept, 4400 kept", await money(store), [2, 4400]);
  }

  part("M3: whether an order is real is on the order, never on the deployment reading it");
  {
    const { store, statsId } = await setup();
    writePaid(paid(statsId, 4, 7000, now - 90, { live: false }));
    writePaid(paid(statsId, 5, 8000, now - 80, { live: undefined }));
    is("a sandbox order and one without the field: not real, nothing added", await money(store), [2, 4400]);
    // An order opened and captured on the live API (no PAYPAL_ENV, no stand-in): the paid record says so, and by whom.
    redis.run(["SET", `nl:ppsell:o:${order(9)}`, JSON.stringify({ s: statsId, h: "paypalpath", p: "p1", c: 2900, cur: "usd", m: SELLER, at: now })]);
    const captured = await captureOrder(store, order(9));
    const kept = JSON.parse(String(redis.run(["GET", `nl:ppsell:paid:${order(9)}`]))) as Record<string, unknown>;
    is("captured: its record carries the live API and the PayPal account that took it", [captured.ok, kept.live, kept.merchant], [true, true, SELLER]);
    is("and it counts", await money(store), [3, 7300]);
  }

  part("M1: the refunds' range off its shape leaves the money unknown, never 'no refunds'");
  {
    const { store } = await setup();
    const cases: [string, (replies: unknown[]) => unknown][] = [
      ["its reply slot missing", () => []],
      ["a reply that is not a list", () => ["1"]],
      ["a null reply", () => [null]],
      ["a list of an odd length (an order without its score)", () => [[order(2)]]],
      ["a list with a number in it", () => [[order(2), now - 50]]],
    ];
    for (const [name, to] of cases) {
      bend = bendFirst("nl:ppsell:refunded:", "ZRANGEBYSCORE", to);
      const read = await readPathMoney(store, now * 1000);
      is(`${name}: money null`, read?.cents, null);
      // Claude 1's MEDIUM: a sale that may have been refunded is not a real sale kept, so no level moves on it.
      is(`${name}: no sale counted as kept`, read?.real, 0);
    }
    // Only the MGET of the refunded records, the one after the refunds' range (the sales' own MGET reads the same keys).
    let afterRange = false;
    bend = (commands, replies) => {
      if (commands[0]?.[0] === "ZRANGEBYSCORE" && String(commands[0]?.[1]).startsWith("nl:ppsell:refunded:")) afterRange = true;
      else if (afterRange && commands[0]?.[0] === "MGET") return ["x"];
      return replies;
    };
    const read = await readPathMoney(store, now * 1000);
    is("the refunded records' MGET off its shape: money null", read?.cents, null);
    is("the refunded records' MGET off its shape: no sale counted as kept", read?.real, 0);
    bend = null;
  }

  part("A reading whose refunds are unknown never replaces the kept one (Claude 4's LOW on #3443)");
  {
    const { store } = await setup();
    const answers = readAnswers({ goalCents: 100_000, skills: "baking", subject: "sourdough", minutes: 30, audience: "instagram", timeZone: "America/Sao_Paulo" }, store.currency);
    if (!answers.ok) throw new Error("answers");
    const started = await startPath(store, answers.answers, now * 1000);
    if (!started.ok) throw new Error("path");
    const kept = await visitPath(store, started.record, now * 1000, async () => true);
    is("a first visit keeps the reading: 2 sales kept, 4400", [kept.record.money?.real, kept.record.money?.cents], [2, 4400]);
    // A day later the reading is stale, and the refunds' range comes back off its shape.
    bend = bendFirst("nl:ppsell:refunded:", "ZRANGEBYSCORE", () => ["1"]);
    const later = await visitPath(store, kept.record, now * 1000 + 86_400_000, async () => true);
    bend = null;
    is("the kept reading stays: the sales are not shown as none", [later.record.money?.real, later.record.money?.cents, later.record.money?.at], [2, 4400, kept.record.money?.at]);
    is("and the facts read from it still count them", later.facts.realSales, 2);
  }

  part("M2 and L3: PayPal refunded part of a sale, or reversed it: the sale is taken off whole");
  {
    const { store, statsId } = await setup();
    captureStatus.set("CAPTURE3", "PARTIALLY_REFUNDED");
    captureStatus.set("CAPTURE1", "REVERSED");
    redis.run(["ZADD", `nl:ppsell:watch:${statsId}`, "1", order(3)]);
    await watchPayPal(store, Date.now() + 60_000, { handOver: async () => undefined, dropStart: async () => undefined });
    is("refunded in part: 2900 left, one real sale", await money(store), [1, 2900]);
    const third = JSON.parse(String(redis.run(["GET", `nl:ppsell:paid:${order(3)}`]))) as Record<string, unknown>;
    is("the record says so, and the order is still watched for a refund in full", [third.takenOff, redis.run(["ZSCORE", `nl:ppsell:watch:${statsId}`, order(3)]) !== null], ["PARTIALLY_REFUNDED", true]);
    redis.run(["ZADD", `nl:ppsell:watch:${statsId}`, "1", order(1)]);
    await watchPayPal(store, Date.now() + 60_000, { handOver: async () => undefined, dropStart: async () => undefined });
    is("reversed: nothing left", await money(store), [0, 0]);
    captureStatus.set("CAPTURE1", "COMPLETED");
    const clean = await setup();
    redis.run(["ZADD", `nl:ppsell:watch:${clean.statsId}`, "1", order(1)]);
    await watchPayPal(clean.store, Date.now() + 60_000, { handOver: async () => undefined, dropStart: async () => undefined });
    const first = JSON.parse(String(redis.run(["GET", `nl:ppsell:paid:${order(1)}`]))) as Record<string, unknown>;
    is("completed: nothing written on the record", first.takenOff, undefined);
  }

  part("N1: with the refund watch off, PayPal's sales are not counted");
  {
    let { store } = await setup();
    sessions = [{ id: "cs_live_pp000001", object: "checkout.session", status: "complete", payment_status: "paid", amount_total: 1000, currency: "usd", created: now - 400, livemode: true, payment_intent: "pi_pp00000001", metadata: { store: "paypalpath", product: "p1" } }];
    is("connected: the Stripe sale and the PayPal ones", await money(store), [3, 5400]);
    store = (await setPayPalSeller(OWNER, null))!;
    is("PayPal disconnected: only the Stripe sale", await money(store), [1, 1000]);
    store = (await setPayPalSeller(OWNER, "OTHERMERCH01"))!;
    is("another PayPal account connected: only the Stripe sale", await money(store), [1, 1000]);
    store = (await setPayPalSeller(OWNER, SELLER))!;
    partnerOff();
    is("the platform's PayPal credentials taken away: only the Stripe sale", await money(store), [1, 1000]);
    partnerOn();
    is("all back: counted again", await money(store), [3, 5400]);
  }

  part("N1b: the refund watch on but refused by PayPal: the sale it cannot see leaves the count");
  {
    let { store, statsId } = await setup();
    sessions = [{ id: "cs_live_pp000003", object: "checkout.session", status: "complete", payment_status: "paid", amount_total: 1000, currency: "usd", created: now - 400, livemode: true, payment_intent: "pi_pp00000003", metadata: { store: "paypalpath", product: "p1" } }];
    const look = async (...ns: number[]) => {
      for (const n of ns) redis.run(["ZADD", `nl:ppsell:watch:${statsId}`, "1", order(n)]);
      await watchPayPal(store, Date.now() + 60_000, { handOver: async () => undefined, dropStart: async () => undefined });
    };
    is("before: the Stripe sale and two PayPal sales", await money(store), [3, 5400]);
    // The seller takes Marktmorgen's permission back inside PayPal, then refunds the 2900 sale there.
    captureRefused.set("CAPTURE1", 403);
    captureStatus.set("CAPTURE1", "REFUNDED");
    for (let i = 0; i < 3; i += 1) await look(1);
    is("403 from PayPal: the 2900 sale leaves the count, the Stripe sale and the 1500 one stay", await money(store), [2, 2500]);
    is("no refund written for it, and it stays watched", [redis.run(["ZSCORE", `nl:ppsell:refunded:${statsId}`, order(1)]), redis.run(["ZSCORE", `nl:ppsell:watch:${statsId}`, order(1)]) !== null], [null, true]);
    captureRefused.set("CAPTURE3", 401);
    await look(3);
    is("401 from PayPal: the 1500 sale leaves too, only the Stripe sale", await money(store), [1, 1000]);
    // The permission given back: PayPal answers again, the refund in full is seen, the 1500 sale counts again.
    captureRefused.clear();
    await look(1, 3);
    is("PayPal answers again: the refunded sale stays off, the other is counted again", await money(store), [2, 2500]);
    is("the refund in full is written down", redis.run(["ZSCORE", `nl:ppsell:refunded:${statsId}`, order(1)]) !== null, true);
    const third = JSON.parse(String(redis.run(["GET", `nl:ppsell:paid:${order(3)}`]))) as Record<string, unknown>;
    is("the record of the one seen again carries no mark", third.blind, undefined);
    // A deployment that asks the wrong PayPal (sandbox about a live capture) gets 404: the same blind watch, so the sale
    // leaves the count until a look succeeds (Claude 6's L-N3 on #3443).
    captureRefused.set("CAPTURE3", 404);
    await look(3);
    is("404 from PayPal (the wrong environment): the 1500 sale leaves the count", await money(store), [1, 1000]);
    captureRefused.clear();
    await look(3);
    is("and counts again once PayPal shows it", await money(store), [2, 2500]);

    ({ store, statsId } = await setup());
    sessions = [];
    captureRefused.set("CAPTURE1", 500);
    await look(1);
    is("PayPal down: the sale it cannot see is not counted", await money(store), [1, 1500]);
    captureRefused.set("CAPTURE1", 200);
    await look(1);
    is("an answer without a status: still not counted", await money(store), [1, 1500]);
    captureRefused.clear();
    await look(1);
    is("completed again: counted", await money(store), [2, 4400]);

    // The write that would count it again is lost, its reply off its shape: the sale stays out, looked at again in an hour.
    ({ store, statsId } = await setup());
    captureRefused.set("CAPTURE1", 403);
    await look(1);
    captureRefused.clear();
    lost = (commands) => commands[0]?.[0] === "SET" && String(commands[0]?.[1]).startsWith("nl:ppsell:paid:");
    await look(1);
    lost = null;
    const score = Number(redis.run(["ZSCORE", `nl:ppsell:watch:${statsId}`, order(1)]));
    is("the clearing write unknown: still not counted, asked again within the hour", [await money(store), score > now && score <= now + 3700], [[1, 1500], true]);
  }

  part("L2: a PayPal refund of a sale the Path did not count is never taken off another sale");
  {
    const { store, statsId } = await setup();
    // A membership's first payment names no payment on its checkout: refunds no counted sale claims are taken off it.
    sessions = [{ id: "cs_live_pp000002", object: "checkout.session", status: "complete", payment_status: "paid", mode: "subscription", amount_total: 2000, currency: "usd", created: now - 400, livemode: true, payment_intent: null, metadata: { store: "paypalpath", product: "p1" } }];
    is("before: the membership and two PayPal sales", await money(store), [3, 6400]);
    writePaid(paid(statsId, 6, 3000, now - 60), false);
    redis.run(["ZADD", `nl:ppsell:refunded:${statsId}`, String(now - 40), order(6)]);
    is("a PayPal sale not read, refunded: the membership still kept", await money(store), [3, 6400]);
  }

  part("L1: PayPal's sales read off their shape are partial, never 'no sales'");
  {
    const { statsId } = await setup();
    bend = bendFirst("nl:ppsell:sales:", "ZREVRANGEBYSCORE", () => ["1"]);
    is("the range not a list: partial", (await readPayPalSales(statsId, 0, 300)).partial, true);
    bend = bendFirst("nl:ppsell:paid:", "MGET", () => [[JSON.stringify(paid(statsId, 1, 2900, now - 300))]]);
    is("fewer records than orders: partial", (await readPayPalSales(statsId, 0, 300)).partial, true);
    bend = null;
    redis.run(["SET", `nl:ppsell:paid:${order(3)}`, "{not json"]);
    const read = await readPayPalSales(statsId, 0, 300);
    is("a record that does not read: left out, and partial", [read.sales.length, read.partial], [2, true]);
  }

  part("The studio says so");
  {
    const notice = readFileSync("components/path-checkout-notice.tsx", "utf8");
    is("Stripe and live PayPal sales, less refunds, toward the first sale and the levels", notice.includes("Path counts your Stripe sales and your live PayPal sales, less refunds, toward your first sale and levels."), true);
  }

  done();
}

main();
