/**
 * Three residual findings of the money reviews of #3404 (row #3404 of #5285), each held here with a synthetic world:
 *
 * 1. MEDIUM (Claude 6's second money review of #3404, head-of-line; the residual after #3392's LEVE 1): the pending
 *    sweep reads the oldest PENDING_SWEEP_BATCH orders of a store's pending list. An order it could not finish this run
 *    went to the back of the list on most paths (later(), ZADD XX now), but four paths only skipped it: its opened
 *    record not read, its paid record not read, PayPal's answer naming another order, and the step that writes a paid
 *    order down answering in a shape not known. A batch of such orders kept every newer pending order, paid ones among
 *    them, out of every sweep until their records ended. Now each goes to the back of the line too.
 * 2. LOW 2 (Claude 6's second money review of #3404, with Claude 3's LOW 2): a declined capture let go of the order's
 *    pending entry whenever its own watchFirst had added it, even when another return had since counted a try and was
 *    taking the payment under the same entry. Now the entry is let go of only while no other try has been counted.
 * 3. NIT (same review): the return page let an error captureOrder does not turn into an answer (a Redis connection
 *    failure) become a bare server error. Now the buyer is sent to the store's notice, as for an answer not known.
 *
 * Synthetic only: a stand-in for PayPal's API and Resend, the in-memory Redis, the real capture, sweep and return route.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, readPaid, stillPending, watchPayPal } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";
import { COMMAND, ORDER_COMPUTE, PAYPAL_CAPTURE_WATCH } from "./plan-cost-registry";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const PARTNER_SECRET = "EPpartnerSecret0123456789";
const SELLER = "7KNGBPH2U58GQ";

type Answer = { status: number; body: Record<string, unknown> };
/** What each capture does: an answer, at once or once the test lets it come back. */
let captureWith: (order: string) => Answer | Promise<Answer> = () => ({ status: 500, body: {} });
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `5O190127TN36473${String(n).padStart(2, "0")}`;

function completed(order: string, value: string, status = "COMPLETED", email = "Buyer@Example.com"): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [
      {
        reference_id: "x",
        payee: { merchant_id: SELLER },
        payments: { captures: [{ id: `3C679366HH9089${order.slice(-2)}`, status, amount: { currency_code: "USD", value } }] },
      },
    ],
  };
}
const declined = (): Answer => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } });

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
    const answer = await captureWith(capture);
    if (answer.status < 300) orders.set(capture, answer.body);
    return json(answer.body, answer.status);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

type Commands = (string | number)[][];
const settleOf = (commands: Commands, order: string) =>
  commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("marktmorgen:paypal-settle") && c.map(String).includes(order));
const pendingWrite = (commands: Commands) => commands.some((c) => c[0] === "ZADD" && String(c[1]).startsWith("nl:ppsell:pending:"));

/** Runs `body` with every Redis pipeline passed through `fault` first (null: sent as it is). */
async function withRedis<T>(fault: (commands: Commands) => unknown[] | Promise<unknown[]> | null, body: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Commands) => (await fault(commands)) ?? real(commands)) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = real;
  }
}

/** A promise and the function that settles it. */
function signal<T = void>(): { wait: Promise<T>; fire: (value: T) => void } {
  let fire!: (value: T) => void;
  const wait = new Promise<T>((resolve) => (fire = resolve));
  return { wait, fire };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_paypal_requeue";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = PARTNER_SECRET;
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  const logged = console.error;

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store: Store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;
  const pendingKey = `nl:ppsell:pending:${store.statsId}`;
  let handed: string[] = [];
  const on = { handOver: async (p: { order: string }) => void handed.push(p.order), dropStart: async () => undefined };
  const open = async () => {
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error("no order");
    return opened.order;
  };

  // 1. MEDIUM: every path that keeps an order for a later run sends it to the back of the line.
  const kinds = ["its opened record does not read", "its paid record does not read", "PayPal's answer names another order", "writing it down answers in a shape not known"] as const;
  for (const [k, kind] of kinds.entries()) {
    part(`A batch of pending orders kept because ${kind} never holds back a newer one that is paid`);
    handed = [];
    const fresh = await open();
    captureWith = (o) => ({ status: 201, body: completed(o, "49.00", "PENDING", "late@example.com") });
    console.error = () => undefined;
    await captureOrder(store, fresh);
    console.error = logged;
    const [record] = await redis.pipeline([["GET", `nl:ppsell:o:${fresh}`]]);
    const blockers = Array.from({ length: 25 }, (_, i) => `8Q${k}${String(i).padStart(14, "0")}`);
    const firstSeen = Math.floor(Date.now() / 1000) - 3600;
    for (const [i, order] of blockers.entries()) {
      await redis.pipeline([
        ["SET", `nl:ppsell:o:${order}`, k === 0 ? "not a record" : String(record)],
        ["ZADD", pendingKey, String(firstSeen + i), order],
      ]);
      if (k === 1) await redis.pipeline([["SET", `nl:ppsell:paid:${order}`, "not a record"]]);
      orders.set(order, k === 2 ? completed("5O000000000000000", "49.00") : completed(order, "49.00", "COMPLETED", `wait${i}@example.com`));
    }
    orders.set(fresh, completed(fresh, "49.00", "COMPLETED", "late@example.com"));
    const blocked = new Set(blockers);
    const realNow = Date.now;
    try {
      console.error = () => undefined;
      await withRedis(
        (commands) => (k === 3 && commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("marktmorgen:paypal-settle") && c.some((arg) => blocked.has(String(arg)))) ? commands.map(() => 2) : null),
        async () => {
          for (let sweep = 1; sweep <= 2; sweep++) {
            const at = realNow() + sweep * 300_000;
            Date.now = () => at;
            await watchPayPal(store, at + 10_000, on);
          }
        },
      );
    } finally {
      Date.now = realNow;
      console.error = logged;
    }
    is("the newer paid order is handed over within two sweeps, out of pending", [handed.includes(fresh), await stillPending(store, fresh)], [true, false]);
    is("the 25 kept are all still waited on, none handed over", [(await Promise.all(blockers.map((o) => stillPending(store, o)))).every(Boolean), handed.some((o) => blocked.has(o))], [true, false]);
    await redis.pipeline([["ZREM", pendingKey, ...blockers]]);
  }

  // 2. LOW 2: a declined try lets go of the pending entry only while no other try has been counted since its own.
  for (const how of ["PayPal refuses the capture", "PayPal's answer says the capture was declined"] as const) {
    part(`A declined try (${how}) never lets go of the entry another try is taking the payment under`);
    const lone = await open();
    captureWith = (o) => (how === "PayPal refuses the capture" ? declined() : { status: 201, body: completed(o, "49.00", "DECLINED", "lone@example.com") });
    const letGo: Commands = [];
    const loneResult = await withRedis((commands) => {
      for (const command of commands) if (command[0] === "EVAL" && String(command[1]).includes("marktmorgen:paypal-let-go-declined")) letGo.push(command);
      return null;
    }, () => captureOrder(store, lone));
    is("alone, it is declined and let go of pending, as before", [loneResult.ok ? "paid" : loneResult.reason, await stillPending(store, lone)], ["declined", false]);
    is("in one step, billed as the EVAL and each redis.call, as tests/plan-cost-registry.ts prices it", letGo.map((command) => 1 + (String(command[1]).match(/redis\.call\(/g) ?? []).length), [PAYPAL_CAPTURE_WATCH.letGoCommandsPerDeclinedTry]);

    const order = await open();
    const reachedA = signal();
    const reachedB = signal();
    const answerA = signal();
    const answerB = signal();
    let asked = 0;
    captureWith = async (o) => {
      asked += 1;
      if (asked === 1) {
        reachedA.fire();
        await answerA.wait;
        return how === "PayPal refuses the capture" ? declined() : { status: 201, body: completed(o, "49.00", "DECLINED", "raced@example.com") };
      }
      reachedB.fire();
      await answerB.wait;
      return { status: 201, body: completed(o, "49.00", "COMPLETED", "raced@example.com") };
    };
    console.error = () => undefined;
    try {
      const a = captureOrder(store, order);
      await reachedA.wait;
      const b = withRedis((commands) => (settleOf(commands, order) ? commands.map(() => 2) : null), async () => {
        const taking = captureOrder(store, order);
        await reachedB.wait;
        answerA.fire();
        const first = await a;
        is("the first try is declined", first.ok ? "paid" : first.reason, "declined");
        is("the order stays in pending, under the second try's watch", await stillPending(store, order), true);
        answerB.fire();
        return taking;
      });
      const second = await b;
      is("the second try's payment is taken, and writing it down answers in a shape not known", second.ok ? "paid" : second.reason, "error");
      handed = [];
      await watchPayPal(store, Date.now() + 10_000, on);
      is("the sweep finds it and writes it down: the buyer charged is handed what they paid for, once", [handed.filter((o) => o === order).length, (await readPaid(order))?.order ?? null, await stillPending(store, order)], [1, order, false]);
    } finally {
      console.error = logged;
    }
  }

  part("A declined try's letting go stays inside the order's own work");
  {
    const perOrder = PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost * (PAYPAL_CAPTURE_WATCH.commandsPerCaptureAsked + PAYPAL_CAPTURE_WATCH.letGoCommandsPerDeclinedTry);
    is("every admitted try declined: the watch and the letting go together inside a fifth of ORDER_COMPUTE", perOrder * COMMAND < ORDER_COMPUTE / 5, true);
  }

  done();
}

void main();
