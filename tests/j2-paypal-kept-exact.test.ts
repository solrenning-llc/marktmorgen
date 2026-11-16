/**
 * Rule 24 (exact replies) and MR (reserve before each read): lib/paypal-sales.ts paypalKept
 * counts a store's PayPal sales and refunds (ZCARD) so that what a reading of them all moves is
 * counted before it reads (lib/segments.ts buyerLedger, lib/product-updates.ts, lib/broadcasts.ts).
 * A reply that is not a whole count (a string, a negative or broken number, null, a missing or
 * extra reply, a failed request) is unknown: it throws, and every caller then refuses before it
 * reads. Before, it became 0, so a store with many PayPal sales was counted as having none and
 * the whole read was taken without its cost. Synthetic store; one reply injected per case.
 */
import { paypalKept } from "@/lib/paypal-sales";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const SID = "j2paypalkept1";
const real = redis.pipeline.bind(redis);
let inject: ((values: unknown[]) => unknown) | null = null;
let fail = false;
redis.pipeline = (async (batch: Command[]) => {
  if (fail && batch.some((c) => c[0] === "ZCARD")) throw new Error("synthetic Redis timeout");
  const values = await real(batch);
  if (inject && batch.some((c) => c[0] === "ZCARD")) return inject(values);
  return values;
}) as typeof redis.pipeline;

async function outcome(refunds: boolean): Promise<unknown> {
  try {
    return await paypalKept(SID, refunds);
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  }
}

async function main() {
  await real([["ZADD", `nl:ppsell:sales:${SID}`, 1, "a", 2, "b", 3, "c"], ["ZADD", `nl:ppsell:refunded:${SID}`, 1, "a"]]);

  part("Whole counts are read as they are");
  is("sales and refunds", await outcome(true), { sales: 3, refunds: 1 });
  is("sales only: the refunds are not asked", await outcome(false), { sales: 3, refunds: 0 });
  is("no store id: nothing to count", await paypalKept(null, true), { sales: 0, refunds: 0 });

  part("A reply that is not a whole count is unknown, never zero");
  const cases: [string, (v: unknown[]) => unknown][] = [
    ["a count as text", (v) => ["3", ...v.slice(1)]],
    ["a negative count", (v) => [-1, ...v.slice(1)]],
    ["a broken number", (v) => [1.5, ...v.slice(1)]],
    ["no value", (v) => [null, ...v.slice(1)]],
    ["a refunds count as text", (v) => [v[0], "1"]],
    ["a missing reply", (v) => v.slice(0, 1)],
    ["an extra reply", (v) => [...v, 0]],
    ["not a list", () => ({ 0: 3, 1: 1, length: 2 })],
  ];
  for (const [name, change] of cases) {
    inject = change;
    is(name, await outcome(true), "unknown");
  }
  inject = () => ["3"];
  is("sales only, a count as text", await outcome(false), "unknown");
  inject = null;

  part("A failed request is never a count");
  fail = true;
  is("a timeout throws as it is", String(await outcome(true)).startsWith("other: Error: synthetic Redis timeout"), true);
  fail = false;
}

main().then(done);
