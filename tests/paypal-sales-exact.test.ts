/**
 * PayPal selling's Redis reads and PayPal's seller status in their exact shape (CX-123 rules 24 and 30).
 *
 * An order's opened record, a paid record, a pending mark, the sales list and its records, a person's orders, the
 * SET NX that writes a payment down, the kept counts and the seller's granted permissions: a reply that is missing,
 * cut short, of another type or with a slot too many is unknown. It is never "no record" (an order dropped from the
 * pending sweep, a payer told their order is not found, a buyer left out of a copy or a mailing), never a fresh
 * write (a hand-over on a reply nobody read) and never a count of 0. A record that is really gone (GET null, an
 * empty list) is still a known absence. Synthetic data only, written as the writers write it.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  captureOrder,
  checkSeller,
  paypalCounts,
  paypalOrdersOf,
  readPaid,
  readPayPalSales,
  stillPending,
  watchPayPal,
  type Paid,
} from "@/lib/paypal-sales";
import { plainAmount } from "@/lib/money";
import { addressHash } from "@/lib/imported-purchases";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const PARTNER = "PARTNERMERCH01";
const CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
process.env.PAYPAL_PARTNER_CLIENT_ID = CLIENT;
process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
process.env.PAYPAL_PARTNER_MERCHANT_ID = PARTNER;
process.env.PAYPAL_BN_CODE = "Synthetic_SP";
delete process.env.PAYPAL_ENV;
delete process.env.PAYPAL_API_BASE;

const sid = "synthetic-paypal-sales-exact";
const shop = { statsId: sid, handle: "exactshop", paypalSeller: { merchant: SELLER } } as unknown as Store;
const EMAIL = "buyer@example.com";
let n = 0;
const nextOrder = () => `5O1901EXACT${String(++n).padStart(4, "0")}`;
const now = () => Math.floor(Date.now() / 1000);
const opened = () => ({ s: sid, h: "exactshop", p: "p1", c: 1500, cur: "usd", m: SELLER, at: now() });
const paidOf = (order: string, at = now()): Paid => ({ store: sid, order, capture: `CAP${order.slice(-6)}`, email: EMAIL, product: "p1", cents: 1500, currency: "usd", at, handle: "exactshop" });

// A stand-in for PayPal: every order is captured in full, as asked, into the creator's account.
const calls: string[] = [];
let integration: Record<string, unknown> = {};
const completed = (order: string) => ({
  id: order,
  status: "COMPLETED",
  payer: { email_address: EMAIL },
  purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: `CAP${order.slice(-6)}`, status: "COMPLETED", amount: { value: plainAmount(1500, "usd"), currency_code: "USD" } }] } }],
});
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  calls.push(`${method} ${url.pathname}`);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "synthetic-token", expires_in: 3600 });
  const capture = url.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/);
  if (capture) return json(completed(capture[1]));
  if (url.pathname.endsWith("/merchant-integrations")) return json({ merchant_id: SELLER });
  if (url.pathname.endsWith(`/merchant-integrations/${SELLER}`)) return json(integration);
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const paypalAsked = () => calls.filter((c) => !c.endsWith("/v1/oauth2/token"));

/**
 * The stand-in Redis, with the replies from the first matching command on replaced in each pipeline that has one; the
 * commands before it (the return's pending mark before its SET NX) run and answer as they are.
 */
async function withReply<T>(match: (command: (string | number)[]) => boolean, reply: () => unknown[], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const at = commands.findIndex(match);
    if (at < 0) return original.call(redis, commands);
    return [...(at > 0 ? await original.call(redis, commands.slice(0, at)) : []), ...reply()];
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}
const is = (name: string, prefix: string) => (c: (string | number)[]) => c[0] === name && String(c[1]).startsWith(prefix);
const GET_OPENED = is("GET", "nl:ppsell:o:");
const GET_PAID = is("GET", "nl:ppsell:paid:");
const SET_PAID = is("SET", "nl:ppsell:paid:");
const pendingScore = async (order: string) => (await redis.pipeline([["ZSCORE", `nl:ppsell:pending:${sid}`, order]]))[0];
const putOpened = (order: string) => redis.pipeline([["SET", `nl:ppsell:o:${order}`, JSON.stringify(opened()), "EX", 86_400]]);
const putPending = (order: string) => redis.pipeline([["ZADD", `nl:ppsell:pending:${sid}`, String(now()), order]]);
const putPaid = (paid: Paid) => redis.pipeline([["SET", `nl:ppsell:paid:${paid.order}`, JSON.stringify(paid), "NX", "EX", 86_400]]);
const sweep = (handed: Paid[]) =>
  watchPayPal(shop, Date.now() + 60_000, { handOver: async (paid) => void handed.push(paid), dropStart: async () => undefined });
redis.clear();

// ------------------------------------------------------------------ 1. the pending sweep (readOpened, readPaid, settle)

const openedReplies: [string, () => unknown[]][] = [
  ["a missing envelope", () => []],
  ["a number for the record", () => [42]],
  ["text that is not JSON", () => ["{"]],
  ["JSON null", () => ["null"]],
  ["a record without its store", () => ["{}"]],
  ["a slot too many", () => [JSON.stringify(opened()), "extra"]],
];
for (const [label, reply] of openedReplies) {
  test(`the sweep keeps a pending order whose opened record answers ${label}, and asks PayPal nothing`, async () => {
    redis.clear();
    calls.length = 0;
    const order = nextOrder();
    await putOpened(order);
    await putPending(order);
    const handed: Paid[] = [];
    await withReply(GET_OPENED, reply, () => sweep(handed));
    assert.notEqual(await pendingScore(order), null, "still pending");
    assert.deepEqual(paypalAsked(), []);
    assert.deepEqual(handed, []);
  });
}

for (const [label, reply] of [["a missing envelope", () => []], ["text that is not JSON", () => ["{"]], ["a number", () => [7]]] as const) {
  test(`the sweep keeps a pending order whose paid record answers ${label}, and hands nothing over`, async () => {
    redis.clear();
    calls.length = 0;
    const order = nextOrder();
    await putOpened(order);
    await putPending(order);
    const handed: Paid[] = [];
    await withReply(GET_PAID, reply, () => sweep(handed));
    assert.notEqual(await pendingScore(order), null, "still pending");
    assert.deepEqual(handed, []);
  });
}

const setReplies: [string, () => unknown[]][] = [
  ["a missing envelope", () => []],
  ["another word than OK", () => ["QUEUED"]],
  ["a number", () => [1]],
  ["a slot too many", () => ["OK", "extra"]],
];
for (const [label, reply] of setReplies) {
  test(`the sweep hands nothing over when writing the payment down answers ${label}`, async () => {
    redis.clear();
    const order = nextOrder();
    await putOpened(order);
    await putPending(order);
    const handed: Paid[] = [];
    await withReply(SET_PAID, reply, () => sweep(handed));
    assert.deepEqual(handed, []);
    assert.notEqual(await pendingScore(order), null, "still pending, asked again");
  });
  test(`the return hands nothing over when writing the payment down answers ${label}`, async () => {
    redis.clear();
    const order = nextOrder();
    await putOpened(order);
    const result = await withReply(SET_PAID, reply, () => captureOrder(shop, order));
    assert.deepEqual(result, { ok: false, reason: "error" });
    assert.notEqual(await pendingScore(order), null, "watched, for the sweep to settle");
  });
}

test("controls: the sweep drops an order whose opened record is gone, and settles a completed one once", async () => {
  redis.clear();
  calls.length = 0;
  const gone = nextOrder();
  await putPending(gone);
  const handed: Paid[] = [];
  await sweep(handed);
  assert.equal(await pendingScore(gone), null, "a record that is really gone ends the wait");
  assert.deepEqual(paypalAsked(), []);
  const order = nextOrder();
  await putOpened(order);
  await putPending(order);
  await sweep(handed);
  assert.equal(handed.length, 1);
  assert.equal(handed[0].order, order);
  assert.equal(await pendingScore(order), null);
  await sweep(handed);
  assert.equal(handed.length, 1, "settled and off pending: not handed over again");
});

test("controls: the return writes a payment down once, and the second time is not fresh", async () => {
  redis.clear();
  const order = nextOrder();
  await putOpened(order);
  const first = await captureOrder(shop, order);
  assert.equal(first.ok && first.fresh, true);
  const again = await captureOrder(shop, order);
  assert.equal(again.ok && !again.fresh, true);
});

// ------------------------------------------------------------------ 2. the thanks page's reads (readPaid, stillPending)

const paidReplies = (order: string): [string, () => unknown[]][] => [
  ["a missing envelope", () => []],
  ["a number", () => [42]],
  ["text that is not JSON", () => ["{"]],
  ["JSON null", () => ["null"]],
  ["a list", () => ["[]"]],
  ["another order's record", () => [JSON.stringify(paidOf("5O1901OTHER0001"))]],
  ["a slot too many", () => [JSON.stringify(paidOf(order)), "extra"]],
];
for (const [label, reply] of paidReplies("5O1901READ00001")) {
  test(`readPaid rejects ${label} rather than "no such order"`, async () => {
    await withReply(GET_PAID, reply, () => assert.rejects(() => readPaid("5O1901READ00001")));
  });
}
test(`the return asks PayPal to take nothing when the paid record is unknown`, async () => {
  redis.clear();
  calls.length = 0;
  const order = nextOrder();
  await putOpened(order);
  const result = await withReply(GET_PAID, () => ["{"], () => captureOrder(shop, order));
  assert.deepEqual(result, { ok: false, reason: "unknown" });
  assert.deepEqual(paypalAsked(), []);
});

for (const [label, reply] of [["a missing envelope", () => []], ["a number", () => [5]], ["a score that is not whole seconds", () => ["abc"]], ["a slot too many", () => ["1760000000", "x"]]] as const) {
  test(`stillPending rejects ${label} rather than "not waited on"`, async () => {
    await withReply(is("ZSCORE", "nl:ppsell:pending:"), reply, () => assert.rejects(() => stillPending(shop, "5O1901READ00001")));
  });
}

test("controls: a paid record reads exactly, a missing one is null, and pending reads as it is", async () => {
  redis.clear();
  const order = nextOrder();
  const paid = paidOf(order);
  await putPaid(paid);
  assert.deepEqual(await readPaid(order), paid);
  assert.equal(await readPaid(nextOrder()), null);
  const waiting = nextOrder();
  await putPending(waiting);
  assert.equal(await stillPending(shop, waiting), true);
  assert.equal(await stillPending(shop, nextOrder()), false);
});

// ------------------------------------------------------------------ 3. the sales list (readPayPalSales)

const salesKey = `nl:ppsell:sales:${sid}`;
async function twoSales(): Promise<Paid[]> {
  redis.clear();
  const a = paidOf(nextOrder(), now() - 200);
  const b = paidOf(nextOrder(), now() - 100);
  for (const p of [a, b]) {
    await putPaid(p);
    await redis.pipeline([["ZADD", salesKey, String(p.at), p.order]]);
  }
  return [b, a];
}
const rangeReplies: [string, () => unknown[]][] = [
  ["a missing envelope", () => []],
  ["a null list", () => [null]],
  ["text for the list", () => ["x"]],
  ["a member that is not text", () => [[42]]],
  ["a slot too many", () => [[], "extra"]],
];
for (const [label, reply] of rangeReplies) {
  test(`the sales list rejects ${label} rather than "no PayPal sales"`, async () => {
    await twoSales();
    await withReply(is("ZREVRANGEBYSCORE", "nl:ppsell:sales:"), reply, () => assert.rejects(() => readPayPalSales(sid, 0, 100)));
  });
}
const mgetReplies: [string, () => unknown[]][] = [
  ["a missing envelope", () => []],
  ["a null list", () => [null]],
  ["a list one short", () => [["{}"]]],
  ["a list one too long", () => [[null, null, null]]],
  ["a record that is not text", () => [[42, null]]],
  ["a slot too many", () => [[null, null], "extra"]],
];
for (const [label, reply] of mgetReplies) {
  test(`the sales' records reject ${label} rather than leaving sales out`, async () => {
    await twoSales();
    await withReply((c) => c[0] === "MGET", reply, () => assert.rejects(() => readPayPalSales(sid, 0, 100)));
  });
}
test("a sale whose record does not read makes the list partial, never complete without it; one whose record ended is gone", async () => {
  const [b] = await twoSales();
  const broken = await withReply((c) => c[0] === "MGET", () => [[JSON.stringify(b), "{"]], () => readPayPalSales(sid, 0, 100));
  assert.deepEqual(broken, { sales: [b], partial: true });
  // GET/MGET null is Redis's own word that the record ended (kept 400 days, as the list is): a known absence.
  const gone = await withReply((c) => c[0] === "MGET", () => [[JSON.stringify(b), null]], () => readPayPalSales(sid, 0, 100));
  assert.deepEqual(gone, { sales: [b], partial: false });
});
test("controls: the sales read exactly, none is none, and more than the limit is partial", async () => {
  const both = await twoSales();
  assert.deepEqual(await readPayPalSales(sid, 0, 100), { sales: both, partial: false });
  assert.deepEqual(await readPayPalSales(sid, 0, 1), { sales: [both[0]], partial: true });
  assert.deepEqual(await readPayPalSales("synthetic-paypal-sales-none", 0, 100), { sales: [], partial: false });
});

// ------------------------------------------------------------------ 4. a person's orders (paypalOrdersOf)

const ownKey = `nl:ppsell:own:${sid}:${addressHash(EMAIL)}:p1`;
const smembersReplies: [string, () => unknown[]][] = [
  ["a missing envelope", () => []],
  ["a null set", () => [null]],
  ["text for the set", () => ["x"]],
  ["a member that is not text", () => [[42]]],
  ["a member that is not an order", () => [["not-an-order"]]],
  ["a slot too many", () => [[], "extra"]],
];
for (const [label, reply] of smembersReplies) {
  test(`a person's orders reject ${label} rather than leaving orders out of their copy`, async () => {
    await withReply(is("SMEMBERS", "nl:ppsell:own:"), reply, () => assert.rejects(() => paypalOrdersOf(sid, ["p1"], EMAIL)));
  });
}
test("a person's orders reject a paid record that does not read", async () => {
  redis.clear();
  const order = nextOrder();
  await redis.pipeline([["SADD", ownKey, order]]);
  await putPaid(paidOf(order));
  await withReply(GET_PAID, () => ["{"], () => assert.rejects(() => paypalOrdersOf(sid, ["p1"], EMAIL)));
});
test("controls: a person's orders read exactly, and none is none", async () => {
  redis.clear();
  const order = nextOrder();
  const paid = paidOf(order);
  await redis.pipeline([["SADD", ownKey, order]]);
  await putPaid(paid);
  assert.deepEqual(await paypalOrdersOf(sid, ["p1"], EMAIL), [paid]);
  assert.deepEqual(await paypalOrdersOf(sid, ["p1"], "nobody@example.com"), []);
});

// ------------------------------------------------------------------ 5. the counts (paypalCounts)

for (const [label, reply] of [["a missing envelope", () => []], ["a reply cut short", () => [1]], ["a null count", () => [null, 1]], ["a count as text", () => ["1", 1]], ["a negative count", () => [-1, 1]], ["a slot too many", () => [1, 1, 1]]] as const) {
  test(`the PayPal counts are unknown (null) for ${label}, never 0`, async () => {
    await withReply((c) => c[0] === "ZCARD", reply, async () => assert.equal(await paypalCounts(sid), null));
  });
}
test("controls: the counts read as kept, 0 for none", async () => {
  await twoSales();
  assert.deepEqual(await paypalCounts(sid), { sales: 2, refunds: 0 });
  assert.deepEqual(await paypalCounts("synthetic-paypal-sales-none"), { sales: 0, refunds: 0 });
});

// ------------------------------------------------------------------ 6. the seller's permissions (checkSeller)

const third = { integration_type: "OAUTH_THIRD_PARTY", oauth_third_party: [{ partner_client_id: CLIENT }] };
const base = { merchant_id: SELLER, tracking_id: sid, payments_receivable: true, primary_email_confirmed: true };
for (const [label, value] of [["absent", undefined], ["null", null], ["text", "x"], ["an object", {}]] as const) {
  test(`a seller whose permissions PayPal answers as ${label} is an error, never "permissions not granted"`, async () => {
    integration = value === undefined ? { ...base } : { ...base, oauth_integrations: value };
    assert.deepEqual(await checkSeller(sid), { ok: false, reason: "error" });
  });
}
test("controls: no permissions granted, and granted", async () => {
  integration = { ...base, oauth_integrations: [] };
  assert.deepEqual(await checkSeller(sid), { ok: false, reason: "permissions" });
  integration = { ...base, oauth_integrations: [third] };
  assert.deepEqual(await checkSeller(sid), { ok: true, merchant: SELLER });
});
