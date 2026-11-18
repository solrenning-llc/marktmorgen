/**
 * Claude 7 numbers hunt (synthetic only): lib/paypal-sales.ts readPayPalSales
 * took a list reply in any other shape for "no PayPal sales", and left out an
 * order whose record was missing or belonged to another store as if it had
 * never been sold, all with partial false: the studio's totals and the sales
 * goal then counted those sales as not there. Read exactly now, as the PayPal
 * refunds beside it are (readPayPalRefundsWithCoverage): a missing record or
 * another store's leaves the reading partial, any other shape throws.
 */
import { readPayPalSales } from "@/lib/paypal-sales";
import { claimHandle, ensureStatsId, setPayPalSeller, storeForEmail } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "owner@example.com";
const order = (i: number) => `ORDER${String(i).padStart(8, "0")}`;
const record = (statsId: string, i: number, at: number) =>
  JSON.stringify({ store: statsId, order: order(i), capture: `CAP${i}`, email: `b${i}@example.com`, product: "prod000001", cents: 1_000, currency: "usd", at, handle: "harbor" });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setPayPalSeller(OWNER, "7KNGBPH2U58GQ");
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const at = Math.floor(Date.now() / 1000) - 5;
  const salesKey = `nl:ppsell:sales:${statsId}`;
  const paidKey = (o: string) => `nl:ppsell:paid:${o}`;

  part("PayPal sales: what is not read is never 'none'");
  await redisPipeline([["ZADD", salesKey, String(at), order(1)], ["SET", paidKey(order(1)), record(statsId, 1, at)]]);
  is("(control) one sale written down, read whole", await readPayPalSales(statsId, 0, 10).then((r) => [r.sales.length, r.partial]), [1, false]);
  await redisPipeline([["ZADD", salesKey, String(at), order(2)]]);
  is("an order whose record is missing leaves the reading partial", await readPayPalSales(statsId, 0, 10).then((r) => [r.sales.length, r.partial], () => "threw"), [1, true]);
  await redisPipeline([["SET", paidKey(order(2)), "{not json"]]);
  is("a record that cannot be read is unknown, never left out of a whole reading", await readPayPalSales(statsId, 0, 10).then((r) => r.partial, () => "threw"), "threw");
  await redisPipeline([["SET", paidKey(order(2)), record("someotherstore", 2, at)]]);
  is("another store's record under this store's sales leaves it partial", await readPayPalSales(statsId, 0, 10).then((r) => [r.sales.length, r.partial], () => "threw"), [1, true]);
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands[0][0] === "ZREVRANGEBYSCORE" ? ["OK"] : original(commands)) as typeof redis.pipeline;
  is("a list answered in another shape is unknown, never no sales", await readPayPalSales(statsId, 0, 10).then((r) => r.partial, () => "threw"), "threw");
  redis.pipeline = original;

  // Codex L and Codex V on #4001 (MEDIUM): a sale's record is kept PAID_KEPT_SECONDS (400 days) by its own expiry, while
  // its member in the list goes only at the next sale's trim. A member whose record expired by design is outside what
  // is kept, so a whole reading stays whole; a record missing inside its keeping window is still a sale not read.
  await redisPipeline([["DEL", salesKey, paidKey(order(1)), paidKey(order(2))]]);
  const now = Math.floor(Date.now() / 1000);
  const old = now - 401 * 86_400;
  await redisPipeline([["ZADD", salesKey, String(at), order(1)], ["SET", paidKey(order(1)), record(statsId, 1, at)], ["ZADD", salesKey, String(old), order(3)]]);
  is("a member whose record expired by design is outside the whole reading", await readPayPalSales(statsId, 0, 10).then((r) => [r.sales.length, r.partial], () => "threw"), [1, false]);
  const inside = now - 399 * 86_400;
  await redisPipeline([["ZADD", salesKey, String(inside), order(4)]]);
  is("a record missing inside its keeping window is still unknown", await readPayPalSales(statsId, 0, 10).then((r) => [r.sales.length, r.partial], () => "threw"), [1, true]);
  await redisPipeline([["ZREM", salesKey, order(4)]]);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands[0][0] === "ZREVRANGEBYSCORE" ? [[order(1), "not a time"]] : original(commands)) as typeof redis.pipeline;
  is("a member's time in another shape is unknown, never taken for expired", await readPayPalSales(statsId, 0, 10).then((r) => r.partial, () => "threw"), "threw");
  redis.pipeline = original;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
