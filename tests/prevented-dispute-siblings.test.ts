/**
 * A dispute Stripe closes as `prevented` gave the money back to the buyer,
 * as a lost one does (Claude 5's second money review of #3318, CX-123 rule
 * 30 siblings; added 9 November 2026). #3318 reads it so for the plan's
 * pause (lib/plan-dispute-rules.ts) and lib/plan-refund-rules.ts already
 * did (RETURNED). The money readers below still read it as money kept:
 *
 *   - lib/retained-revenue.ts DISPUTE_TAKES, the one list the store's numbers
 *     (lib/stats.ts readStoreDisputes) and the affiliate book
 *     (lib/affiliates.ts disputesSince) read: kept revenue counted a prevented
 *     dispute's money, and an affiliate kept the commission on it;
 *   - lib/share-settle.ts owedOnFee: a prevented dispute threw
 *     UnknownDisputeStatus, so the platform share was never given back.
 *
 * Kept as they are: the legacy `charge_refunded` (removed in API 2023-08-16)
 * went back through a refund, which the refund readings already count, so it
 * is not counted again as disputed money; at share-settle's pinned
 * 2024-06-20 it cannot arrive and still fails closed. A status this code
 * does not know is read as it is today, never as money kept for the creator
 * by a new rule here, and never as a reason to pay anything out.
 * Statuses: stripe-node v22.6.0 cjs/resources/Disputes.d.ts (Dispute.Status)
 * and its CHANGELOG (13.0.0 removed `charge_refunded`, 19.0.0 added
 * `prevented`). Synthetic Stripe stand-in only; no real provider is called.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DISPUTE_TAKES } from "@/lib/retained-revenue";
import { readStoreDisputes } from "@/lib/stats";
import { disputesSince } from "@/lib/affiliates";
import { owedOnFee, settleFee } from "@/lib/share-settle";
import type { Store } from "@/lib/store";

process.env.STRIPE_SECRET_KEY = "sk_test_prevented_dispute_stand_in";

const ACCOUNT = "acct_TestPrevented01";
const SINCE = 1_790_000_000;
const fee = { id: "fee_PreventedProof01", account: ACCOUNT, charge: "ch_PreventedProof01", amount: 625, refunded: 0, currency: "usd" };
const NOW = 1_800_000_000;

/** One dispute of every status the store's numbers may meet, each on its own payment. */
const LISTED: Record<string, unknown>[] = [
  ["lost", 4000],
  ["prevented", 3000],
  ["charge_refunded", 2000],
  ["won", 5000],
  ["warning_closed", 900],
  ["warning_needs_response", 800],
  ["needs_response", 700],
  ["under_review", 600],
  ["a_status_stripe_adds_later", 7000],
].map(([status, amount], n) => ({ id: `du_TestListed0${n}`, object: "dispute", status, amount, currency: "usd", created: SINCE + 10, payment_intent: `pi_${String(status).replace(/_/g, "")}` }));

/** What the charge's own dispute list says, for share-settle. */
let shareStatus = "prevented";
const calls: { url: URL; method: string; headers: Headers; body: URLSearchParams }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  calls.push({ url, method, headers: new Headers(init?.headers), body: new URLSearchParams(String(init?.body ?? "")) });
  assert.equal(url.origin, "https://api.stripe.com");
  if (url.pathname === `/v1/charges/${fee.charge}`) {
    return Response.json({ object: "charge", id: fee.charge, currency: "usd", amount: 10000, amount_refunded: 0, disputed: true, invoice: null, payment_intent: { object: "payment_intent", id: "pi_PreventedProof01", currency: "usd", amount: 10000, latest_charge: fee.charge, metadata: { share_bps: "625", share_base: "10000" } } });
  }
  if (url.pathname === "/v1/disputes" && url.searchParams.get("charge") === fee.charge) {
    return Response.json({ object: "list", has_more: false, data: [{ id: "du_PreventedProof01", object: "dispute", charge: fee.charge, currency: "usd", status: shareStatus }] });
  }
  if (url.pathname === "/v1/disputes") return Response.json({ object: "list", has_more: false, data: LISTED });
  if (url.pathname === `/v1/application_fees/${fee.id}/refunds`) {
    return Response.json({ object: "fee_refund", id: "fr_PreventedProof01", fee: fee.id, amount: Number(new URLSearchParams(String(init?.body ?? "")).get("amount")), currency: "usd" });
  }
  throw Error(`Unexpected synthetic endpoint ${url.pathname}`);
}) as typeof fetch;

const store = { stripeAccountId: ACCOUNT } as unknown as Store;
const posts = () => calls.filter((call) => call.method === "POST");

test("the one list of disputes that take the money now holds prevented, as it holds lost", () => {
  for (const status of ["lost", "prevented", "needs_response", "under_review"]) assert.equal(DISPUTE_TAKES.has(status), true, status);
  // A dispute won or an inquiry gives nothing back to the buyer; charge_refunded's money is the refund already read.
  for (const status of ["won", "warning_closed", "warning_needs_response", "warning_under_review", "charge_refunded"]) assert.equal(DISPUTE_TAKES.has(status), false, status);
  // Unknown statuses are read as today: this change adds no new reading for them.
  for (const status of ["a_status_stripe_adds_later", "LOST", "Prevented", " prevented", "", "__proto__"]) assert.equal(DISPUTE_TAKES.has(status), false, JSON.stringify(status));
});

test("the store's numbers take a prevented dispute's money off, as a lost one's", async () => {
  const { rows, partial } = await readStoreDisputes(store, SINCE);
  assert.equal(partial, false);
  assert.deepEqual(rows.map((row) => [row.paymentIntent, row.cents]).sort(), [
    ["pi_lost", 4000],
    ["pi_needsresponse", 700],
    ["pi_prevented", 3000],
    ["pi_underreview", 600],
  ]);
});

test("the affiliate book earns nothing on a sale whose dispute was prevented, as on a lost one", async () => {
  const { byIntent, complete } = await disputesSince(store, SINCE);
  assert.equal(complete, true);
  assert.deepEqual([...byIntent.entries()].sort(), [
    ["pi_lost", 4000],
    ["pi_needsresponse", 700],
    ["pi_prevented", 3000],
    ["pi_underreview", 600],
  ]);
});

test("a prevented dispute gives the platform share back once, as a lost one does", async () => {
  for (const status of ["lost", "prevented"]) {
    shareStatus = status;
    calls.length = 0;
    assert.equal(await owedOnFee(fee, NOW, true), 0, status);
    assert.equal(await settleFee(fee, NOW, true), 625, status);
    assert.equal(posts().length, 1, status);
    assert.equal(posts()[0].headers.get("Idempotency-Key"), `share-back:${fee.id}:0:625`);
    assert.deepEqual(Object.fromEntries(posts()[0].body), { amount: "625" });
  }
});

test("a won dispute keeps the share; a status the pinned version cannot send, or one unknown, still gives nothing back", async () => {
  shareStatus = "won";
  calls.length = 0;
  assert.equal(await owedOnFee(fee, NOW, true), 625);
  assert.equal(posts().length, 0);
  for (const status of ["charge_refunded", "a_status_stripe_adds_later", "PREVENTED"]) {
    shareStatus = status;
    calls.length = 0;
    await assert.rejects(settleFee(fee, NOW, true), status);
    assert.equal(posts().length, 0, status);
  }
});
