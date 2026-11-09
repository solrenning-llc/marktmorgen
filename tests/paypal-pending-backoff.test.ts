/**
 * The PayPal sweep's pending orders: a paid order is never hidden behind older ones (Claude 2's MEDIUM on the second
 * money review of #3404, lib/paypal-sales.ts watchPayPal). The sweep read the 25 oldest pending orders of a store every
 * run, by the time they were taken, and left every one it kept where it was: while PayPal did not answer for those 25
 * (an outage, a slow eCheck), an order PayPal had charged but whose writing down failed (the return's step to Redis
 * lost) was never read, and once its record ended (three days from opening) it was dropped unread: the buyer was
 * charged and never handed anything.
 *
 * What is checked, with synthetic orders in the in-memory Redis and a stand-in for PayPal's Orders v2 API:
 *   - each order the sweep keeps is asked again later and later (its score is when it is next asked), and only the
 *     orders whose turn has come are read, so the newer paid order is read and handed over on the next run;
 *   - while an order is pending its record is kept past its three days, never past thirty days from opening;
 *   - a record that cannot be read (another shape) is not taken for a record that ended: the order is kept;
 *   - an order the return wrote down meanwhile is not put back in pending by the sweep (a guard: the old sweep wrote
 *     nothing for a kept order, so it passes before the change too).
 */
import * as sales from "@/lib/paypal-sales";
import { type Paid, watchPayPal } from "@/lib/paypal-sales";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
const STATS = "stpendingbackoff01";
const PENDING = `nl:ppsell:pending:${STATS}`;
const orderKey = (order: string) => `nl:ppsell:o:${order}`;
const DAY = 86_400;

/** Order ids as PayPal makes them (ORDER_ID): the stuck ones, and the one PayPal charged. */
const stuckId = (n: number) => `5O190127TNSTUCK${String(n).padStart(3, "0")}`;
const PAID_ORDER = "5O190127TNPAID0001";

/** What PayPal answers for each order read: the order itself, or nothing (an outage, a timeout). */
const answers = new Map<string, Record<string, unknown>>();
const asked: string[] = [];
let onAsk: (order: string) => void = () => undefined;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") {
    asked.push(read);
    onAsk(read);
    const answer = answers.get(read);
    return answer ? json(answer) : json({ name: "INTERNAL_SERVER_ERROR" }, 500);
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function completed(order: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: "charged@example.com" },
    purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: `CAP${order.slice(-8)}`, status: "COMPLETED", amount: { currency_code: "USD", value: "49.00" } }] } }],
  };
}

/** An order as openOrder writes it (lib/paypal-sales.ts, Opened), opened `age` seconds ago, put in pending at `takenAt`. */
function open(order: string, age: number, takenAt: number): void {
  const at = Math.floor(Date.now() / 1000) - age;
  redis.run(["SET", orderKey(order), JSON.stringify({ s: STATS, h: "harbor", p: "guide01", c: 4900, cur: "usd", m: SELLER, at, meta: {} }), "EX", String(3 * DAY)]);
  redis.run(["ZADD", PENDING, String(takenAt), order]);
}

// Not in lib/paypal-sales.ts before the change: read so the red run shows each failing check (NaN) instead of not building.
const nextPendingLook = (sales as unknown as { nextPendingLook?: (openedAt: number, now: number) => number }).nextPendingLook ?? (() => NaN);

const store = { statsId: STATS, paypalSeller: { merchant: SELLER, at: 1 } } as Store;

async function main(): Promise<void> {
  redis.clear();
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  delete process.env.PAYPAL_ENV;

  const handed: string[] = [];
  const on = { handOver: async (paid: Paid) => void handed.push(paid.order), dropStart: async () => undefined };
  const sweep = () => watchPayPal(store, Date.now() + 30_000, on);
  const now = Math.floor(Date.now() / 1000);

  part("Twenty-five older pending orders PayPal does not answer for do not hide a newer one it charged (the probe)");
  for (let n = 1; n <= 25; n++) open(stuckId(n), 2 * 3600, now - 2 * 3600 + n);
  // Charged by PayPal; the return's step that writes it down never reached Redis, so it waits in pending (#3404).
  open(PAID_ORDER, 600, now - 600);
  answers.set(PAID_ORDER, completed(PAID_ORDER));
  for (let run = 0; run < 3; run++) await sweep();
  is("the charged order is handed over within three runs", handed, [PAID_ORDER]);
  is("and is off pending", redis.run(["ZSCORE", PENDING, PAID_ORDER]), null);
  const stuckScores = Array.from({ length: 25 }, (_, i) => Number(redis.run(["ZSCORE", PENDING, stuckId(i + 1)])));
  is("each order PayPal did not answer for is still pending, asked again later (its score is its next look)", stuckScores.every((s) => s > now), true);
  is("the next look of an order two hours old is half an hour on", stuckScores.every((s) => s >= now + 1800 && s <= now + 1800 + 60), true);

  part("Only the orders whose turn has come are read");
  asked.length = 0;
  await sweep();
  is("no order is asked about before its turn", asked, []);
  redis.run(["ZADD", PENDING, "1", stuckId(7)]);
  await sweep();
  is("one whose turn has come is", asked, [stuckId(7)]);

  part("Asked less and less often, from when it was opened");
  is(
    "five minutes in the first hour, half an hour in the first day, three hours in the first week, then six",
    [nextPendingLook(1000, 1000 + 60), nextPendingLook(1000, 1000 + 2 * 3600), nextPendingLook(1000, 1000 + 2 * DAY), nextPendingLook(1000, 1000 + 20 * DAY)],
    [1000 + 60 + 300, 1000 + 2 * 3600 + 1800, 1000 + 2 * DAY + 3 * 3600, 1000 + 20 * DAY + 6 * 3600],
  );
  is("a time in the future (a clock moved back) is read as just opened", nextPendingLook(5000, 1000), 1300);

  part("A pending order's record is kept while it is pending, never past thirty days from opening");
  const slow = "5O190127TNSLOW0001";
  open(slow, 2 * DAY, now - 2 * DAY);
  await sweep();
  const ttl = Number(redis.run(["TTL", orderKey(slow)]));
  is("kept until thirty days from opening, not its three", ttl > 27 * DAY && ttl <= 28 * DAY, true);
  redis.advance(5 * DAY * 1000);
  answers.set(slow, completed(slow));
  redis.run(["ZADD", PENDING, "1", slow]);
  await sweep();
  is("so PayPal completing it after the three days hands it over", handed.at(-1), slow);
  const old = "5O190127TNOLD00001";
  open(old, 31 * DAY, 1);
  redis.run(["EXPIRE", orderKey(old), String(DAY)]);
  await sweep();
  const oldTtl = Number(redis.run(["TTL", orderKey(old)]));
  is("a record past its thirty days is not kept longer (its own life left as it was)", oldTtl > 0 && oldTtl <= DAY, true);

  part("A record that cannot be read is not a record that ended");
  const unread = "5O190127TNUNREAD01";
  open(unread, 3600, 1);
  const realPipeline = redis.pipeline;
  redis.pipeline = async (commands: (string | number)[][]) => {
    const replies = await realPipeline(commands);
    return replies.map((reply: unknown, i: number) => (commands[i][0] === "GET" && commands[i][1] === orderKey(unread) ? 42 : reply));
  };
  await sweep();
  redis.pipeline = realPipeline;
  const unreadScore = redis.run(["ZSCORE", PENDING, unread]);
  is("still pending, asked again in an hour", unreadScore !== null && Number(unreadScore) >= now + 3600, true);

  part("An order written down meanwhile is not put back in pending");
  const raced = "5O190127TNRACE0001";
  open(raced, 600, 1);
  // The return writes it down (settle takes it off pending) while the sweep is asking PayPal about it, and PayPal's
  // answer to the sweep is lost.
  onAsk = (order) => {
    if (order === raced) redis.run(["ZREM", PENDING, raced]);
  };
  await sweep();
  onAsk = () => undefined;
  is("the sweep's next look does not add it back", redis.run(["ZSCORE", PENDING, raced]), null);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
