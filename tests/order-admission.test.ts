/**
 * A paid store's new orders stop at its plan's figure (lib/order-admission.ts),
 * and nothing past it is billed. Runs the real code against the in-memory
 * Redis (tests/redis-stub.ts); scripts/test_order_admission_redis.py runs the
 * same scripts on a real Redis.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIT_ORDERS, ADMITTED_FIELD, OPEN_HOURS, admitOrders, settleAdmitted } from "@/lib/order-admission";
import { ORDERS_INCLUDED, TRIAL_ORDERS, freeCopiesLimitFor, paidOrdersLimitFor } from "@/lib/order-rules";
import { countOrder, storeOrdersThisMonth } from "@/lib/orders";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

async function main() {
  const OWNER = "orders-paused@example.com";
  // Keep the paid snapshot and every admission on the same deterministic clock.
  const now = Date.UTC(2026, 9, 17, 12);
  await claimHandle(OWNER, "pausedshop", "Paused Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Paused0001", subscriptionId: "sub_Paused0001", active: true, tier: "creator", period: paidPeriod(now) });
  const store = (await storeForEmail(OWNER))!;

  part("Where a paid store's orders stop");
  is("a paid store's figure is its plan's, for paid orders and free copies alike", [paidOrdersLimitFor(store, now / 1000), freeCopiesLimitFor(store, now / 1000)], [ORDERS_INCLUDED.creator, ORDERS_INCLUDED.creator]);
  // Since 17 October 2026 a trial's paid orders stop at its figure too, shared with free copies.
  is("a trial's paid orders and free copies stop at the trial's figure", [paidOrdersLimitFor({ ...store, trialEnds: now / 1000 + 86_400 }, now / 1000), freeCopiesLimitFor({ ...store, trialEnds: now / 1000 + 86_400 }, now / 1000)], [TRIAL_ORDERS, TRIAL_ORDERS]);

  part("A marked paid contract needs its funded resource month before checkout");
  const funded = { ...store, period: { ...store.period!, funded: true as const } };
  const beforeFunded = JSON.stringify(redis.keys().filter((key) => key.startsWith("nl:orders:")));
  is("without actual financial approval no new funded order can open", await admitOrders(funded, 1, now), { ok: false, reason: "unavailable" });
  is("refused funded admission holds neither order capacity nor data room", JSON.stringify(redis.keys().filter((key) => key.startsWith("nl:orders:"))), beforeFunded);
  is("invalid order units cannot open a funded admission", await admitOrders(funded, 0, now), { ok: false, reason: "unavailable" });

  part("Only an exact own numeric acknowledgement admits an order");
  const ACK_OWNER = "ack-orders@example.com";
  await claimHandle(ACK_OWNER, "ackordershop", "ACK Orders", "");
  await ensureStatsId(ACK_OWNER);
  await setSubscription(ACK_OWNER, { customerId: "cus_AckOrders001", subscriptionId: "sub_AckOrders001", active: true, tier: "creator", period: paidPeriod(now) });
  const ackStore = (await storeForEmail(ACK_OWNER))!;
  const originalPipeline = redis.pipeline;
  let getters = 0, coerced = 0, members = 0;
  const cases: [string, () => unknown][] = [
    ["missing envelope", () => undefined],
    ["non-array", () => ({ 0: 1, length: 1 })],
    ["empty", () => []],
    ["null", () => [null]],
    ["numeric string", () => ["1"]],
    ["string refusal zero", () => ["0"]],
    ["string refusal two", () => ["2"]],
    ["nested number", () => [[1]]],
    ["boolean", () => [true]],
    ["symbol", () => [Symbol("1")]],
    ["coercible object", () => [{ valueOf() { coerced++; return 1; } }]],
    ["sparse", () => new Array(1)],
    ["inherited", () => Object.setPrototypeOf(new Array(1), { 0: 1 })],
    ["accessor", () => Object.defineProperty(new Array(1), "0", { get() { getters++; return 1; } })],
    ["oversized", () => new Proxy([1, 1], { getOwnPropertyDescriptor(target, key) {
      if (key === "0") members++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    } })],
    ["throw after commit", () => { throw new Error("synthetic lost admission acknowledgement"); }],
  ];
  for (const [name, answer] of cases) {
    let admissions = 0, committed: unknown, heldKeys: string[] = [], snapshot = "";
    redis.pipeline = async (commands) => {
      if (commands.length === 1 && commands[0][0] === "EVAL" && commands[0][1] === ADMIT_ORDERS) {
        admissions++;
        committed = await originalPipeline(commands);
        heldKeys = [String(commands[0][4]), String(commands[0][6])];
        snapshot = JSON.stringify(heldKeys.map(key => redis.run(["HGETALL", key])));
        return answer() as unknown[];
      }
      return originalPipeline(commands);
    };
    try {
      is(`${name}: unknown never grants checkout`, await admitOrders(ackStore, 1, now), { ok: false, reason: "unavailable" });
    } finally {
      redis.pipeline = originalPipeline;
    }
    is(`${name}: one committed reservation, no second attempt`, [admissions, committed], [1, [1]]);
    is(`${name}: uncertain order and data holds retained`, JSON.stringify(heldKeys.map(key => redis.run(["HGETALL", key]))), snapshot);
  }
  is("no malformed getter, coercion or oversized member executed", [getters, coerced, members], [0, 0, 0]);
  // Observe the same descriptor probe on a real numeric success.
  redis.pipeline = async (commands) => {
    const reply = await originalPipeline(commands);
    return commands.length === 1 && commands[0][0] === "EVAL" && commands[0][1] === ADMIT_ORDERS
      ? new Proxy(reply, { getOwnPropertyDescriptor(target, key) {
        if (key === "0") members++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      } }) : reply;
  };
  try {
    const admitted = await admitOrders(ackStore, 1, now);
    is("own numeric success still admits the real reservation", [admitted.ok, admitted.ok && admitted.hour, members], [true, Math.floor(now / 3_600_000), 1]);
  } finally {
    redis.pipeline = originalPipeline;
  }
  for (const answer of [0, 2]) {
    redis.pipeline = async (commands) => commands.length === 1 && commands[0][0] === "EVAL" && commands[0][1] === ADMIT_ORDERS
      ? [answer] : originalPipeline(commands);
    try {
      is(`explicit numeric refusal ${answer} remains paused`, await admitOrders(ackStore, 1, now), { ok: false, reason: "paused" });
    } finally {
      redis.pipeline = originalPipeline;
    }
  }

  part("Checkouts are admitted up to the figure, counting those still open");
  const limit = ORDERS_INCLUDED.creator;
  for (let i = 0; i < limit - 3; i += 1) await countOrder(store, `checkout:test_${i}`, 0, now);
  is("the month's counted orders", await storeOrdersThisMonth(store, now), limit - 3);
  const a = await admitOrders(store, 1, now);
  const b = await admitOrders(store, 2, now);
  is("checkouts fill the rest of the figure, each held for its hour", [a.ok, b.ok, a.ok && a.hour === Math.floor(now / 3_600_000)], [true, true, true]);
  is("one more is refused: the figure is reached", await admitOrders(store, 1, now), { ok: false, reason: "paused" });
  // The first checkout is paid and its order counted: it gives its hour back.
  await countOrder(store, "checkout:paid_a", 0, now);
  await settleAdmitted(funded, a.ok ? String(a.hour) : null, 1);
  is("a paid checkout is not counted twice, and the figure is still reached", (await admitOrders(store, 1, now)).ok, false);
  const later = now + OPEN_HOURS * 3_600_000;
  is("a checkout nobody paid falls out of the window after a day, and frees its place", (await admitOrders(store, 1, later)).ok, true);
  is("a purchase for several people needs room for all its places", (await admitOrders(store, 5, later)).ok, false);

  part("A store not on a paid plan is not counted here");
  await setSubscription(OWNER, { active: false });
  const ended = (await storeForEmail(OWNER))!;
  is("nothing is held for it", await admitOrders(ended, 1, now), { ok: true, hour: null });

  part("Unknown is not zero");
  await setSubscription(OWNER, { customerId: "cus_Paused0001", subscriptionId: "sub_Paused0001", active: true, tier: "creator", period: paidPeriod(now) });
  const paid = (await storeForEmail(OWNER))!;
  const keys = [...redis.keys()].filter((key) => key.startsWith("nl:orders:n:"));
  for (const key of keys) redis.run(["SET", key, "not-a-number"]);
  is("an unreadable count admits nothing", await admitOrders(paid, 1, now), { ok: false, reason: "unavailable" });

  part("Every door that opens an order is admitted first");
  is("a product's checkout, before Stripe's page opens", /admitOrders\(store, 1 \+ \(extras\.group/.test(read("lib/store-checkout.ts")), true);
  is("a cart, holding what all its products leave", /admitOrders\(store, 1, Date\.now\(\), itemsHandedOver\(products\)\)/.test(read("lib/cart-checkout.ts")), true);
  is("an offer after paying, before it is charged", /admitOrders\(store, 1\)/.test(read("lib/upsell.ts")), true);
  is("a PayPal order, which is now counted too", [/admitOrders\(store, 1\)/.test(read("lib/paypal-sales.ts")), /countOrder\(store, `paypal:/.test(read("lib/paypal-sales.ts"))], [true, true]);
  is("a free copy", /admitOrders\(store, 1\)/.test(read("lib/free.ts")), true);
  is("a counted checkout gives its original hour and item count to atomic accounting", /hour: session\.metadata\?\.\[ADMITTED_FIELD\], items, createdAtMs/.test(read("lib/purchase-email.ts")) && read("lib/orders.ts").includes('"EVAL", COMMIT_ORDER_CONFIRMATION, 6, seenKey(reference)'), true);
  is("the field it travels in", ADMITTED_FIELD, "mm_admit");
  is("a refused buyer is told plainly, with nothing charged", [/OrdersPausedError/.test(read("app/api/store/checkout/route.ts")), read("app/api/store/checkout/route.ts").includes('status=${error.reason === "paused" ? "paused"'), /paused: \{ title:/.test(read("lib/buyer-words/en.ts"))], [true, true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
