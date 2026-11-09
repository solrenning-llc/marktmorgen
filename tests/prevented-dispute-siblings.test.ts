/**
 * A dispute Stripe closes as `prevented` gave the money back to the buyer
 * only when Stripe actually took it back (Claude 5's second money review of
 * #3318, CX-123 rule 30 siblings; Claude 2's first money review of #3321,
 * 9 November 2026). Stripe's API reference (Dispute object,
 * payment_method_details.card.case_type; changelog basil 2025-08-27): a
 * `resolution` was "resolved (refunded) before it could become a
 * chargeback", a `block` was blocked by the card network and the merchant
 * keeps the money. case_type does not exist at the versions read here
 * (2024-06-20 and the account default), so the money is read from the
 * dispute's own `balance_transactions`, "zero, one, or two balance
 * transactions that show funds withdrawn and reinstated to your Stripe
 * account as a result of this dispute" (stripe-node v12.18.0
 * types/Disputes.d.ts, v22.6.0 src/resources/Disputes.ts), whose `amount`
 * is negative for funds sent to another party (BalanceTransactions.ts):
 *
 *   - withdrawn more than reinstated: the buyer got the money back (resolution);
 *   - nothing withdrawn, or all of it reinstated: the creator kept it (block);
 *   - a list or an amount not in that shape: unknown (rule 24). The store's
 *     numbers do not count it and say they are partial; share-settle gives
 *     nothing back and keeps the fee for the next run.
 *
 * Kept as they are: `lost` (status alone, as today); the legacy
 * `charge_refunded` (removed in API 2023-08-16) went back through a refund,
 * which the refund readings already count; the affiliate book still reads
 * the status alone (lib/affiliates.ts disputesSince, rewritten by open #3189),
 * so every prevented dispute there holds the commission, the side that never
 * pays on money the buyer may have got back. A refund's money is a Refund's
 * own balance transaction, never one of the dispute's, so a resolution that
 * also made a Refund is counted once.
 * Synthetic Stripe stand-in only; no real provider is called.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as retained from "@/lib/retained-revenue";
import { readStoreDisputes, readStoreRefunds } from "@/lib/stats";
import { disputesSince } from "@/lib/affiliates";
import { owedOnFee, settleFee } from "@/lib/share-settle";
import type { Store } from "@/lib/store";

process.env.STRIPE_SECRET_KEY = "sk_test_prevented_dispute_stand_in";

const ACCOUNT = "acct_TestPrevented01";
const SINCE = 1_790_000_000;
const fee = { id: "fee_PreventedProof01", account: ACCOUNT, charge: "ch_PreventedProof01", amount: 625, refunded: 0, currency: "usd" };
const NOW = 1_800_000_000;

const moved = (...amounts: number[]) => amounts.map((amount, n) => ({ id: `txn_TestMoved0${n}`, object: "balance_transaction", amount, currency: "usd" }));
/** What Stripe lists for a resolution: the disputed amount withdrawn from the creator's balance. */
const RESOLUTION = moved(-3000);
/** What Stripe lists for a block: nothing moved. */
const BLOCK: unknown[] = [];

type Row = [status: string, amount: number, intent: string, movement?: unknown];
const row = ([status, amount, intent, movement]: Row, n: number): Record<string, unknown> => ({
  id: `du_TestListed${String(n).padStart(2, "0")}`, object: "dispute", status, amount, currency: "usd", created: SINCE + 10, payment_intent: intent,
  ...(movement === undefined ? {} : { balance_transactions: movement }),
});

/** One dispute of every status the store's numbers may meet, each on its own payment; every prevented one's money is readable. */
const HEALTHY: Row[] = [
  ["lost", 4000, "pi_lost", moved(-4000)],
  ["prevented", 3000, "pi_resolution", RESOLUTION],
  ["prevented", 2500, "pi_block", BLOCK],
  ["prevented", 2200, "pi_reinstated", moved(-2200, 2200)],
  ["charge_refunded", 2000, "pi_chargerefunded"],
  ["won", 5000, "pi_won", moved(-5000, 5000)],
  ["warning_closed", 900, "pi_warningclosed", []],
  ["warning_needs_response", 800, "pi_warningneedsresponse", []],
  ["needs_response", 700, "pi_needsresponse", moved(-700)],
  ["under_review", 600, "pi_underreview", moved(-600)],
  ["a_status_stripe_adds_later", 7000, "pi_later", moved(-7000)],
];
/** Prevented disputes whose money movement is not in Stripe's shape. */
const UNREADABLE: unknown[] = [
  undefined,
  null,
  "txn_TestMoved00",
  [null],
  ["txn_TestMoved00"],
  [{ object: "balance_transaction" }],
  [{ object: "balance_transaction", amount: "-3000" }],
  [{ object: "balance_transaction", amount: -30.5 }],
  [{ object: "refund", amount: -3000 }],
  moved(3000),
  moved(-1000, -1000, -1000),
];

let listed: Record<string, unknown>[] = HEALTHY.map(row);
/** The charge's own dispute row, for share-settle. */
let shareDispute: Record<string, unknown> = { status: "prevented", balance_transactions: RESOLUTION };
let chargeRefunded = 0;
const calls: { url: URL; method: string; headers: Headers; body: URLSearchParams }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  calls.push({ url, method, headers: new Headers(init?.headers), body: new URLSearchParams(String(init?.body ?? "")) });
  assert.equal(url.origin, "https://api.stripe.com");
  if (url.pathname === `/v1/charges/${fee.charge}`) {
    return Response.json({ object: "charge", id: fee.charge, currency: "usd", amount: 10000, amount_refunded: chargeRefunded, disputed: true, invoice: null, payment_intent: { object: "payment_intent", id: "pi_PreventedProof01", currency: "usd", amount: 10000, latest_charge: fee.charge, metadata: { share_bps: "625", share_base: "10000" } } });
  }
  if (url.pathname === "/v1/disputes" && url.searchParams.get("charge") === fee.charge) {
    return Response.json({ object: "list", has_more: false, data: [{ id: "du_PreventedProof01", object: "dispute", charge: fee.charge, currency: "usd", ...shareDispute }] });
  }
  if (url.pathname === "/v1/disputes") return Response.json({ object: "list", has_more: false, data: listed });
  if (url.pathname === "/v1/refunds") {
    // The Refund a resolution may also have made, on the block's payment: its own money movement, not the dispute's.
    return Response.json({ object: "list", has_more: false, data: [{ id: "re_TestResolved01", object: "refund", status: "succeeded", amount: 2500, currency: "usd", created: SINCE + 20, payment_intent: "pi_block" }] });
  }
  if (url.pathname === `/v1/application_fees/${fee.id}/refunds`) {
    return Response.json({ object: "fee_refund", id: "fr_PreventedProof01", fee: fee.id, amount: Number(new URLSearchParams(String(init?.body ?? "")).get("amount")), currency: "usd" });
  }
  throw Error(`Unexpected synthetic endpoint ${url.pathname}`);
}) as typeof fetch;

const store = { stripeAccountId: ACCOUNT } as unknown as Store;
const posts = () => calls.filter((call) => call.method === "POST");
type Takes = (dispute: Record<string, unknown>) => boolean | null;
const disputeTakes = (dispute: Record<string, unknown>) => {
  const read = (retained as unknown as { disputeTakes?: Takes }).disputeTakes;
  assert.equal(typeof read, "function", "lib/retained-revenue.ts exports disputeTakes");
  return (read as Takes)(dispute);
};
const prevented = (movement: unknown): Record<string, unknown> => (movement === undefined ? { status: "prevented" } : { status: "prevented", balance_transactions: movement });

test("a prevented dispute takes the money only when its own balance transactions withdrew it", () => {
  assert.equal(disputeTakes(prevented(RESOLUTION)), true);
  assert.equal(disputeTakes(prevented(BLOCK)), false);
  assert.equal(disputeTakes(prevented(moved(-2200, 2200))), false);
  for (const movement of UNREADABLE) assert.equal(disputeTakes(prevented(movement)), null, JSON.stringify(movement));
  // Every other status reads as today, by its status alone.
  for (const status of ["lost", "needs_response", "under_review"]) assert.equal(disputeTakes({ status, balance_transactions: [] }), true, status);
  for (const status of ["won", "warning_closed", "warning_needs_response", "warning_under_review", "charge_refunded", "a_status_stripe_adds_later", "PREVENTED", "", "__proto__"]) {
    assert.equal(disputeTakes({ status, balance_transactions: moved(-100) }), false, JSON.stringify(status));
  }
  assert.equal(disputeTakes({}), false);
});

test("the status-only list still holds prevented, so a reader of the status alone never pays on it", () => {
  for (const status of ["lost", "prevented", "needs_response", "under_review"]) assert.equal(retained.DISPUTE_TAKES.has(status), true, status);
  for (const status of ["won", "warning_closed", "warning_needs_response", "warning_under_review", "charge_refunded"]) assert.equal(retained.DISPUTE_TAKES.has(status), false, status);
  for (const status of ["a_status_stripe_adds_later", "LOST", "Prevented", " prevented", "", "__proto__"]) assert.equal(retained.DISPUTE_TAKES.has(status), false, JSON.stringify(status));
});

test("the store's numbers take off a resolution's money, never a block's", async () => {
  listed = HEALTHY.map(row);
  const { rows, partial } = await readStoreDisputes(store, SINCE);
  assert.equal(partial, false);
  assert.deepEqual(rows.map((r) => [r.paymentIntent, r.cents]).sort(), [
    ["pi_lost", 4000],
    ["pi_needsresponse", 700],
    ["pi_resolution", 3000],
    ["pi_underreview", 600],
  ]);
});

test("a prevented dispute whose money cannot be read is not counted, and the numbers say they are partial", async () => {
  for (const movement of UNREADABLE) {
    listed = [...HEALTHY, ["prevented", 1900, "pi_unknown", movement] as Row].map(row);
    const { rows, partial } = await readStoreDisputes(store, SINCE);
    assert.equal(partial, true, JSON.stringify(movement));
    assert.equal(rows.some((r) => r.paymentIntent === "pi_unknown"), false, JSON.stringify(movement));
    assert.equal(rows.length, 4, JSON.stringify(movement));
  }
  listed = HEALTHY.map(row);
});

test("a resolution that also made a Refund is counted once: the refund reading has it, the dispute reading does not", async () => {
  listed = HEALTHY.map(row);
  const disputes = await readStoreDisputes(store, SINCE);
  const refunds = await readStoreRefunds(store, SINCE, 1);
  const onBlock = [...disputes.rows, ...refunds.rows].filter((r) => r.paymentIntent === "pi_block");
  assert.deepEqual(onBlock.map((r) => r.cents), [2500]);
});

test("the affiliate book still reads the status alone: every prevented dispute holds the commission", async () => {
  listed = HEALTHY.map(row);
  const { byIntent, complete } = await disputesSince(store, SINCE);
  assert.equal(complete, true);
  assert.deepEqual([...byIntent.entries()].sort(), [
    ["pi_block", 2500],
    ["pi_lost", 4000],
    ["pi_needsresponse", 700],
    ["pi_reinstated", 2200],
    ["pi_resolution", 3000],
    ["pi_underreview", 600],
  ]);
});

test("a lost dispute, or a prevented one that withdrew the money, gives the platform share back once", async () => {
  for (const dispute of [{ status: "lost" }, prevented(RESOLUTION)]) {
    shareDispute = dispute;
    chargeRefunded = 0;
    calls.length = 0;
    assert.equal(await owedOnFee(fee, NOW, true), 0, String(dispute.status));
    assert.equal(await settleFee(fee, NOW, true), 625, String(dispute.status));
    assert.equal(posts().length, 1, String(dispute.status));
    assert.equal(posts()[0].headers.get("Idempotency-Key"), `share-back:${fee.id}:0:625`);
    assert.deepEqual(Object.fromEntries(posts()[0].body), { amount: "625" });
  }
});

test("a blocked prevented dispute keeps the share, as a won one does", async () => {
  for (const dispute of [{ status: "won" }, prevented(BLOCK), prevented(moved(-10000, 10000))]) {
    shareDispute = dispute;
    chargeRefunded = 0;
    calls.length = 0;
    assert.equal(await owedOnFee(fee, NOW, true), 625, JSON.stringify(dispute));
    assert.equal(await settleFee(fee, NOW, true), 0, JSON.stringify(dispute));
    assert.equal(posts().length, 0, JSON.stringify(dispute));
  }
});

test("a prevented dispute whose money cannot be read gives nothing back and keeps the fee for the next run", async () => {
  chargeRefunded = 0;
  for (const movement of UNREADABLE) {
    shareDispute = prevented(movement);
    calls.length = 0;
    await assert.rejects(owedOnFee(fee, NOW, true), /Dispute status is unknown/, JSON.stringify(movement));
    await assert.rejects(settleFee(fee, NOW, true), /Dispute status is unknown/, JSON.stringify(movement));
    assert.equal(posts().length, 0, JSON.stringify(movement));
  }
});

test("a prevented dispute on a payment refunded in full gives the share back once, for the refund", async () => {
  for (const dispute of [prevented(BLOCK), prevented(RESOLUTION)]) {
    shareDispute = dispute;
    chargeRefunded = 10000;
    calls.length = 0;
    assert.equal(await owedOnFee(fee, NOW, true), 0);
    assert.equal(await settleFee(fee, NOW, true), 625);
    assert.equal(posts().length, 1);
    assert.equal(posts()[0].headers.get("Idempotency-Key"), `share-back:${fee.id}:0:625`);
  }
  // Once given back, a later run finds the fee refunded and calls nothing.
  calls.length = 0;
  assert.equal(await settleFee({ ...fee, refunded: 625 }, NOW, true), 0);
  assert.equal(calls.length, 0);
  chargeRefunded = 0;
});

test("a status the pinned version cannot send, or one unknown, still gives nothing back", async () => {
  chargeRefunded = 0;
  for (const status of ["charge_refunded", "a_status_stripe_adds_later", "PREVENTED"]) {
    shareDispute = { status, balance_transactions: RESOLUTION };
    calls.length = 0;
    await assert.rejects(settleFee(fee, NOW, true), status);
    assert.equal(posts().length, 0, status);
  }
});
