/** Exact refund-record proof. Redis and all data are synthetic; no provider is called. */
import { readPayPalRefundsWithCoverage } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "z2964-proof";
const ORDER = "SYNTHORDER0001";
const AT = 1_760_356_800;
const valid = { store: STATS, order: ORDER, capture: "SYNTHCAPTURE01", cents: 1200, currency: "USD" };
const original = redis.pipeline.bind(redis);
let injected: unknown[] | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (injected && commands.length === 1 && commands[0][0] === "MGET") return injected;
  return original(commands);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => { throw new Error("No external request is permitted in this proof"); }) as typeof fetch;

async function readWith(reply: unknown[]) {
  injected = null;
  redis.clear();
  await original([["ZADD", `nl:ppsell:refunded:${STATS}`, AT, ORDER]]);
  injected = reply;
  try { return await readPayPalRefundsWithCoverage(STATS, AT - 86_400); }
  finally { injected = null; }
}

async function unknown(reply: unknown[]): Promise<boolean> {
  try {
    const result = await readWith(reply);
    console.log("  synthetic financial reading:", JSON.stringify(result));
    return result.partial;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  is("healthy control: the exact record produces the exact refund", await readWith([[JSON.stringify(valid)]]), {
    rows: [{ order: ORDER, capture: valid.capture, cents: 1200, currency: "USD", at: AT }], partial: false,
  });
  is("missing-record control: a confirmed null record is partial", (await readWith([[null]])).partial, true);
  is("one MGET command cannot have an extra outer reply", await unknown([[JSON.stringify(valid)], "extra-slot"]), true);
  is("one requested record cannot have an extra MGET member", await unknown([[JSON.stringify(valid), JSON.stringify(valid)]]), true);
  for (const [label, patch] of [
    ["the indexed order and record order disagree", { order: "DIFFERENT0001" }],
    ["cents is text rather than a whole numeric amount", { cents: "1200" }],
    ["the capture identity is null", { capture: null }],
    ["the currency is an object", { currency: {} }],
  ] as const) {
    is(label + " makes the refund read unknown", await unknown([[JSON.stringify({ ...valid, ...patch })]]), true);
  }
  done();
}

main();
