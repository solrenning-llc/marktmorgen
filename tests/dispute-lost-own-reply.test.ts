/**
 * Rule 30 in the dispute rule every door uses (lib/refunds.ts, disputeLost): Stripe's list of a charge's disputes
 * decides only from rows that are this charge's own, and decides "not lost" only when the list says it is whole.
 *
 * A charge marked disputed is asked about with `GET /disputes?charge=`. Before this unit any row with status "lost"
 * closed the doors, whoever's charge it named, and a list not said to be whole, or not a list at all, read as "not
 * lost". So another charge's lost dispute, or a row naming no charge, would close the course, the community, the
 * download, the order list and the booked call on a buyer who paid; and a reply that is not a whole list would let a
 * pre-order be handed over, or an offer's file be downloaded, on a payment the bank may have taken back.
 *
 * Each such reply must read as Stripe not having answered: disputeLost() throws, so the doors that let in
 * (keptUnlessLost, purchaseRefunded) stay open as they do when Stripe is slow, and the readings that hand something
 * over (givenBack: the pre-order job, the offer download) wait and read again. No request beyond the one made today.
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts. Nothing real is reached.
 */
import { disputeLost, givenBack, keptUnlessLost, purchaseRefunded } from "@/lib/refunds";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_dispute_lost_own_reply_synthetic";

const ACCOUNT = "acct_disputeown01";
const CHARGE = "ch_disputeown0001";
const OTHER_CHARGE = "ch_disputeother01";
const INTENT = "pi_disputeown0001";

let listed: unknown;
let calls: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  calls.push(`${path}?charge=${url.searchParams.get("charge") ?? ""}`);
  if (path === "/disputes") return Response.json(listed);
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

/** This buyer's payment, not refunded, its charge marked disputed: the only kind of payment Stripe is asked about. */
const payment = { id: INTENT, object: "payment_intent", latest_charge: { object: "charge", id: CHARGE, payment_intent: INTENT, amount: 2000, amount_refunded: 0, refunded: false, disputed: true } };
const session = { mode: "payment", payment_intent: payment, metadata: {} };

const dispute = (over: Record<string, unknown> = {}) => ({ id: "du_disputeown01", object: "dispute", charge: CHARGE, payment_intent: INTENT, amount: 2000, status: "lost", ...over });
const whole = (...data: unknown[]) => ({ object: "list", data, has_more: false });

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

/** A reply that is not this charge's whole list: never "lost" from it, never "not lost" either, one request a reading. */
async function notJudged(what: string, reply: unknown) {
  const got = await read(reply);
  is(`${what}: disputeLost cannot say, so it throws`, got.lost, "unknown");
  is(`${what}: the doors stay open for a buyer who paid`, got.door, false);
  is(`${what}: givenBack cannot say either, so nothing is handed over on it`, got.given, "unknown");
  is(`${what}: one request a reading, as today (four readings)`, got.calls, 4);
}

async function main() {
  const original = console.error;
  console.error = () => {};
  try {
    part("Controls: this charge's own whole list");
    let got = await read(whole(dispute()));
    is("its own lost dispute: lost", got.lost, true);
    is("and the doors close", got.door, true);
    is("and it is given back", got.given, true);
    is("one request a reading", got.calls, 4);
    got = await read(whole(dispute({ charge: { id: CHARGE, object: "charge" } })));
    is("its own lost dispute with the charge expanded: lost", [got.lost, got.door, got.given], [true, true, true]);
    got = await read(whole(dispute({ status: "won" }), dispute({ id: "du_disputeown02", status: "needs_response" })));
    is("a whole list with no lost row: not lost", got.lost, false);
    is("and the doors stay open", got.door, false);
    is("and it is not given back", got.given, false);
    got = await read(whole());
    is("a whole empty list: not lost", [got.lost, got.door, got.given], [false, false, false]);
    is("and the request named this charge", calls.every((call) => call === `/disputes?charge=${CHARGE}`), true);

    part("A row naming another charge, lost");
    await notJudged("another charge's lost row", whole(dispute({ charge: OTHER_CHARGE })));
    await notJudged("another charge's lost row, expanded", whole(dispute({ charge: { id: OTHER_CHARGE, object: "charge" } })));
    await notJudged("another charge's lost row beside this charge's won one", whole(dispute({ status: "won" }), dispute({ id: "du_disputeown02", charge: OTHER_CHARGE })));
    await notJudged("another charge's won row (its list is not this charge's)", whole(dispute({ charge: OTHER_CHARGE, status: "won" })));

    part("A row naming no charge, lost");
    await notJudged("a lost row with no charge", whole(dispute({ charge: undefined })));
    await notJudged("a lost row with a null charge", whole(dispute({ charge: null })));
    await notJudged("a lost row with an empty charge", whole(dispute({ charge: "" })));

    part("A reply that is not a list");
    await notJudged("JSON null", null);
    await notJudged("an empty object", {});
    await notJudged("a bare array", [dispute({ status: "won" })]);
    await notJudged("data that is not an array", { object: "list", data: "du_disputeown01", has_more: false });
    await notJudged("data null", { object: "list", data: null, has_more: false });

    part("A list not said to be whole");
    await notJudged("has_more true, no lost row on this page", { object: "list", data: [dispute({ status: "won" })], has_more: true });
    await notJudged("no has_more", { object: "list", data: [dispute({ status: "won" })] });
    await notJudged("has_more as text", { object: "list", data: [], has_more: "false" });
    got = await read({ object: "list", data: [dispute()], has_more: true });
    is("has_more true with this charge's own lost row: lost, the rest cannot undo it", [got.lost, got.door, got.given], [true, true, true]);

    part("A row that is not an object");
    await notJudged("a row that is text", whole(dispute({ status: "won" }), "du_disputeown02"));
    await notJudged("a row that is null", whole(null));
    await notJudged("a row that is an array", whole([dispute()]));
  } finally {
    console.error = original;
  }
  done();
}

void main();
