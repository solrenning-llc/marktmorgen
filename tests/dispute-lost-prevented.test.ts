/**
 * A prevented dispute in the rule every door uses (lib/refunds.ts, disputeLost), read by its own money
 * (disputeMoneyGone, lib/retained-revenue.ts, Claude 6's #3321).
 *
 * Stripe's `prevented` is either a resolution, "resolved (refunded) before it could become a chargeback", or a
 * block, stopped by the card network while the creator keeps the money. Before this unit only "lost" closed the
 * doors, so a buyer whose bank took the money back through a resolution kept the course, the community, the
 * download, the order list and the booked call for good, and a pre-order or an offer's file was handed over on it.
 *
 * Now a prevented row whose own balance transactions took the money and did not put it back is lost, as "lost" is;
 * one that took nothing, or put it all back (a block), is not; and one whose money cannot be read is neither (CX-123
 * rule 24): disputeLost() throws, so the doors that let in stay open, as when Stripe is slow, and the readings that
 * hand something over wait. This charge's own lost row still decides whatever else the list holds.
 *
 * The jobs that take things back (licence keys, call meetings, review proof, gifts, pre-orders) read the same rule
 * from Stripe's closing events (lostDisputesSince) and judge each row with rowGivesBack. A resolution there is a row
 * that gives the sale back; a block is no row; and a prevented closing whose money cannot be read stops the page as
 * not read whole, so each job keeps its place and reads it again, never moving past it as "not given back".
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts. Nothing real is reached.
 */
import { disputeLost, givenBack, keptUnlessLost, lostDisputesSince, purchaseRefunded, rowGivesBack } from "@/lib/refunds";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_dispute_lost_prevented_synthetic";

const ACCOUNT = "acct_disputeprev01";
const CHARGE = "ch_disputeprev0001";
const INTENT = "pi_disputeprev0001";

let listed: unknown;
let events: unknown;
let calls: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  calls.push(`${path}?charge=${url.searchParams.get("charge") ?? ""}`);
  if (path === "/disputes") return Response.json(listed);
  if (path === "/events") return Response.json(events);
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

/** This buyer's payment, not refunded, its charge marked disputed: the only kind of payment Stripe is asked about. */
const payment = { id: INTENT, object: "payment_intent", latest_charge: { object: "charge", id: CHARGE, payment_intent: INTENT, amount: 2000, amount_refunded: 0, refunded: false, disputed: true } };
const session = { mode: "payment", payment_intent: payment, metadata: {} };

const move = (amount: unknown) => ({ id: `txn_prev${String(amount).replace(/\W/g, "")}`, object: "balance_transaction", amount });
const dispute = (over: Record<string, unknown> = {}) => ({ id: "du_disputeprev01", object: "dispute", charge: CHARGE, payment_intent: INTENT, amount: 2000, status: "prevented", ...over });
const whole = (...data: unknown[]) => ({ object: "list", data, has_more: false });


/** One closing event of a dispute on this charge, as Stripe lists charge.dispute.closed. */
const closing = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  object: "event",
  type: "charge.dispute.closed",
  created: 1_800_000_000,
  data: { object: { id: `du_${id.slice(4)}`, object: "dispute", charge: CHARGE, payment_intent: INTENT, amount: 2000, status: "prevented", ...over } },
});
const page = (...data: unknown[]) => ({ object: "list", data, has_more: false });

type Swept = { rows: Record<string, unknown>[]; complete: boolean };
async function sweep(reply: unknown): Promise<Swept> {
  events = reply;
  const read = await lostDisputesSince(ACCOUNT, 1_799_000_000);
  return { rows: read.rows, complete: read.complete };
}
const gives = (row: Record<string, unknown>): boolean | "throws" => {
  try {
    return rowGivesBack(row);
  } catch {
    return "throws";
  }
};

type Read = { lost: boolean | "unknown"; door: boolean; given: boolean | "unknown"; calls: number };

/** One reading of the same reply by each kind of caller: disputeLost itself, a door that lets in, and givenBack. */
async function read(reply: unknown): Promise<Read> {
  listed = reply;
  calls = [];
  const lost = await disputeLost(ACCOUNT, payment).catch(() => "unknown" as const);
  const kept = await keptUnlessLost(ACCOUNT, payment);
  const door = await purchaseRefunded(ACCOUNT, session);
  if (kept !== door) throw new Error("keptUnlessLost and purchaseRefunded disagree on one payment");
  const given = await givenBack(ACCOUNT, payment).catch(() => "unknown" as const);
  return { lost, door, given, calls: calls.length };
}

async function main() {
  const original = console.error;
  console.error = () => {};
  try {
    part("A resolution: the money was taken and not put back");
    let got = await read(whole(dispute({ balance_transactions: [move(-2000)] })));
    is("a prevented dispute that took the money: lost", got.lost, true);
    is("and the doors close", got.door, true);
    is("and it is given back", got.given, true);
    is("one request a reading, as today (four readings)", got.calls, 4);
    got = await read(whole(dispute({ balance_transactions: [move(-2000), move(500)] })));
    is("taken, part put back: still lost (the bank kept some of it)", [got.lost, got.door, got.given], [true, true, true]);
    got = await read(whole(dispute({ status: "won" }), dispute({ id: "du_disputeprev02", balance_transactions: [move(-2000)] })));
    is("a won row beside a resolution: the resolution decides, lost", [got.lost, got.door, got.given], [true, true, true]);

    part("A block: the creator keeps the money");
    got = await read(whole(dispute({ balance_transactions: [] })));
    is("a prevented dispute that took nothing: not lost", got.lost, false);
    is("and the doors stay open", got.door, false);
    is("and it is not given back", got.given, false);
    got = await read(whole(dispute({ balance_transactions: [move(-2000), move(2000)] })));
    is("taken and put back in full: not lost", [got.lost, got.door, got.given], [false, false, false]);

    part("A prevented dispute whose money cannot be read: neither (rule 24)");
    for (const [what, over] of [
      ["no balance_transactions", {}],
      ["balance_transactions null", { balance_transactions: null }],
      ["balance_transactions as text", { balance_transactions: "txn_prev" }],
      ["an amount as text", { balance_transactions: [move("-2000")] }],
      ["a move that is not a balance transaction", { balance_transactions: [{ object: "charge", amount: -2000 }] }],
      ["three moves", { balance_transactions: [move(-2000), move(1000), move(1000)] }],
      ["more put back than taken", { balance_transactions: [move(-1000), move(2000)] }],
    ] as const) {
      got = await read(whole(dispute(over)));
      is(`${what}: disputeLost cannot say, so it throws`, got.lost, "unknown");
      is(`${what}: the doors stay open for a buyer who paid`, got.door, false);
      is(`${what}: givenBack cannot say either, so nothing is handed over on it`, got.given, "unknown");
    }

    part("This charge's own lost row still decides");
    got = await read(whole(dispute({ id: "du_disputeprev02" }), dispute({ status: "lost" })));
    is("an unreadable prevented row beside this charge's lost one: lost", [got.lost, got.door, got.given], [true, true, true]);
    got = await read({ object: "list", data: [dispute({ balance_transactions: [move(-2000)] })], has_more: true });
    is("a resolution on a page not said to be whole: lost, the rest cannot undo it", [got.lost, got.door, got.given], [true, true, true]);
    got = await read({ object: "list", data: [dispute({ balance_transactions: [] })], has_more: true });
    is("a block on a page not said to be whole: unknown, never 'not lost'", got.lost, "unknown");

    part("The jobs: a resolution is a row that gives the sale back (lostDisputesSince, rowGivesBack)");
    let swept = await sweep(page(closing("evt_prevgone01", { balance_transactions: [move(-2000)] })));
    is("a resolution's closing: read whole", swept.complete, true);
    is("and it is one row", swept.rows.length, 1);
    is("that gives the sale back", swept.rows.map(gives), [true]);
    is("for this payment", swept.rows.map((row) => row.payment_intent), [INTENT]);
    swept = await sweep(page(closing("evt_prevlost01", { status: "lost" })));
    is("control: a lost closing is still one row that gives back", [swept.complete, swept.rows.map(gives)], [true, [true]]);

    part("The jobs: a block is no row");
    swept = await sweep(page(closing("evt_prevblock1", { balance_transactions: [] })));
    is("a closing that took nothing: read whole, no row", [swept.complete, swept.rows.length], [true, 0]);
    swept = await sweep(page(closing("evt_prevblock2", { balance_transactions: [move(-2000), move(2000)] })));
    is("a closing that put it all back: read whole, no row", [swept.complete, swept.rows.length], [true, 0]);

    part("The jobs: a prevented closing whose money cannot be read stops the page (rule 24)");
    swept = await sweep(page(closing("evt_prevunk001")));
    is("no balance_transactions: not read whole", swept.complete, false);
    is("and no row from that page (the place stays before it)", swept.rows.length, 0);
    swept = await sweep(page(closing("evt_prevlost02", { status: "lost" }), closing("evt_prevunk002", { balance_transactions: [move("-2000")] })));
    is("a lost closing beside an unreadable prevented one: the page is not read whole", [swept.complete, swept.rows.length], [false, 0]);

    part("rowGivesBack on a prevented row");
    const row = (over: Record<string, unknown>) => ({ object: "dispute", id: "evt_prevrow001", status: "prevented", created: 1_800_000_000, payment_intent: INTENT, charge: { object: "charge", id: CHARGE, disputed: true, dispute: { status: "lost" } }, ...over });
    is("money taken and not put back: gives back", gives(row({ balance_transactions: [move(-2000)] })), true);
    is("nothing taken: does not give back", gives(row({ balance_transactions: [] })), false);
    is("money that cannot be read: throws, never 'not given back'", gives(row({ balance_transactions: null })), "throws");
  } finally {
    console.error = original;
  }
  done();
}

void main();
