/**
 * The PayPal pending sweep, order by order (Claude 1 on #2895, ported onto main's PAYPAL_SETTLE design).
 *
 * 1. Orders that stay pending (PayPal still holds the capture as PENDING) go behind the others after each pass, so a
 *    full window of PAYPAL_WATCH_BATCH of them never keeps a newer completed order from being written down and handed
 *    over. Before: the sweep read the 25 oldest every time and never reached the 26th.
 * 2. A hand-over that throws stops nothing else: the next pending order is still written down and handed over in the
 *    same pass, and the paid order whose hand-over threw stays owed in the hand-over list.
 * Synthetic data only, written as the writers write them.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PAYPAL_WATCH_BATCH, watchPayPal, type Paid } from "@/lib/paypal-sales";
import { plainAmount } from "@/lib/money";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const SELLER = "7KNGBPH2U58GQ";
process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
process.env.PAYPAL_BN_CODE = "Synthetic_SP";
delete process.env.PAYPAL_ENV;
delete process.env.PAYPAL_API_BASE;

const sid = "synthetic-paypal-sweep-isolation";
const shop = { statsId: sid, handle: "sweepshop", paypalSeller: { merchant: SELLER } } as unknown as Store;
const EMAIL = "buyer@example.com";
let n = 0;
const nextOrder = () => `5O1901SWEEP${String(++n).padStart(4, "0")}`;
const now = () => Math.floor(Date.now() / 1000);
const opened = () => ({ s: sid, h: "sweepshop", p: "p1", c: 1500, cur: "usd", m: SELLER, at: now() });

// A stand-in for PayPal: orders in `held` are captured but still PENDING; every other one is COMPLETED in full.
const held = new Set<string>();
const order = (id: string, status: string) => ({
  id,
  status: "COMPLETED",
  payer: { email_address: EMAIL },
  purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: `CAP${id.slice(-6)}`, status, amount: { value: plainAmount(1500, "usd"), currency_code: "USD" } }] } }],
});
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "synthetic-token", expires_in: 3600 });
  const asked = url.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)$/);
  if (asked) {
    return json(order(asked[1], held.has(asked[1]) ? "PENDING" : "COMPLETED"));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const pendingKey = `nl:ppsell:pending:${sid}`;
let at = now() - 10_000;
async function putPendingOrder(id: string) {
  await redis.pipeline([["SET", `nl:ppsell:o:${id}`, JSON.stringify(opened()), "EX", 86_400], ["ZADD", pendingKey, String(at++), id]]);
}
const isPending = async (id: string) => (await redis.pipeline([["ZSCORE", pendingKey, id]]))[0] !== null;
const sweep = (handOver: (paid: Paid) => Promise<void>) => watchPayPal(shop, Date.now() + 60_000, { handOver, dropStart: async () => undefined });

test(`a full window of ${PAYPAL_WATCH_BATCH} orders PayPal still holds never keeps a newer completed one from being handed over`, async () => {
  redis.clear();
  held.clear();
  const stuck = Array.from({ length: PAYPAL_WATCH_BATCH }, nextOrder);
  for (const id of stuck) {
    held.add(id);
    await putPendingOrder(id);
  }
  const later = nextOrder();
  await putPendingOrder(later);
  const handed: string[] = [];
  for (let pass = 0; pass < 2; pass += 1) await sweep(async (paid) => void handed.push(paid.order));
  assert.deepEqual(handed, [later], "the newer completed order is handed over by the second pass");
  assert.equal(await isPending(later), false);
  for (const id of stuck) assert.equal(await isPending(id), true, "the held ones are still asked about");
});

test("control: with fewer than a window of held orders, the completed one is handed over on the first pass", async () => {
  redis.clear();
  held.clear();
  for (let i = 0; i < PAYPAL_WATCH_BATCH - 1; i += 1) {
    const id = nextOrder();
    held.add(id);
    await putPendingOrder(id);
  }
  const later = nextOrder();
  await putPendingOrder(later);
  const handed: string[] = [];
  await sweep(async (paid) => void handed.push(paid.order));
  assert.deepEqual(handed, [later]);
});

test("a hand-over that throws stops nothing else in the pass, and stays owed in the hand-over list", async () => {
  redis.clear();
  held.clear();
  const first = nextOrder();
  const second = nextOrder();
  await putPendingOrder(first);
  await putPendingOrder(second);
  const handed: string[] = [];
  await assert.doesNotReject(
    sweep(async (paid) => {
      if (paid.order === first) throw new Error("synthetic hand-over failure");
      handed.push(paid.order);
    }),
  );
  assert.deepEqual(handed, [second], "the next order is still written down and handed over");
  const [owed] = await redis.pipeline([["ZSCORE", `nl:ppsell:handover:${sid}`, first]]);
  assert.notEqual(owed, null, "the one whose hand-over threw stays owed, for handOverAgain");
  assert.equal(await isPending(first), false, "and it is off pending: written down with every list");
});
