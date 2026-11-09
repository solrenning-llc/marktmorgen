/**
 * The siblings of #3318 in lib/refunds.ts (rule 30): every door that reads a
 * Stripe dispute reads its money the same way, from one table
 * (lib/dispute-statuses.ts disputeMoney):
 *   - `lost` gave the money back to the buyer;
 *   - `prevented` gave it back only when the dispute's own balance
 *     transactions show money withdrawn from the creator's account and not
 *     reinstated (a prevention resolved by a refund through the dispute); a
 *     prevention that moved nothing (a network block: the creator kept the
 *     money) or that was reinstated gave nothing back; balance transactions
 *     not in Stripe's shape are unknown (disputeMoneyGone, the rule of #3321,
 *     Claude 6). The card case type (block or
 *     resolution) is not what decides: the money the dispute moved is;
 *   - the legacy `charge_refunded` is not a return by the dispute: the refund
 *     doors (refundedInFull, the /refunds rows) count that money at its own
 *     amount;
 *   - `won`, `warning_closed`, the open stages and the appeal stages
 *     (appeal_needs_response, appeal_under_review) give nothing back;
 *   - a status Stripe does not give, or a prevented dispute whose money
 *     cannot be read, is never passed over: disputeLost throws and the sweep
 *     stops incomplete.
 *
 * On main the doors closed only on `lost`, so a buyer whose dispute was
 * resolved (refunded) before a chargeback had the money back and kept the
 * access. The numbers (lib/retained-revenue.ts) and the share job
 * (lib/share-settle.ts) are #3321's, which reads the same balance
 * transactions (Claude 6).
 *
 * Changed (rule 23; Claude 2's money review of #3323, comment 6732285842):
 * the first version read every `prevented` and `charge_refunded` as money
 * given back. A prevented dispute the network blocked left the money with
 * the creator, and `charge_refunded` was a won dispute on a refunded charge
 * (the refund doors already count it), so the tables below now carry the
 * dispute's balance transactions, `charge_refunded` and the appeal stages
 * moved to NOT_RETURNED, and UNKNOWN holds the prevented disputes whose
 * money cannot be read.
 *
 * Synthetic Stripe only: no real account, no real money.
 */
import { disputeLost, lostDisputesSince, refundedInFull, rowGivesBack } from "@/lib/refunds";
import { DISPUTE_APPEAL_STAGES, DISPUTE_STATUSES, disputeMoney, disputeMoneyFields, disputeMoneyGone } from "@/lib/dispute-statuses";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_c5_prevented_siblings";

const CHARGE = "ch_C5Prevented01";

/** A card dispute's payment_method_details as Stripe gives them, with this case type (shown, never deciding). */
const card = (caseType: unknown) => ({ type: "card", card: { brand: "visa", case_type: caseType, network: "visa", network_reason_code: "10.4" } });
/** One balance transaction a dispute moved: negative withdraws from the creator's account, positive reinstates. */
const txn = (amount: unknown, currency: unknown = "usd") => ({
  id: "txn_C5Prevented01",
  object: "balance_transaction",
  amount,
  currency,
  fee: 1500,
  reporting_category: typeof amount === "number" && amount > 0 ? "dispute_reversal" : "dispute",
  type: "adjustment",
});

/** One dispute as Stripe lists it: its status and whatever else it carries. */
type Shape = { label: string; status: unknown; more?: Record<string, unknown> };
const shape = (label: string, status: unknown, more?: Record<string, unknown>): Shape => ({ label, status, more });

const RETURNED: Shape[] = [
  shape("lost", "lost"),
  shape("lost, its withdrawal listed", "lost", { balance_transactions: [txn(-5000)] }),
  shape("prevented, resolution, withdrawn and not reinstated", "prevented", { payment_method_details: card("resolution"), balance_transactions: [txn(-5000)] }),
  shape("prevented, withdrawn and not reinstated, no case type", "prevented", { balance_transactions: [txn(-5000)] }),
];
const NOT_RETURNED: Shape[] = [
  shape("prevented, block: nothing moved (the creator kept the money)", "prevented", { payment_method_details: card("block"), balance_transactions: [] }),
  shape("prevented, withdrawn and reinstated", "prevented", { balance_transactions: [txn(-5000), txn(5000)] }),
  shape("charge_refunded (a won dispute on a refunded charge; the refund doors count it)", "charge_refunded"),
  ...["won", "warning_closed", "needs_response", "under_review", "warning_needs_response", "warning_under_review", "appeal_needs_response", "appeal_under_review"].map((s) => shape(s, s)),
];
const UNKNOWN: Shape[] = [
  shape("prevented, no balance transactions", "prevented"),
  shape("prevented, resolution but no balance transactions", "prevented", { payment_method_details: card("resolution") }),
  shape("prevented, balance transactions null", "prevented", { balance_transactions: null }),
  shape("prevented, balance transactions as ids", "prevented", { balance_transactions: ["txn_C5Prevented01"] }),
  shape("prevented, an amount that is not whole cents", "prevented", { balance_transactions: [txn(-50.5)] }),
  shape("prevented, an amount as text", "prevented", { balance_transactions: [txn("-5000")] }),
  // Changed (rule 23): #3321's disputeMoneyGone (Claude 6, @31890b10c4), which this PR now copies, reads the amounts and
  // not their currency, so "a balance transaction without its currency" and "two currencies" left this list; three
  // balance transactions (Stripe lists zero, one or two) and an entry that is not a balance transaction joined it.
  shape("prevented, three balance transactions", "prevented", { balance_transactions: [txn(-5000), txn(5000), txn(-5000)] }),
  shape("prevented, an entry that is not a balance transaction", "prevented", { balance_transactions: [{ ...txn(-5000), object: "refund" }] }),
  shape("prevented, more reinstated than withdrawn", "prevented", { balance_transactions: [txn(5000)] }),
  ...["mystery", "", null, undefined, 7, "Lost"].map((s) => shape(`status ${JSON.stringify(s)}`, s)),
];

/** What the synthetic Stripe answers on each path; set per case. */
let disputes: unknown = { object: "list", has_more: false, data: [] };
let events: unknown = { object: "list", has_more: false, data: [] };

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  if (url.pathname === "/v1/disputes") return Response.json(disputes);
  if (url.pathname === "/v1/events") return Response.json(events);
  return new Response(JSON.stringify({ error: { message: "unexpected synthetic endpoint" } }), { status: 404 });
}) as typeof fetch;

const payment = { object: "payment_intent", latest_charge: { object: "charge", id: CHARGE, refunded: false, amount: 5000, amount_refunded: 0, disputed: true } };
const fields = (s: Shape) => ({ status: s.status, ...s.more });
const row = (s: Shape) => ({ id: "du_C5Prevented01", object: "dispute", ...fields(s), charge: CHARGE });

/** What a reading answers, or "threw": a failing case is counted, never the end of the run. */
async function settled(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch {
    return "threw";
  }
}

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

function table() {
  part("lib/dispute-statuses.ts disputeMoney: one reading of a dispute's money");
  for (const s of RETURNED) is(`${s.label}: returned`, settledSync(() => disputeMoney(fields(s))), "returned");
  for (const s of NOT_RETURNED) is(`${s.label}: not returned`, settledSync(() => disputeMoney(fields(s))), "not_returned");
  for (const s of UNKNOWN) is(`${s.label}: unknown`, settledSync(() => disputeMoney(fields(s))), "unknown");
  is("the appeal stages are statuses Stripe gives", [...DISPUTE_APPEAL_STAGES].every((status) => DISPUTE_STATUSES.has(status)), true);
  // Changed (rule 23): the stand-in disputeNetWithdrawnCents gave way to #3321's disputeMoneyGone, so these read true,
  // false and null instead of the cents withdrawn.
  is("disputeMoneyGone: one withdrawal", settledSync(() => disputeMoneyGone({ balance_transactions: [txn(-5000)] })), true);
  is("disputeMoneyGone: withdrawn and reinstated", settledSync(() => disputeMoneyGone({ balance_transactions: [txn(-5000), txn(5000)] })), false);
  is("disputeMoneyGone: nothing moved", settledSync(() => disputeMoneyGone({ balance_transactions: [] })), false);
  is("disputeMoneyGone: missing is unknown, never false", settledSync(() => disputeMoneyGone({ status: "prevented" })), null);
  for (const value of [null, undefined, "prevented", 7, [], [{ status: "lost" }]]) {
    is(`not a dispute (${JSON.stringify(value)}): unknown`, settledSync(() => disputeMoney(value)), "unknown");
  }
  for (const s of [...RETURNED, ...NOT_RETURNED, ...UNKNOWN]) {
    const copy = settledSync(() => disputeMoneyFields(fields(s) as Record<string, unknown>));
    is(`disputeMoneyFields keeps what decides: ${s.label}`, settledSync(() => disputeMoney(copy)), settledSync(() => disputeMoney(fields(s))));
  }
}

function settledSync(run: () => unknown): unknown {
  try {
    return run();
  } catch {
    return "threw";
  }
}

async function doors() {
  part("lib/refunds.ts: a dispute closes the doors only when its money went back to the buyer");
  for (const s of RETURNED) {
    disputes = { object: "list", has_more: false, data: [row(s)] };
    is(`disputeLost: ${s.label} gives the money back`, await settled(() => disputeLost("acct_C5Prevented", payment)), true);
    const built = { ...payment.latest_charge, dispute: fields(s) };
    is(`refundedInFull: a charge written with ${s.label} reads as given back`, refundedInFull(built), true);
    is(`rowGivesBack: a ${s.label} dispute row takes the sale back`, rowGivesBack({ object: "dispute", id: "evt_C5Prevented01", ...fields(s), charge: built }), true);
  }
  for (const s of NOT_RETURNED) {
    disputes = { object: "list", has_more: false, data: [row(s)] };
    is(`disputeLost: ${s.label} gives nothing back`, await settled(() => disputeLost("acct_C5Prevented", payment)), false);
    const built = { ...payment.latest_charge, dispute: fields(s) };
    is(`refundedInFull: a charge written with ${s.label} keeps the sale`, refundedInFull(built), false);
    is(`rowGivesBack: a ${s.label} dispute row takes nothing back`, rowGivesBack({ object: "dispute", id: "evt_C5Prevented01", ...fields(s), charge: built }), false);
  }
  for (const s of UNKNOWN) {
    disputes = { object: "list", has_more: false, data: [row(s)] };
    is(`disputeLost: ${s.label} is never read as "not lost"`, await rejects(() => disputeLost("acct_C5Prevented", payment)), true);
    const built = { ...payment.latest_charge, dispute: fields(s) };
    is(`rowGivesBack: a ${s.label} dispute row never takes the sale back`, rowGivesBack({ object: "dispute", id: "evt_C5Prevented01", ...fields(s), charge: built }), false);
  }
  const resolution = RETURNED[2];
  const block = NOT_RETURNED[0];
  disputes = { object: "list", has_more: false, data: [row(UNKNOWN[0]), row(resolution)] };
  is("disputeLost: its own returned dispute decides even beside an unknown one", await settled(() => disputeLost("acct_C5Prevented", payment)), true);
  disputes = { object: "list", has_more: false, data: [row(block), row(UNKNOWN[0])] };
  is("disputeLost: a blocked one beside an unknown one is not decided", await rejects(() => disputeLost("acct_C5Prevented", payment)), true);

  part("lib/refunds.ts lostDisputesSince: the sweep reads every closing whose money went back, and carries what decided it");
  const event = (id: string, s: Shape) => ({ id, created: 1_800_000_000, data: { object: { ...fields(s), payment_intent: "pi_C5Prevented01", charge: CHARGE } } });
  events = {
    object: "list",
    has_more: false,
    data: [
      event("evt_C5Lost000001", RETURNED[0]),
      event("evt_C5Resolved01", resolution),
      event("evt_C5Blocked001", block),
      event("evt_C5Reinstate1", NOT_RETURNED[1]),
      event("evt_C5ChargeRef01", NOT_RETURNED[2]),
      event("evt_C5Won0000001", shape("won", "won")),
      event("evt_C5Closed0001", shape("warning_closed", "warning_closed")),
    ],
  };
  const read = await lostDisputesSince("acct_C5Prevented", 0);
  is("lostDisputesSince: reads the whole page", read.complete, true);
  is("lostDisputesSince: lost and a resolved prevention become rows; a blocked one, a reinstated one, charge_refunded, won and warning_closed do not", read.rows.map((r) => r.id), ["evt_C5Lost000001", "evt_C5Resolved01"]);
  is("lostDisputesSince: every row it builds is one the jobs take back", read.rows.every((r) => rowGivesBack(r)), true);
  // Changed (rule 23): read with disputeMoneyGone (true) instead of the stand-in's cents (5000).
  is("lostDisputesSince: the resolved row carries what the dispute withdrew", settledSync(() => disputeMoneyGone(read.rows[1])), true);
  is("lostDisputesSince: and so does the charge it writes", refundedInFull(read.rows[1]?.charge), true);
  for (const s of UNKNOWN.slice(0, 9)) {
    events = { object: "list", has_more: false, data: [event("evt_C5Unknown001", s)] };
    is(`lostDisputesSince: ${s.label} stops the sweep incomplete`, (await lostDisputesSince("acct_C5Prevented", 0)).complete, false);
  }
  events = { object: "list", has_more: false, data: [{ id: "evt_C5NoCharge01", created: 1_800_000_000, data: { object: { ...fields(resolution), payment_intent: "pi_C5Prevented01", charge: null } } }] };
  is("lostDisputesSince: a resolved prevention without its charge is unknown, never passed over", (await lostDisputesSince("acct_C5Prevented", 0)).complete, false);
  events = { object: "list", has_more: false, data: [{ id: "evt_C5NoCharge02", created: 1_800_000_000, data: { object: { ...fields(block), payment_intent: "pi_C5Prevented01", charge: null } } }] };
  is("lostDisputesSince: a blocked one needs no charge: it takes nothing back", (await lostDisputesSince("acct_C5Prevented", 0)).complete, true);
}

async function main() {
  table();
  await doors();
}

main().then(done);
