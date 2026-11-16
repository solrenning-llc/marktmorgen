/**
 * A paid package of calls written down only on the terms its checkout set
 * (CX-123 rule 24, unknown is never zero). lib/call-packages.ts,
 * packageCheckout, writes metadata[sessions] (2 to 20) and metadata[days] (one
 * of PACKAGE_DAYS, 0 for no limit) on every package's checkout, so either in
 * any other shape is unknown: recordPackage throws before writing anything,
 * and the checkout sweep counts the order as failed and reads it again
 * (lib/checkout-sweep.ts). Never a package with no last day, nor one session
 * for a buyer who paid for several.
 */
import { readBought, recordPackage } from "@/lib/call-packages";
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const PAID = `cs_test_${"r".repeat(24)}`;
const store = { handle: "harbor", statsId: "s0123456789ab", language: "en", currency: "usd", name: "Harbor Kitchen" } as unknown as Store;
const product = { id: "p_call", title: "Coaching Call" } as unknown as Listing;
const input = (sessions: string | undefined, days: string | undefined) => ({
  store,
  product,
  base: "https://marktmorgen.com/@harbor",
  from: '"Harbor Kitchen" <hello@marktmorgen.com>',
  session: {
    id: PAID,
    status: "complete",
    payment_status: "paid",
    created: 1_790_000_000,
    amount_total: 50000,
    currency: "usd",
    metadata: { store: "harbor", product: "p_call", kind: "package", ...(sessions === undefined ? {} : { sessions }), ...(days === undefined ? {} : { days }) },
    customer_details: { email: "dana@example.test" },
  },
});

async function outcome(sessions: string | undefined, days: string | undefined): Promise<string> {
  redis.clear();
  try {
    const bought = await recordPackage(input(sessions, days));
    return bought ? `recorded ${bought.total} until+${bought.until ? bought.until - bought.at : 0}` : "null";
  } catch {
    return (await readBought(PAID)) === null ? "refused, nothing written" : "refused, but written";
  }
}

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_package_terms";
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: "em_1" }))) as typeof fetch;

  part("Sessions that do not read: refused, nothing written");
  is(
    "missing, empty, text, a fraction, one, zero, more than 20, with a sign",
    [await outcome(undefined, "90"), await outcome("", "90"), await outcome("five", "90"), await outcome("2.5", "90"), await outcome("1", "90"), await outcome("0", "90"), await outcome("21", "90"), await outcome("+5", "90")],
    Array(8).fill("refused, nothing written"),
  );

  part("A limit that does not read: refused, nothing written, never no limit");
  is(
    "missing, empty, text, negative, a number of days never offered",
    [await outcome("5", undefined), await outcome("5", ""), await outcome("5", "ninety"), await outcome("5", "-90"), await outcome("5", "45")],
    Array(5).fill("refused, nothing written"),
  );

  part("What reads is unchanged");
  is(
    "5 sessions within 90 days; 20 with no limit",
    [await outcome("5", "90"), await outcome("20", "0")],
    [`recorded 5 until+${90 * 86_400}`, "recorded 20 until+0"],
  );
  done();
}

void main();
