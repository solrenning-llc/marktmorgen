/**
 * A PayPal payment is handed over before it leaves pending, so nothing between writing it down and handing it over
 * can lose it (CX-123 rule 24, money).
 *
 *   1. The return and the sweep hand over first and take the order off pending last: a hand-over that fails, on the
 *      return (which used to only log it) or in the sweep, leaves the order pending, and the sweep hands it over once.
 *   2. The writes after the record take the order off pending as their last write: a pipeline that applied part of
 *      them and then threw never leaves a paid order neither pending nor handed over.
 *   3. The return marks the order pending in the same pipeline as, and before, the record's SET NX: when both that
 *      reply and the fallback watch are lost, a reload that finds the record (not fresh) still leaves the order to
 *      the sweep, which hands it over.
 *
 * Synthetic data only; stand-ins for PayPal's API and the email service.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { addProduct, claimHandle, ensureStatsId, removeProduct, setPayPalSeller, setProductLink, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { plainAmount } from "@/lib/money";
import { addressHash, importedFor } from "@/lib/imported-purchases";
import { captureOrder, openOrder, watchPayPal, type Paid } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const PARTNER_SECRET = "EPpartnerSecret0123456789";
const SELLER = "7KNGBPH2U58GQ";
const BUYER = "buyer@example.com";
process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
process.env.PAYPAL_PARTNER_SECRET = PARTNER_SECRET;
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
process.env.PAYPAL_BN_CODE = "Synthetic_SP";
process.env.RESEND_API_KEY = "re_test_paypal_handover_first";
delete process.env.PAYPAL_ENV;
delete process.env.PAYPAL_API_BASE;

// ------------------------------------------------------------------ stand-ins

// The receipt itself is not sent here (no reviewed mail route in tests); its idempotency key is the order's own.
let made = 0;
const amounts = new Map<string, string>();
const captureId = (order: string) => `CAP${order.slice(-8)}`;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "synthetic-token", expires_in: 3600 });
  const method = init?.method ?? "GET";
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = `5O1901FIRST${String(made).padStart(5, "0")}`;
    const body = JSON.parse(String(init?.body)) as { purchase_units: { amount: { value: string } }[] };
    amounts.set(id, body.purchase_units[0].amount.value);
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] });
  }
  const order = url.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/)?.[1];
  if (!order) return json({ name: "RESOURCE_NOT_FOUND" }, 404);
  return json({
    id: order,
    status: "COMPLETED",
    payer: { email_address: BUYER },
    purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: captureId(order), status: "COMPLETED", amount: { value: amounts.get(order) ?? plainAmount(1500, "usd"), currency_code: "USD" } }] } }],
  });
}) as typeof fetch;

/** Runs `run` with the stand-in Redis answering the pipelines `pick` chooses through `answer` (the rest as they are). */
async function withRedis<T>(
  pick: (commands: (string | number)[][]) => boolean,
  answer: (commands: (string | number)[][], real: (commands: (string | number)[][]) => Promise<unknown[]>) => Promise<unknown[]>,
  run: () => Promise<T>,
): Promise<T> {
  const original = redis.pipeline;
  const real = (commands: (string | number)[][]) => original.call(redis, commands);
  redis.pipeline = (async (commands: (string | number)[][]) => (pick(commands) ? answer(commands, real) : real(commands))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}
const once = (pick: (commands: (string | number)[][]) => boolean) => {
  let left = 1;
  return (commands: (string | number)[][]) => (left > 0 && pick(commands) ? (left--, true) : false);
};
const has = (name: string, prefix: string) => (commands: (string | number)[][]) => commands.some((c) => c[0] === name && String(c[1]).startsWith(prefix));
const writesPaid = has("SET", "nl:ppsell:paid:");
const watchesLater = (commands: (string | number)[][]) => commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:ppsell:o:");
const settledWritesOf = has("ZADD", "nl:ppsell:sales:");
const grants = (commands: (string | number)[][]) => commands.some((c) => c[0] === "EVAL" && c.some((a) => String(a).startsWith("nl:imp:buy:")));
const failed = async (): Promise<never> => {
  throw new Error("Redis request failed with status 502");
};

// ------------------------------------------------------------------ 1. the return route, with the real hand-over

async function shopWithGuide(): Promise<{ store: Store; productId: string }> {
  redis.clear();
  counted = 0;
  const owner = "owner@example.com";
  await claimHandle(owner, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct(owner, "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(owner, added.product.id, "https://example.com/guide");
  await setPayPalSeller(owner, SELLER);
  return { store: (await storeForEmail(owner))!, productId: added.product.id };
}
async function opened(store: Store, productId: string): Promise<string> {
  const product = (await readListing(store, productId))!;
  const result = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!result.ok) throw new Error(`no order: ${result.reason}`);
  return result.order;
}
const returned = (order: string) => paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=harbor&token=${order}`));
const pendingOf = async (statsId: string, order: string) => (await redis.pipeline([["ZSCORE", `nl:ppsell:pending:${statsId}`, order]]))[0];
/** Orders counted in the store's month (lib/orders.ts countOrder): the INCRs of its count, watched as they are sent. */
let counted = 0;
{
  const real = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real.call(redis, commands);
    counted += commands.filter((c) => c[0] === "INCR" && String(c[1]).startsWith("nl:orders:n:")).length;
    return replies;
  }) as typeof redis.pipeline;
}
/** What the buyer was given (read as the store is now: a hand-over marks it as having past buyers), and orders counted. */
const handedOver = async (store: Store) => ({ grants: (await importedFor({ ...store, pastBuyers: true }, BUYER)).length, orders: counted });

test("the return: a hand-over that fails keeps the order pending, the buyer is sent to the thanks page, and the sweep hands it over once", async () => {
  const { store, productId } = await shopWithGuide();
  const order = await opened(store, productId);
  const answer = await withRedis(once(grants), failed, () => returned(order));
  assert.equal(answer.status, 303);
  assert.match(answer.headers.get("Location") ?? "", /\/@harbor\/thanks\?paypal=/);
  assert.notEqual(await pendingOf(store.statsId!, order), null, "kept pending for the sweep, not only logged");
  assert.deepEqual(await handedOver(store), { grants: 0, orders: 0 });
  await sweepPayPal(store, Date.now() + 60_000);
  assert.deepEqual(await handedOver(store), { grants: 1, orders: 1 });
  assert.equal(await pendingOf(store.statsId!, order), null);
  await sweepPayPal(store, Date.now() + 60_000);
  await returned(order);
  assert.deepEqual(await handedOver(store), { grants: 1, orders: 1 }, "exactly once");
});

test("control: the return hands a payment over once, and leaves nothing for the sweep", async () => {
  const { store, productId } = await shopWithGuide();
  const order = await opened(store, productId);
  const answer = await returned(order);
  assert.match(answer.headers.get("Location") ?? "", /\/@harbor\/thanks\?paypal=/);
  assert.deepEqual(await handedOver(store), { grants: 1, orders: 1 });
  assert.equal(await pendingOf(store.statsId!, order), null);
  await sweepPayPal(store, Date.now() + 60_000);
  await returned(order);
  assert.deepEqual(await handedOver(store), { grants: 1, orders: 1 });
});

// ------------------------------------------------------------------ 2. the sweep and captureOrder, with a stand-in hand-over

const sid = "synthetic-paypal-handover-first";
const shop = { statsId: sid, handle: "firstshop", paypalSeller: { merchant: SELLER } } as unknown as Store;
let n = 0;
const nextOrder = () => `5O1901SWEEP${String(++n).padStart(5, "0")}`;
const now = () => Math.floor(Date.now() / 1000);
const ask = async (command: (string | number)[]) => (await redis.pipeline([command]))[0];
const putOpened = (order: string) => ask(["SET", `nl:ppsell:o:${order}`, JSON.stringify({ s: sid, h: "firstshop", p: "p1", c: 1500, cur: "usd", m: SELLER, at: now() }), "EX", 86_400]);
const putPending = (order: string) => ask(["ZADD", `nl:ppsell:pending:${sid}`, String(now()), order]);
async function marks(order: string) {
  return {
    sale: (await ask(["ZSCORE", `nl:ppsell:sales:${sid}`, order])) !== null,
    own: (await ask(["SISMEMBER", `nl:ppsell:own:${sid}:${addressHash(BUYER)}:p1`, order])) === 1,
    watched: (await ask(["ZSCORE", `nl:ppsell:watch:${sid}`, order])) !== null,
    pending: (await ask(["ZSCORE", `nl:ppsell:pending:${sid}`, order])) !== null,
  };
}
const SETTLED = { sale: true, own: true, watched: true, pending: false };
/** A hand-over as the real one behaves: keyed by the order, so a repeat changes nothing; `fail` times it throws first. */
function handOver(given: Set<string>, fail = { times: 0 }) {
  return async (paid: Paid) => {
    if (fail.times > 0) {
      fail.times -= 1;
      throw new Error("the stand-in hand-over failed");
    }
    given.add(paid.order);
  };
}
const sweep = (given: Set<string>, fail = { times: 0 }) => watchPayPal(shop, Date.now() + 60_000, { handOver: handOver(given, fail), dropStart: async () => undefined });

test("the sweep: a hand-over that fails leaves the order pending, and the next pass hands it over", async () => {
  redis.clear();
  const order = nextOrder();
  await putOpened(order);
  await putPending(order);
  const given = new Set<string>();
  assert.equal((await sweep(given, { times: 1 })).stuck, 1, "counted as stuck, the sweep goes on");
  assert.equal((await marks(order)).pending, true, "still pending");
  await sweep(given);
  assert.deepEqual([...given], [order]);
  assert.deepEqual(await marks(order), SETTLED);
});

test("the sweep: settled writes that applied in part and then threw never lose the order", async () => {
  redis.clear();
  const order = nextOrder();
  await putOpened(order);
  await putPending(order);
  const given = new Set<string>();
  const partly = async (commands: (string | number)[][], real: (c: (string | number)[][]) => Promise<unknown[]>) => {
    await real(commands.slice(0, 4));
    return failed();
  };
  assert.equal((await withRedis(once(settledWritesOf), partly, () => sweep(given))).stuck, 1, "counted as stuck, the sweep goes on");
  await sweep(given);
  assert.deepEqual([...given], [order], "handed over");
  assert.deepEqual(await marks(order), SETTLED);
});

test("the return: the record written, its reply lost and the fallback watch lost too: a reload is not 'handed over', the sweep hands it over", async () => {
  redis.clear();
  const order = nextOrder();
  await putOpened(order);
  const lostTwice = async (commands: (string | number)[][], real: (c: (string | number)[][]) => Promise<unknown[]>) => {
    if (writesPaid(commands)) await real(commands);
    return failed();
  };
  const first = await withRedis((c) => writesPaid(c) || watchesLater(c), lostTwice, () => captureOrder(shop, order).catch(() => "failed" as const));
  assert.ok(first === "failed" || !first.ok, "nothing handed over on the return");
  const reload = await captureOrder(shop, order);
  assert.equal(reload.ok && !reload.fresh, true, "the record is found");
  const given = new Set<string>();
  await sweep(given);
  assert.deepEqual([...given], [order], "the sweep hands it over");
  assert.deepEqual(await marks(order), SETTLED);
});

test("captureOrder hands over (when given the hand-over) while the order is still pending, before its settled writes", async () => {
  redis.clear();
  const order = nextOrder();
  await putOpened(order);
  const seen: { pending: boolean; sale: boolean }[] = [];
  const result = await captureOrder(shop, order, async () => {
    const at = await marks(order);
    seen.push({ pending: at.pending, sale: at.sale });
  });
  assert.equal(result.ok && result.fresh, true);
  assert.deepEqual(seen, [{ pending: true, sale: false }]);
  assert.deepEqual(await marks(order), SETTLED);
  const again = await captureOrder(shop, order, async () => void seen.push({ pending: false, sale: false }));
  assert.equal(again.ok && !again.fresh, true);
  assert.equal(seen.length, 1, "not handed over again");
});

test("control: a pending order settled by the sweep is handed over once", async () => {
  redis.clear();
  const order = nextOrder();
  await putOpened(order);
  await putPending(order);
  const calls: string[] = [];
  const given = new Set<string>();
  const counting = async (paid: Paid) => {
    calls.push(paid.order);
    given.add(paid.order);
  };
  await watchPayPal(shop, Date.now() + 60_000, { handOver: counting, dropStart: async () => undefined });
  await watchPayPal(shop, Date.now() + 60_000, { handOver: counting, dropStart: async () => undefined });
  assert.deepEqual(calls, [order]);
  assert.deepEqual(await marks(order), SETTLED);
});

// ------------------------------------------------------------------ 3. one order's hand-over that keeps failing (review of #2895)

// Review proof (#2895, scratchpad rev2871/2895-poison-order.test.ts), kept with credit: the oldest pending order's
// hand-over always throws. It must stay pending without holding back the store's other paid orders or the refund
// watch that runs after the pending ones, pass after pass; the sweep counts it as stuck.
for (const written of [false, true]) {
  test(`a hand-over that keeps failing for one order (${written ? "its record written" : "not yet written"}) never holds back another buyer's order or the refund watch`, async () => {
    redis.clear();
    const stuck = nextOrder();
    const other = nextOrder();
    for (const order of [stuck, other]) await putOpened(order);
    if (written) {
      await ask(["SET", `nl:ppsell:paid:${stuck}`, JSON.stringify({ store: sid, order: stuck, capture: captureId(stuck), email: BUYER, product: "p1", cents: 1500, currency: "usd", at: now(), handle: "firstshop" }), "NX", "EX", 86_400]);
    }
    await ask(["ZADD", `nl:ppsell:pending:${sid}`, String(now() - 60), stuck]);
    await ask(["ZADD", `nl:ppsell:pending:${sid}`, String(now()), other]);
    // A paid order due for its refund check: PayPal's stand-in does not know its capture, so it is looked at again in an hour.
    const watched = nextOrder();
    await ask(["SET", `nl:ppsell:paid:${watched}`, JSON.stringify({ store: sid, order: watched, capture: captureId(watched), email: BUYER, product: "p1", cents: 1500, currency: "usd", at: now() - 7200, handle: "firstshop" }), "NX", "EX", 86_400]);
    await ask(["ZADD", `nl:ppsell:watch:${sid}`, String(now() - 10), watched]);
    const handed: string[] = [];
    const results: unknown[] = [];
    const sweep = () =>
      watchPayPal(shop, Date.now() + 60_000, {
        handOver: async (paid) => {
          if (paid.order === stuck) throw new Error("this order's hand-over keeps failing (say, its product cannot be read)");
          handed.push(paid.order);
        },
        dropStart: async () => undefined,
      }).then((result) => void results.push(result), () => void results.push("threw"));
    for (let pass = 0; pass < 3; pass += 1) await sweep();
    assert.deepEqual(handed, [other], "the other buyer, who paid, is handed over once");
    assert.equal((await marks(stuck)).pending, true, "the stuck order stays pending, asked again next pass");
    assert.ok(Number(await ask(["ZSCORE", `nl:ppsell:watch:${sid}`, watched])) > now() + 3000, "the refund watch after the pending orders ran");
    assert.deepEqual(results, [
      { cleared: 1, revoked: 0, stuck: 1 },
      { cleared: 0, revoked: 0, stuck: 1 },
      { cleared: 0, revoked: 0, stuck: 1 },
    ]);
  });
}

// ------------------------------------------------------------------ 4. a paid order whose product the creator removed (review of #2895)

// Codex Z's proof (codex/z-review-2895-product-gone-proof@53f424a5, tests/z-2895-product-gone.proof.ts) and Claude 5's
// sweep cases (second review of #2895, comment 6701809547), kept with credit: the buyer pays, the creator removes the
// product before the return or the sweep. handOverPayPal hands nothing over and answers false; that false must keep the
// order pending (asked again, counted as stuck), never let it leave pending as if handed over.
/** Puts an opened order on the store's pending list, as a return that heard "pending" or lost its answer does. */
const waitPending = (store: Store, order: string) => redis.pipeline([["ZADD", `nl:ppsell:pending:${store.statsId}`, String(now()), order]]);
async function paidThenRemoved(written: boolean | "return"): Promise<{ store: Store; order: string }> {
  const { store, productId } = await shopWithGuide();
  const order = await opened(store, productId);
  if (written === false) await waitPending(store, order);
  if (written === true) {
    // The record written and its hand-over failed: the order is left pending for the sweep.
    const result = await captureOrder(store, order, async () => {
      throw new Error("this hand-over failed");
    });
    assert.equal(result.ok, false, "precondition: the hand-over failed");
    assert.notEqual(await pendingOf(store.statsId!, order), null, "precondition: kept pending");
  }
  const removed = await removeProduct("owner@example.com", productId);
  assert.equal(removed.ok, true, "precondition: the creator removed the paid product");
  const current = (await storeForEmail("owner@example.com"))!;
  assert.equal(await readListing(current, productId), null, "precondition: the product is gone");
  return { store: current, order };
}

test("the return: a paid order whose product was removed stays pending, nothing is handed over", async () => {
  const { store, order } = await paidThenRemoved("return");
  const answer = await returned(order);
  assert.equal(answer.status, 303);
  assert.match(answer.headers.get("Location") ?? "", /\/@harbor\/thanks\?paypal=/);
  assert.deepEqual(await handedOver(store), { grants: 0, orders: 0 });
  assert.notEqual(await pendingOf(store.statsId!, order), null, "kept pending, not cleared as handed over");
});

for (const written of [false, true]) {
  test(`the sweep: a paid order whose product was removed (${written ? "its record written" : "not yet written"}) stays pending and is counted as stuck, never cleared`, async () => {
    const { store, order } = await paidThenRemoved(written);
    const first = await sweepPayPal(store, Date.now() + 60_000);
    const second = await sweepPayPal(store, Date.now() + 60_000);
    assert.deepEqual(await handedOver(store), { grants: 0, orders: 0 });
    assert.notEqual(await pendingOf(store.statsId!, order), null, "kept pending, asked again next pass");
    assert.deepEqual([first, second], [
      { cleared: 0, revoked: 0, stuck: 1 },
      { cleared: 0, revoked: 0, stuck: 1 },
    ]);
  });
}

test("control: the sweep hands a paid order over once while its product is there", async () => {
  const { store, productId } = await shopWithGuide();
  const order = await opened(store, productId);
  await waitPending(store, order);
  const first = await sweepPayPal(store, Date.now() + 60_000);
  await sweepPayPal(store, Date.now() + 60_000);
  assert.deepEqual(await handedOver(store), { grants: 1, orders: 1 });
  assert.equal(await pendingOf(store.statsId!, order), null);
  assert.deepEqual(first, { cleared: 1, revoked: 0, stuck: 0 });
});
