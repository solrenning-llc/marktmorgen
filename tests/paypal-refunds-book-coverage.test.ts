/**
 * The affiliate book's PayPal refunds, read with their coverage (Codex Z on
 * #2839). The book read PayPal refunds through a rows-only wrapper, so a
 * reading that was not whole (a refund whose paid record was gone, or more
 * refunds than one reading takes) still left refundsChecked true: a sale
 * refunded in full kept its commission and was offered for payout through
 * the refund guard (lib/paypal-payouts.ts). Now partial coverage leaves the
 * book unchecked, and no payout is made on it.
 * Synthetic only: the Redis stub, no provider call. Setup after Codex Z's
 * proof (codex/z-review-2839-refund-coverage-proof).
 */
import { creditPayPalSale, readBook } from "@/lib/affiliates";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { PAYPAL_REFUNDS_READ, type Paid } from "@/lib/paypal-sales";
import { payableLines } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const AT = Math.floor(Date.now() / 1000) - 60;
const SID = "synthetic-book-refund-coverage";
const AFF = "aaaaaaaaaaaa";
const ORDER = "5O190127TN3647101";
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
const paid: Paid = { store: SID, order: ORDER, capture: "3C679366HH908701", email: "buyer@example.com", product: "course", cents: 5000, currency: "usd", at: AT - 3600, via: { aff: AFF, rate: 20 } } as Paid;

async function setup(): Promise<void> {
  redis.clear();
  await redis.pipeline([["HSET", `nl:aff:${SID}:people`, AFF, JSON.stringify({ id: AFF, email: "affiliate@example.com", code: "synthetic", status: "approved", appliedAt: 1, decidedAt: 1, note: "" })]]);
  await creditPayPalSale(store, paid, "Synthetic course");
  await redis.pipeline([["SET", `nl:ppsell:paid:${ORDER}`, JSON.stringify(paid), "NX", "EX", 86400]]);
}

async function offered(): Promise<{ checked: boolean; through: number; commission: number | undefined }> {
  const book = await readBook(store);
  const cents = payableLines(book, new Set()).reduce((sum, line) => sum + line.cents, 0);
  return { checked: book.refundsChecked, through: book.refundsChecked ? cents : 0, commission: book.lines.find((line) => line.ref === `paypal:${ORDER}`)?.commission };
}

async function main(): Promise<void> {
  console.error = () => {};

  part("Control: a sale not refunded is payable");
  await setup();
  const healthy = await offered();
  is("checked", healthy.checked, true);
  is("its commission offered", healthy.through, 1000);

  part("Control: a refund in full, read whole, takes the commission back");
  await setup();
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${SID}`, String(AT), ORDER]]);
  const refunded = await offered();
  is("checked", refunded.checked, true);
  is("no commission", refunded.commission, 0);
  is("nothing offered", refunded.through, 0);

  part("A refund whose paid record is gone");
  await setup();
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${SID}`, String(AT), ORDER], ["DEL", `nl:ppsell:paid:${ORDER}`]]);
  const gone = await offered();
  is("the book is not checked", gone.checked, false);
  is("nothing passes the refund guard", gone.through, 0);

  part("More refunds than one reading takes, the sale's beyond it");
  await setup();
  const commands: (string | number)[][] = [];
  for (let i = 0; i < PAYPAL_REFUNDS_READ; i += 1) {
    const order = `7O190127TN3${String(i).padStart(6, "0")}`;
    commands.push(["SET", `nl:ppsell:paid:${order}`, JSON.stringify({ ...paid, order, capture: `8C679366HH${String(i).padStart(6, "0")}`, via: undefined })], ["ZADD", `nl:ppsell:refunded:${SID}`, String(AT), order]);
  }
  commands.push(["ZADD", `nl:ppsell:refunded:${SID}`, String(AT + 1), ORDER]);
  await redis.pipeline(commands);
  const cut = await offered();
  is("the book is not checked", cut.checked, false);
  is("nothing passes the refund guard", cut.through, 0);

  is("no provider was asked", external, 0);
  done();
}

void main();
