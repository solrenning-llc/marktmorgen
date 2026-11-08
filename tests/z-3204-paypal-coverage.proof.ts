/** Independent reproduction of C2 findings; selected author fixture setup, unchanged production readers. */
import { creditPayPalSale, readBook } from "@/lib/affiliates";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { readPayPalRefundsWithCoverage, PAYPAL_REFUNDS_READ, type Paid } from "@/lib/paypal-sales";
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


async function others(count: number): Promise<void> {
  const commands: (string | number)[][] = [];
  for (let n = 0; n < count; n++) {
    const order = "A" + n.toString(36).toUpperCase().padStart(16, "0");
    const capture = "B" + n.toString(36).toUpperCase().padStart(16, "0");
    commands.push(["SET", `nl:ppsell:paid:${order}`, JSON.stringify({ ...paid, order, capture })]);
    commands.push(["ZADD", `nl:ppsell:refunded:${SID}`, String(AT - 1), order]);
  }
  await redis.pipeline(commands);
}
async function snapshot(label: string) {
  const coverage = await readPayPalRefundsWithCoverage(SID, paid.at);
  const book = await offered();
  console.log("Z_REFUND_CASE", JSON.stringify({ label, partial: coverage.partial, rows: coverage.rows.length, ...book }, (_key, value) => typeof value === "number" && !Number.isFinite(value) ? String(value) : value));
  return { coverage, book };
}
async function main(): Promise<void> {
  part("Healthy controls");
  await setup(paid, false);
  is("unrefunded sale stays payable", await offered(), { checked: true, through: 1000, commission: 1000 });
  await setup(paid, true);
  is("whole healthy refund removes its commission", await offered(), { checked: true, through: 0, commission: 0 });

  part("C2 HIGH: a 501st current refund cannot leave the book checked");
  await setup(paid, true); await others(PAYPAL_REFUNDS_READ);
  const cut = await snapshot("target is 501st");
  is("fault reaches the actual coverage reader", [cut.coverage.partial, cut.coverage.rows.length, cut.coverage.rows.some(row => row.order === ORDER)], [true, 500, false]);
  is("cut-short read prevents eligibility", [cut.book.checked, cut.book.through], [false, 0]);

  part("Boundary control: the target in a complete 500-row read is refunded");
  await setup(paid, true); await others(PAYPAL_REFUNDS_READ - 1);
  const full = await snapshot("target is 500th");
  is("complete boundary is confirmed whole", [full.coverage.partial, full.coverage.rows.length], [false, 500]);
  is("complete boundary remains healthy", full.book, { checked: true, through: 0, commission: 0 });

  part("C2 HIGH: a missing listed refund is unknown");
  await setup(null, true);
  const missing = await snapshot("listed refund missing");
  is("missing record is flagged by the actual coverage reader", [missing.coverage.partial, missing.coverage.rows.length], [true, 0]);
  is("missing refund prevents eligibility", [missing.book.checked, missing.book.through], [false, 0]);

  part("C2 MEDIUM: unreadable or inconsistent full-refund amounts");
  for (const cents of [0, -5000, 100, "abc", undefined]) {
    await setup({ ...paid, cents }, true);
    const malformed = await snapshot(`stored cents ${String(cents)}`);
    is(`amount ${String(cents)} has a present indexed record`, [malformed.coverage.partial, malformed.coverage.rows.length], [false, 1]);
    is(`amount ${String(cents)} never passes the refund guard`, [malformed.book.checked, malformed.book.through], [false, 0]);
  }
  is("no provider request", external, 0);
  done();
}
void main();
