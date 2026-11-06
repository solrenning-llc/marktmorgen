/**
 * REVIEW PROOF (#2871/#2895): one pending order whose hand-over keeps failing (it throws out of watchPayPal, unguarded)
 * stops every later pending order of the store from being handed over, pass after pass.
 * Original header follows. A PayPal payment written down but never handed over is handed over by the sweep, exactly once (CX-123 rule 24).
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
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "synthetic-token", expires_in: 3600 });
  if (paypal === "down") return new Response("{}", { status: 503 });
  const order = url.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)/)?.[1];
  if (!order) return new Response("{}", { status: 404 });
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


test("REVIEW: a hand-over that keeps failing for one order never holds back another buyer's paid order", async () => {
  redis.clear();
  paypal = "completed";
  const stuck = nextOrder();
  const other = nextOrder();
  for (const order of [stuck, other]) await putOpened(order);
  if (process.env.REV_WRITTEN) await putWritten(stuck);
  await ask(["ZADD", `nl:ppsell:pending:${sid}`, String(now() - 60), stuck]);
  await ask(["ZADD", `nl:ppsell:pending:${sid}`, String(now()), other]);
  const handed: string[] = [];
  const sweep = () =>
    watchPayPal(shop, Date.now() + 60_000, {
      handOver: async (paid) => {
        if (paid.order === stuck) throw new Error("this order's hand-over keeps failing (say, its product cannot be read)");
        handed.push(paid.order);
      },
      dropStart: async () => undefined,
    }).catch(() => undefined);
  for (let pass = 0; pass < 3; pass += 1) await sweep();
  assert.deepEqual(handed, [other], "the other buyer, who paid, is handed over");
});
