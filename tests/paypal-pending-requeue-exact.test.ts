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
/** The step that puts an order in pending before its capture (PAYPAL_WATCH_FIRST), or a ZADD of pending sent on its own. */
const pendingWrite = (commands: Commands) =>
  commands.some((c) => (c[0] === "ZADD" && String(c[1]).startsWith("nl:ppsell:pending:")) || (c[0] === "EVAL" && String(c[1]).includes("marktmorgen:paypal-watch-first")));

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

  // Claude 2's LEVE on #5335 (row #3404 of #5285): with the try counted in one step and the order put in pending in a
  // second, a try B could count before a try A while A put the order in pending first; A, declined last, then read its
  // own count as the latest and let go of the entry B was taking the payment under. Forced here on the steps as they
  // were sent: the first count held until the second is counted, the second's pending write held until the first's is
  // in, and its answer held until the first try has let go. One step, as now, leaves nothing to interleave.
  part("Two tries of one order, B counted before A, A put in pending first and declined last: B's entry stays");
  {
    const order = await open();
    captureWith = () => declined();
    console.error = () => undefined;
    try {
      const lone = await captureOrder(store, order);
      is("a first try is declined alone, counted, and let go of pending", [lone.ok ? "paid" : lone.reason, await stillPending(store, order)], ["declined", false]);
    } finally {
      console.error = logged;
    }
    const counts = (commands: Commands) => commands.some((c) => c[0] === "INCR" && String(c[1]) === `nl:ppsell:try:${order}`);
    const adds = (commands: Commands) => commands.some((c) => c[0] === "ZADD" && String(c[1]) === pendingKey && !c.map(String).includes("XX") && c.map(String).includes(order));
    const letsGo = (commands: Commands) => commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("marktmorgen:paypal-let-go-declined") && c.map(String).includes(order));
    const secondCounted = signal();
    const firstAdded = signal();
    const firstLetGo = signal();
    const answerTaking = signal<Answer>();
    let counted = 0;
    let added = 0;
    let asked = 0;
    captureWith = async () => {
      asked += 1;
      return asked === 1 ? declined() : answerTaking.wait;
    };
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: Commands) => {
      if (counts(commands)) {
        counted += 1;
        if (counted === 1) {
          await secondCounted.wait;
          return real(commands);
        }
        const replies = await real(commands);
        secondCounted.fire();
        return replies;
      }
      if (adds(commands)) {
        added += 1;
        if (added === 1) {
          await firstAdded.wait;
          const replies = await real(commands);
          await firstLetGo.wait;
          return replies;
        }
        const replies = await real(commands);
        firstAdded.fire();
        return replies;
      }
      if (letsGo(commands)) {
        const replies = await real(commands);
        firstLetGo.fire();
        return replies;
      }
      return real(commands);
    }) as typeof redis.pipeline;
    console.error = () => undefined;
    try {
      const tries = [captureOrder(store, order), captureOrder(store, order)];
      const first = await Promise.race(tries);
      is("the try PayPal answers first is declined", first.ok ? "paid" : first.reason, "declined");
      is("the order stays in pending, under the other try's watch", await stillPending(store, order), true);
      answerTaking.fire({ status: 201, body: completed(order, "49.00", "COMPLETED", "interleaved@example.com") });
      const both = await Promise.all(tries);
      is("the other try's payment is taken and written down", [both.filter((r) => r.ok).length, (await readPaid(order))?.order ?? null], [1, order]);
    } finally {
      redis.pipeline = real;
      console.error = logged;
    }
  }

  part("A declined try's letting go stays inside the order's own work");
  {
    const perOrder = PAYPAL_CAPTURE_WATCH.watchCommandsPerOrderAtMost + PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost * PAYPAL_CAPTURE_WATCH.letGoCommandsPerDeclinedTry;
    is("every admitted try declined: the watch and the letting go together inside a fifth of ORDER_COMPUTE", perOrder * COMMAND < ORDER_COMPUTE / 5, true);
  }

  // 3. NIT: an error captureOrder does not turn into an answer sends the buyer to the store's notice, never a 500.
  part("The return page never answers a Redis failure with a bare server error");
  for (const where of ["putting the order in pending", "writing the payment down"] as const) {
    const order = await open();
    captureWith = (o) => ({ status: 201, body: completed(o, "49.00", "COMPLETED", "routed@example.com") });
    const lines: string[] = [];
    console.error = (...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
    let shown: { status: number; location: string };
    try {
      shown = await withRedis(
        (commands) => {
          if (where === "putting the order in pending" ? pendingWrite(commands) : settleOf(commands, order)) throw new Error("Synthetic: Redis connection reset");
          return null;
        },
        async () => {
          const response = await paypalReturn(
            new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${made}` } }),
          );
          return { status: response.status, location: response.headers.get("location") ?? "" };
        },
      ).catch(() => ({ status: 500, location: "" }));
    } finally {
      console.error = logged;
    }
    is(`Redis failing while ${where}: the buyer is sent to the store's notice, as for an answer not known`, [shown.status, shown.location.includes(`/@${store.handle}?status=paypal-error`)], [303, true]);
    is(`Redis failing while ${where}: the failure is logged without the buyer's address`, [lines.length > 0, lines.some((line) => /@[a-z0-9-]+\.[a-z]/i.test(line) && /example\.com/i.test(line))], [true, false]);
    if (where === "writing the payment down") {
      handed = [];
      await watchPayPal(store, Date.now() + 10_000, on);
      is("the payment PayPal took is still found by the sweep and handed over once", handed.filter((o) => o === order).length, 1);
    }
  }

  done();
}

void main();
