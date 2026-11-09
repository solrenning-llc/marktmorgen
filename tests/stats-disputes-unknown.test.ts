/**
 * A dispute the store's numbers cannot read is never passed over as if it did
 * not exist (CX-123 rule 24: unknown is never zero). lib/stats.ts readDisputes
 * kept only the disputes in DISPUTE_TAKES and skipped every other row in
 * silence, so a status Stripe does not give (or none, or not text) left the
 * disputed and kept figures looking complete with that dispute missing.
 *
 * Now a dispute whose status is not one Stripe gives (lib/dispute-statuses.ts
 * DISPUTE_STATUSES), or one that takes the money with an amount that is not a
 * whole number of cents, marks the dispute reading incomplete. The page then
 * shows disputes as not read (disputesComplete false: "Disputes could not all
 * be read") and what each currency kept has no figure, with "disputes" among
 * the readings missing, as for a dispute whose currency is unknown
 * (tests/r24-currency-unknown.test.ts). A known status that takes nothing
 * (won, an inquiry, the legacy charge_refunded) still reads complete.
 *
 * Synthetic data and a stand-in for Stripe only: no real account or payment.
 */
import { readSales, readStoreDisputes } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_stats_disputes_unknown";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const S = NOW / 1000;

/** The second dispute listed: the row under test. The first is always a healthy lost one of 400 cents. */
let odd: Record<string, unknown> | null = null;

function stripeLists(path: string): unknown[] | null {
  const meta = { store: "sdunk", product: "p1", channel: "instagram" };
  if (path.endsWith("/checkout/sessions")) return [
    { id: "cs_test_sdunk0001", status: "complete", payment_status: "paid", amount_total: 5000, currency: "usd", created: S, payment_intent: "pi_sdunk0001", customer_details: { email: "a@example.com" }, metadata: meta },
  ];
  if (path.endsWith("/disputes")) return [
    { id: "dp_sdunk0001", status: "lost", amount: 400, currency: "usd", created: S, payment_intent: "pi_sdunk0001" },
    ...(odd ? [{ id: "dp_sdunk0002", currency: "usd", created: S, payment_intent: "pi_sdunk0001", ...odd }] : []),
  ];
  return null;
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const listed = (init?.method ?? "GET") === "GET" ? stripeLists(path) : null;
  return new Response(JSON.stringify({ data: listed ?? [], has_more: false }), { status: 200 });
}) as typeof fetch;

/** Statuses Stripe gives a dispute that do not take the money (DISPUTE_TAKES leaves them out); `prevented` is left to #3321. */
const KNOWN_NOT_TAKING = ["won", "warning_needs_response", "warning_under_review", "warning_closed", "charge_refunded"];

/** Dispute rows the reading cannot place: a status Stripe does not give, or a taking one without a readable amount. */
const UNKNOWN: [string, Record<string, unknown>][] = [
  ["a status Stripe does not give", { status: "frozen_by_bank", amount: 700 }],
  ["no status at all", { amount: 700 }],
  ["a status of null", { status: null, amount: 700 }],
  ["a status that is a number", { status: 3, amount: 700 }],
  ["an empty status", { status: "", amount: 700 }],
  ["a lost dispute with no amount", { status: "lost" }],
  ["a lost dispute with an amount in text", { status: "lost", amount: "700" }],
  ["a lost dispute with a negative amount", { status: "lost", amount: -700 }],
  ["a lost dispute with a fraction of a cent", { status: "lost", amount: 700.5 }],
  // A decision under appeal (stripe-node 23.1.0): known to Stripe, but DISPUTE_TAKES (lib/retained-revenue.ts, #3321's)
  // does not say yet whether its money is held, so it is never read as nothing taken.
  ["a dispute under appeal, waiting for an answer", { status: "appeal_needs_response", amount: 700 }],
  ["a dispute under appeal, with the bank", { status: "appeal_under_review", amount: 700 }],
];

async function main() {
  redis.clear();
  const owner = "sdunk-owner@example.com";
  await claimHandle(owner, "sdunk", "Disputes", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestSdUnk01", true);
  const store = (await storeForEmail(owner))!;

  part("Healthy control: one lost dispute reads exactly as before");
  odd = null;
  const ok = (await readSales(store, NOW))!;
  is("healthy: the dispute reading is complete", (await readStoreDisputes(store, 0)).partial, false);
  is("healthy: the page shows the disputes", ok.disputesComplete, true);
  is("healthy: the lost dispute is taken off", (ok.disputesIn?.d7 ?? []).reduce((n, r) => n + r.cents, 0), 400);
  is("healthy: what was kept has its figure", ok.keptIn!.d7.lines.map((l) => [l.currency, l.keptCents, l.missing]), [["usd", 5000 - 400, []]]);

  for (const status of KNOWN_NOT_TAKING) {
    part(`Known status that takes nothing: ${status}`);
    odd = { status, amount: 700 };
    const read = (await readSales(store, NOW))!;
    is(`${status}: the dispute reading stays complete`, (await readStoreDisputes(store, 0)).partial, false);
    is(`${status}: the page still shows the disputes`, read.disputesComplete, true);
    is(`${status}: only the lost dispute is taken off`, (read.disputesIn?.d7 ?? []).reduce((n, r) => n + r.cents, 0), 400);
    is(`${status}: what was kept keeps its figure`, read.keptIn!.d7.lines.map((l) => [l.keptCents, l.missing]), [[5000 - 400, []]]);
  }

  for (const [label, row] of UNKNOWN) {
    part(`Unknown: ${label}`);
    odd = row;
    const disputes = await readStoreDisputes(store, 0);
    is(`${label}: the dispute reading says it is incomplete`, disputes.partial, true);
    is(`${label}: never counted as a dispute it cannot read`, disputes.rows.map((r) => r.cents), [400]);
    const read = (await readSales(store, NOW))!;
    is(`${label}: the page says the disputes could not all be read`, read.disputesComplete, false);
    is(`${label}: what was kept has no figure and names the disputes as missing`, read.keptIn!.d7.lines.map((l) => [l.currency, l.keptCents, l.missing]), [["usd", null, ["disputes"]]]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
