/**
 * A PayPal payment written down but never handed over is handed over by the sweep, exactly once (CX-123 rule 24).
 *
 * The payment's record (SET NX) can be written while its reply is lost: the reply is unknown, or the request throws
 * after Redis applied it. The order is then kept pending for the sweep. The sweep used to read "a record is there"
 * as "already handed over" and drop the order from pending, so a buyer who paid was never given what they bought.
 * Now a pending order whose record is written is asked about again: completed on PayPal, it is handed over (each
 * hand-over step is keyed by the order, so a repeat changes nothing), then written as settled and leaves pending.
 * Synthetic data only; a stand-in for PayPal's API.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { captureOrder, watchPayPal, type Paid } from "@/lib/paypal-sales";
import { plainAmount } from "@/lib/money";
import { addressHash } from "@/lib/imported-purchases";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const SELLER = "7KNGBPH2U58GQ";
process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
process.env.PAYPAL_BN_CODE = "Synthetic_SP";
delete process.env.PAYPAL_ENV;
delete process.env.PAYPAL_API_BASE;

const sid = "synthetic-paypal-handover";
const shop = { statsId: sid, handle: "handshop", paypalSeller: { merchant: SELLER } } as unknown as Store;
const EMAIL = "buyer@example.com";
let n = 0;
const nextOrder = () => `5O1901HAND${String(++n).padStart(5, "0")}`;
const now = () => Math.floor(Date.now() / 1000);
const captureId = (order: string) => `CAP${order.slice(-6)}`;
const opened = () => ({ s: sid, h: "handshop", p: "p1", c: 1500, cur: "usd", m: SELLER, at: now() });

// PayPal's stand-in: "completed" captures in full as asked, "refunded" answers the capture refunded, "down" fails.
let paypal: "completed" | "refunded" | "down" = "completed";
// Run once while PayPal is being asked (GET) about this order: what another request does meanwhile.
let onGet: { order: string; run: () => Promise<void> } | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "synthetic-token", expires_in: 3600 });
  if (paypal === "down") return new Response("{}", { status: 503 });
  const order = url.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)/)?.[1];
  if (!order) return new Response("{}", { status: 404 });
  if (onGet && onGet.order === order && (init?.method ?? "GET") === "GET") {
    const hook = onGet;
    onGet = null;
    await hook.run();
  }
  const status = paypal === "refunded" ? "REFUNDED" : "COMPLETED";
  return json({
    id: order,
    status: "COMPLETED",
    payer: { email_address: EMAIL },
    purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: captureId(order), status, amount: { value: plainAmount(1500, "usd"), currency_code: "USD" } }] } }],
  });
}) as typeof fetch;

const ask = async (command: (string | number)[]) => (await redis.pipeline([command]))[0];
const pending = (order: string) => ask(["ZSCORE", `nl:ppsell:pending:${sid}`, order]);
const putOpened = (order: string) => ask(["SET", `nl:ppsell:o:${order}`, JSON.stringify(opened()), "EX", 86_400]);
const putPending = (order: string) => ask(["ZADD", `nl:ppsell:pending:${sid}`, String(now()), order]);
/** The record as settle writes it, alone: the writes after it (and so the hand-over) never confirmed. */
const putWritten = (order: string): Promise<unknown> =>
  ask(["SET", `nl:ppsell:paid:${order}`, JSON.stringify({ store: sid, order, capture: captureId(order), email: EMAIL, product: "p1", cents: 1500, currency: "usd", at: now(), handle: "handshop" }), "NX", "EX", 86_400]);
/** What a settled order leaves: counted in the sales, in the buyer's orders, and watched for a refund. */
async function settledMarks(order: string) {
  return {
    sale: (await ask(["ZSCORE", `nl:ppsell:sales:${sid}`, order])) !== null,
    own: (await ask(["SISMEMBER", `nl:ppsell:own:${sid}:${addressHash(EMAIL)}:p1`, order])) === 1,
    watched: (await ask(["ZSCORE", `nl:ppsell:watch:${sid}`, order])) !== null,
    pending: (await pending(order)) !== null,
  };
}
const SETTLED = { sale: true, own: true, watched: true, pending: false };
function sweeper(handed: Paid[], fail = { times: 0 }) {
  return () =>
    watchPayPal(shop, Date.now() + 60_000, {
      handOver: async (paid) => {
        if (fail.times > 0) {
          fail.times -= 1;
          throw new Error("the stand-in hand-over failed");
        }
        handed.push(paid);
      },
      dropStart: async () => undefined,
    });
}
/** The stand-in Redis, with the payment's SET NX applied and then its reply lost (`lost`). */
async function writeThenLose<T>(lost: "unknown" | "throws", run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original.call(redis, commands);
    if (commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:ppsell:paid:"))) {
      if (lost === "throws") throw new Error("Redis request failed with status 502");
      return [...replies.slice(0, -1), "QUEUED"];
    }
    return replies;
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

for (const lost of ["unknown", "throws"] as const) {
  test(`a payment written down on the return with its reply ${lost === "unknown" ? "unknown" : "thrown after it applied"} is handed over by the sweep, once`, async () => {
    redis.clear();
    paypal = "completed";
    const order = nextOrder();
    await putOpened(order);
    const result = await writeThenLose(lost, () => captureOrder(shop, order));
    assert.deepEqual(result, { ok: false, reason: "error" }, "nothing handed over on the return");
    assert.notEqual(await pending(order), null, "kept for the sweep");
    const handed: Paid[] = [];
    const sweep = sweeper(handed);
    await sweep();
    assert.deepEqual(handed.map((p) => p.order), [order], "handed over");
    assert.deepEqual(await settledMarks(order), SETTLED);
    await sweep();
    await captureOrder(shop, order);
    assert.equal(handed.length, 1, "exactly once");
  });
}

test("a pending order whose record was written by an interrupted sweep is handed over once, as written", async () => {
  redis.clear();
  paypal = "completed";
  const order = nextOrder();
  await putOpened(order);
  await putPending(order);
  await putWritten(order);
  const handed: Paid[] = [];
  const sweep = sweeper(handed);
  await sweep();
  assert.equal(handed.length, 1);
  assert.equal(handed[0].order, order);
  assert.equal(handed[0].capture, captureId(order));
  assert.deepEqual(await settledMarks(order), SETTLED);
  await sweep();
  assert.equal(handed.length, 1, "exactly once");
});

test("a hand-over that fails leaves the order pending, and the next pass hands it over once", async () => {
  redis.clear();
  paypal = "completed";
  const order = nextOrder();
  await putOpened(order);
  await putPending(order);
  await putWritten(order);
  const handed: Paid[] = [];
  const sweep = sweeper(handed, { times: 1 });
  assert.equal((await sweep()).stuck, 1, "counted as stuck, the sweep goes on");
  assert.notEqual(await pending(order), null, "still pending");
  await sweep();
  await sweep();
  assert.equal(handed.length, 1);
  assert.deepEqual(await settledMarks(order), SETTLED);
});

test("a written order PayPal cannot be asked about stays pending, with nothing handed over", async () => {
  redis.clear();
  paypal = "down";
  const order = nextOrder();
  await putOpened(order);
  await putPending(order);
  await putWritten(order);
  const handed: Paid[] = [];
  await sweeper(handed)();
  assert.deepEqual(handed, []);
  assert.notEqual(await pending(order), null, "asked again next pass");
  paypal = "completed";
});

test("controls: a written order PayPal says was refunded is not handed over; one never written is settled and handed over once", async () => {
  redis.clear();
  paypal = "refunded";
  const refunded = nextOrder();
  await putOpened(refunded);
  await putPending(refunded);
  await putWritten(refunded);
  const handed: Paid[] = [];
  const sweep = sweeper(handed);
  await sweep();
  assert.equal(handed.length, 0, "nothing handed over");
  assert.equal(await pending(refunded), null);
  paypal = "completed";
  const order = nextOrder();
  await putOpened(order);
  await putPending(order);
  await sweep();
  await sweep();
  assert.deepEqual(handed.map((p) => p.order), [order]);
  assert.deepEqual(await settledMarks(order), SETTLED);
});

test("a hand-over that fails on one pending order never stops the store's other orders (Claude 5 on #2871)", async () => {
  redis.clear();
  paypal = "completed";
  const failing = nextOrder();
  const other = nextOrder();
  for (const order of [failing, other]) {
    await putOpened(order);
    await putPending(order);
    await putWritten(order);
  }
  const handed: Paid[] = [];
  await sweeper(handed, { times: 1 })();
  assert.deepEqual(handed.map((p) => p.order), [other], "the other order is handed over in the same pass");
  assert.notEqual(await pending(failing), null, "the failed one stays pending");
  await sweeper(handed)();
  assert.deepEqual(handed.map((p) => p.order).sort(), [failing, other].sort(), "and is handed over once next pass");
});

test("the sweep never hands over again an order the buyer's return settled while the sweep's list was being read (Claude 5 on #2871)", async () => {
  redis.clear();
  paypal = "completed";
  const first = nextOrder();
  const order = nextOrder();
  for (const o of [first, order]) {
    await putOpened(o);
    await putPending(o);
  }
  const handed: Paid[] = [];
  onGet = {
    order: first,
    run: async () => {
      const returned = await captureOrder(shop, order);
      if (returned.ok && returned.fresh) handed.push(returned.paid);
    },
  };
  await sweeper(handed)();
  onGet = null;
  assert.equal(handed.filter((p) => p.order === order).length, 1, "handed over once, by the return");
  assert.equal(handed.filter((p) => p.order === first).length, 1, "the other order once, by the sweep");
  assert.deepEqual(await settledMarks(order), SETTLED);
});

test("whether a written order is still pending, read in an unknown shape, hands nothing over and keeps it pending", async () => {
  redis.clear();
  paypal = "completed";
  const order = nextOrder();
  await putOpened(order);
  await putPending(order);
  await putWritten(order);
  const handed: Paid[] = [];
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.length === 1 && commands[0][0] === "ZSCORE" && commands[0][1] === `nl:ppsell:pending:${sid}` && commands[0][2] === order
      ? []
      : original.call(redis, commands)) as typeof redis.pipeline;
  try {
    await sweeper(handed)();
  } finally {
    redis.pipeline = original;
  }
  assert.equal(handed.length, 0, "nothing handed over on a guess");
  assert.notEqual(await pending(order), null, "still pending");
  await sweeper(handed)();
  assert.deepEqual(handed.map((p) => p.order), [order], "handed over once when it can be read");
});

test("control: the return writes a payment down once; nothing is left pending for the sweep to hand over again", async () => {
  redis.clear();
  paypal = "completed";
  const order = nextOrder();
  await putOpened(order);
  const first = await captureOrder(shop, order);
  assert.equal(first.ok && first.fresh, true);
  const handed: Paid[] = [];
  await sweeper(handed)();
  assert.deepEqual(handed, []);
  const again = await captureOrder(shop, order);
  assert.equal(again.ok && !again.fresh, true);
  assert.deepEqual(await settledMarks(order), SETTLED);
});
