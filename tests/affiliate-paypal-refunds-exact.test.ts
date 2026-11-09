/**
 * The affiliate book's PayPal side, counted exactly (rule 24). A PayPal sale
 * refunded in full takes its commission back through the refund's kept
 * record (lib/paypal-sales.ts, readPayPalRefunds), named by its capture. A
 * refund with no capture id was named "paypal:undefined" (or "paypal:"), so
 * the sale it refunds was never found and its commission passed the refund
 * guard; a refund in another currency than its sale's was added to the
 * sale's cents as if it were the same money. Both now leave the book's
 * refunds unchecked, so nothing is paid on them, as the Stripe side does
 * (#3189). The same payment listed twice counts once. A refund whose cents
 * are not the sale's whole positive amount (0, negative, a part, not a whole
 * number, missing) is unknown too, never a refund of less. A reading that
 * did not cover every refund since the oldest line (more than
 * PAYPAL_REFUNDS_READ listed, or a listed refund whose record is gone)
 * leaves the book unchecked, so a refund past the cut is never paid on.
 * Synthetic only: the Redis stub, no provider call.
 */
import { creditPayPalSale, readBook } from "@/lib/affiliates";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { PAYPAL_REFUNDS_READ, type Paid } from "@/lib/paypal-sales";
import { payableLines } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const AT = Math.floor(Date.now() / 1000) - 60;
const SID = "synthetic-book-paypal-exact";
const AFF = "aaaaaaaaaaaa";
const ORDER = "5O190127TN3647102";
const CAPTURE = "3C679366HH908702";
let external = 0;
globalThis.fetch = (async () => {
  external += 1;
  throw new Error("No provider in this test");
}) as typeof fetch;
const store = {
  sid: "synthetic-book-store",
  statsId: SID,
  handle: "synthetic-book-shop",
  name: "Synthetic shop",
  email: "owner@example.com",
  currency: "usd",
  previousHandles: [],
  releasedHandles: [],
  affiliates: { ...NO_AFFILIATES, enabled: true, percent: 20, hold: 0 },
} as unknown as Store;
const paid: Paid = { store: SID, order: ORDER, capture: CAPTURE, email: "buyer@example.com", product: "course", cents: 5000, currency: "usd", at: AT - 3600, via: { aff: AFF, rate: 20 } } as Paid;

/** The affiliate and the PayPal sale on the book, its paid record kept as `record` says, and refunded when `refunded`. */
async function setup(record: Record<string, unknown> | null, refunded: boolean): Promise<void> {
  redis.clear();
  await redis.pipeline([["HSET", `nl:aff:${SID}:people`, AFF, JSON.stringify({ id: AFF, email: "affiliate@example.com", code: "synthetic", status: "approved", appliedAt: 1, decidedAt: 1, note: "" })]]);
  await creditPayPalSale(store, paid, "Synthetic course");
  if (record) await redis.pipeline([["SET", `nl:ppsell:paid:${ORDER}`, JSON.stringify(record)]]);
  if (refunded) await redis.pipeline([["ZADD", `nl:ppsell:refunded:${SID}`, String(AT), ORDER]]);
}

async function offered(): Promise<{ checked: boolean; through: number; commission: number | undefined }> {
  const book = await readBook(store);
  const cents = payableLines(book, new Set()).reduce((sum, line) => sum + line.cents, 0);
  return {
    checked: book.refundsChecked,
    through: book.refundsChecked ? cents : 0,
    commission: book.lines.find((line) => line.ref === `paypal:${ORDER}`)?.commission,
  };
}

/** The refunds' range listed as Redis would never list it (`flat`); every other command answered by the stub. */
async function withRange<T>(flat: string[], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = async (commands) => {
    const replies = await original.call(redis, commands);
    return commands.map((command, i) => (command[0] === "ZRANGEBYSCORE" ? [...flat] : replies[i]));
  };
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

async function held(name: string, record: Record<string, unknown>): Promise<void> {
  part(name);
  await setup(record, true);
  const read = await offered();
  is("the book is not checked", read.checked, false);
  is("nothing passes the refund guard", read.through, 0);
}

async function main(): Promise<void> {
  console.error = () => {};

  part("Control: a sale not refunded is payable");
  await setup(paid, false);
  const healthy = await offered();
  is("checked", healthy.checked, true);
  is("its commission offered", healthy.through, 1000);

  part("Control: a refund in full, read whole, takes the commission back");
  await setup(paid, true);
  const refunded = await offered();
  is("checked", refunded.checked, true);
  is("no commission", refunded.commission, 0);
  is("nothing offered", refunded.through, 0);
  is("the line says refunded", (await readBook(store)).lines.find((line) => line.ref === `paypal:${ORDER}`)?.status, "refunded");

  part("Control: the currency in capitals is the sale's");
  await setup({ ...paid, currency: "USD" }, true);
  const capitals = await offered();
  is("checked", capitals.checked, true);
  is("no commission", capitals.commission, 0);

  await held("No capture", { ...paid, capture: undefined });
  await held("A capture that is empty", { ...paid, capture: "" });
  await held("A capture that is not text", { ...paid, capture: 12345 });
  await held("A refund in another currency than the sale's", { ...paid, currency: "eur" });

  await held("A refund of no cents", { ...paid, cents: 0 });
  await held("A refund of negative cents", { ...paid, cents: -5000 });
  await held("A refund of a part of the sale", { ...paid, cents: 100 });
  await held("A refund in cents that are not a whole number", { ...paid, cents: 4999.5 });
  await held("A refund in cents that are not a number", { ...paid, cents: "abc" });
  await held("A refund with no cents", { ...paid, cents: undefined });

  part("A listed refund whose kept record is gone: the read is partial, nothing is paid");
  await setup(null, true);
  const gone = await offered();
  is("the book is not checked", gone.checked, false);
  is("nothing passes the refund guard", gone.through, 0);

  // `others` refunds of other sales, each with its record, listed before this sale's own refund.
  const crowd = async (others: number): Promise<void> => {
    await setup(paid, true);
    const commands: (string | number)[][] = [];
    for (let i = 0; i < others; i += 1) {
      const order = `7O${String(i).padStart(15, "0")}`;
      commands.push(["SET", `nl:ppsell:paid:${order}`, JSON.stringify({ ...paid, order, capture: `5C${String(i).padStart(14, "0")}`, via: undefined })]);
      commands.push(["ZADD", `nl:ppsell:refunded:${SID}`, String(AT - 1800), order]);
    }
    await redis.pipeline(commands);
  };

  part(`Control: ${PAYPAL_REFUNDS_READ} refunds in all, this sale's the last: read whole, its commission taken back`);
  await crowd(PAYPAL_REFUNDS_READ - 1);
  const whole = await offered();
  is("checked", whole.checked, true);
  is("no commission", whole.commission, 0);
  is("nothing offered", whole.through, 0);

  part(`More than ${PAYPAL_REFUNDS_READ} refunds, this sale's past the cut: the read is partial, nothing is paid`);
  await crowd(PAYPAL_REFUNDS_READ);
  const cut = await offered();
  is("the book is not checked", cut.checked, false);
  is("nothing passes the refund guard", cut.through, 0);

  part("The same refund listed twice counts once, and the book stays checked");
  await setup(paid, true);
  const twice = await withRange([ORDER, String(AT), ORDER, String(AT)], () => readBook(store));
  const line = twice.lines.find((l) => l.ref === `paypal:${ORDER}`);
  is("checked", twice.refundsChecked, true);
  is("refunded once, the sale's cents", line?.refunded, 5000);
  is("no commission", line?.commission, 0);

  part("Control: another sale's refund leaves this one payable");
  await setup(paid, false);
  await redis.pipeline([
    ["SET", "nl:ppsell:paid:6O190127TN3647106", JSON.stringify({ ...paid, order: "6O190127TN3647106", capture: "4C679366HH908706", via: undefined })],
    ["ZADD", `nl:ppsell:refunded:${SID}`, String(AT), "6O190127TN3647106"],
  ]);
  const elsewhere = await offered();
  is("checked", elsewhere.checked, true);
  is("its commission offered", elsewhere.through, 1000);

  is("no provider was asked", external, 0);
  done();
}

void main();
