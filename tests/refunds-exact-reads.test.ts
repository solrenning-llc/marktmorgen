/**
 * lib/refunds.ts reads two replies in their exact shape (CX-123 rule 24):
 *
 *   - confirmLostRead(): the SMISMEMBER of a job's set of lost-dispute rows
 *     already read. A flag is the integer 1 (handled) or 0 (not handled).
 *     Before, any flag that coerced to 1 ("1", true, [1], " 1 ") counted as
 *     handled, so the job's place in the lost disputes moved on and a dispute
 *     never handled was never read again: its licence key, gift, pre-order,
 *     call meeting or review stayed with a buyer whose bank took the money
 *     back. Now any other reply throws and the place is not written.
 *   - disputeLost(): the list of a disputed charge's disputes. Before, a list
 *     in another shape, or a row with a status Stripe never gives, read as
 *     "not lost", so givenBack() said "not given back" and a pre-order was
 *     handed over (lib/preorders.ts) or an offer's file downloaded
 *     (lib/upsell.ts, offerRefunded) for a payment that may be lost. Now it
 *     throws, as when Stripe cannot be asked; keptUnlessLost() still lets in.
 *
 * Synthetic store and stand-in Stripe only.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { confirmLostRead, disputeLost, givenBack, keptUnlessLost, type LostRead } from "@/lib/refunds";
import { offerRefunded } from "@/lib/upsell";
import type { Store } from "@/lib/store";

process.env.STRIPE_SECRET_KEY = "sk_test_refunds_exact_only_a_stand_in";

const ACCOUNT = "acct_refundsexact01";
const SEEN = "nl:test:refunds-exact:seen";
const CHARGE = "ch_refundsexact0001";

/** What GET /disputes?charge= answers next: a body and a status. */
let disputesAnswer: { body: unknown; status: number } = { body: { object: "list", data: [], has_more: false }, status: 200 };
let disputeReads = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/disputes") {
    disputeReads += 1;
    return answer(disputesAnswer.body, disputesAnswer.status);
  }
  if (path.startsWith("/payment_intents/")) {
    return answer({ id: path.split("/")[2], object: "payment_intent", latest_charge: { object: "charge", id: CHARGE, disputed: true, refunded: false, amount: 2500, amount_refunded: 0 } });
  }
  return answer({ error: { message: `no stand-in for ${path}` } }, 404);
}) as typeof fetch;

const disputedPayment = { id: "pi_refundsexact0001", object: "payment_intent", latest_charge: { object: "charge", id: CHARGE, disputed: true, refunded: false, amount: 2500, amount_refunded: 0 } };

function lostRead(ids: string[]): { read: LostRead; state: { committed: number } } {
  const state = { committed: 0 };
  const read: LostRead = {
    rows: ids.map((id) => ({ object: "dispute", id, status: "lost" })),
    complete: true,
    newest: 1,
    resumed: false,
    commit: async () => {
      state.committed += 1;
    },
  };
  return { read, state };
}

async function outcome<T>(run: () => Promise<T>): Promise<T | string> {
  try {
    return await run();
  } catch (error) {
    return `threw ${(error as Error).name}`;
  }
}

async function main() {
  part("confirmLostRead: the healthy readings keep their meaning");
  redis.clear();
  {
    const { read, state } = lostRead([]);
    is("no row read: the place is kept", [await confirmLostRead(read, SEEN), state.committed], [true, 1]);
  }
  await redis.pipeline([["SADD", SEEN, "evt_refundsexact0001", "evt_refundsexact0002"]]);
  {
    const { read, state } = lostRead(["evt_refundsexact0001", "evt_refundsexact0002"]);
    is("every row handled (1, 1): the place is kept", [await confirmLostRead(read, SEEN), state.committed], [true, 1]);
  }
  {
    const { read, state } = lostRead(["evt_refundsexact0001", "evt_refundsexact0003"]);
    is("one row not handled (1, 0): the place stays", [await confirmLostRead(read, SEEN), state.committed], [false, 0]);
  }

  part("confirmLostRead: a reply in another shape is unknown, never handled");
  // evt_refundsexact0003 is not in the set: only an unknown reply can make it look handled.
  const shapes: [string, unknown][] = [
    ["flags as text", [["1", "1"]]],
    ["flags as booleans", [[true, true]]],
    ["flags in lists", [[[1], [1]]]],
    ["flags padded and decimal", [[" 1 ", "1.0"]]],
    ["one flag as text", [[1, "1"]]],
    ["a flag of 2", [[1, 2]]],
    ["fewer flags than rows", [[1]]],
    ["more flags than rows", [[1, 1, 1]]],
    ["flags not a list", [null]],
    ["flags as an object", [{ 0: 1, 1: 1, length: 2 }]],
    ["no reply for the command", []],
    ["two replies for one command", [[1, 1], [1, 1]]],
  ];
  for (const [name, reply] of shapes) {
    const real = redis.pipeline.bind(redis);
    (redis as unknown as { pipeline: typeof real }).pipeline = async (commands) => (commands[0][0] === "SMISMEMBER" ? (reply as never) : real(commands));
    const { read, state } = lostRead(["evt_refundsexact0001", "evt_refundsexact0003"]);
    const got = await outcome(() => confirmLostRead(read, SEEN));
    (redis as unknown as { pipeline: typeof real }).pipeline = real;
    is(`${name}: refused, and the place is not written`, [got, state.committed], ["threw UnknownReplyError", 0]);
  }

  part("disputeLost: the healthy answers keep their meaning");
  const answers: [string, unknown, boolean][] = [
    ["no dispute", [], false],
    ["a dispute lost", [{ id: "du_refundsexact01", object: "dispute", status: "lost" }], true],
    ["a dispute won", [{ id: "du_refundsexact01", object: "dispute", status: "won" }], false],
    ["a dispute still open", [{ id: "du_refundsexact01", object: "dispute", status: "needs_response" }], false],
  ];
  for (const [name, data, lost] of answers) {
    disputesAnswer = { body: { object: "list", data, has_more: false }, status: 200 };
    is(`${name}: disputeLost ${lost}`, await outcome(() => disputeLost(ACCOUNT, disputedPayment)), lost);
    is(`${name}: givenBack ${lost}`, await outcome(() => givenBack(ACCOUNT, disputedPayment)), lost);
  }
  disputesAnswer = { body: { object: "list", data: [{ id: "du_refundsexact01", status: "won" }, { id: "du_refundsexact02", status: "lost" }], has_more: true }, status: 200 };
  is("a lost dispute among more than were read: lost, from the row read", await outcome(() => givenBack(ACCOUNT, disputedPayment)), true);
  disputesAnswer = { body: { error: { message: "rate limited" } }, status: 429 };
  is("Stripe cannot be asked: givenBack throws, as before", typeof (await outcome(() => givenBack(ACCOUNT, disputedPayment))), "string");
  is("Stripe cannot be asked: keptUnlessLost lets in, as before", await keptUnlessLost(ACCOUNT, disputedPayment), false);
  disputeReads = 0;
  is("an undisputed charge: no dispute asked", [await givenBack(ACCOUNT, { ...disputedPayment, latest_charge: { ...disputedPayment.latest_charge, disputed: false } }), disputeReads], [false, 0]);

  part("disputeLost: a list in another shape is unknown, never \"not lost\"");
  const odd: [string, unknown][] = [
    ["data missing", { object: "list", has_more: false }],
    ["data null", { object: "list", data: null, has_more: false }],
    ["data an object", { object: "list", data: { 0: { status: "lost" } }, has_more: false }],
    ["a row null", { object: "list", data: [null], has_more: false }],
    ["a row with no status", { object: "list", data: [{ id: "du_refundsexact01" }], has_more: false }],
    ["a row with a status Stripe never gives", { object: "list", data: [{ id: "du_refundsexact01", status: "LOST" }], has_more: false }],
    ["a row with a status of another type", { object: "list", data: [{ id: "du_refundsexact01", status: ["lost"] }], has_more: false }],
    ["a row that is a list", { object: "list", data: [["lost"]], has_more: false }],
    ["no has_more", { object: "list", data: [] }],
    ["has_more of another type", { object: "list", data: [], has_more: "false" }],
    ["more disputes than read, none lost", { object: "list", data: [{ id: "du_refundsexact01", status: "won" }], has_more: true }],
  ];
  const store = { handle: "refunds-exact", stripeAccountId: ACCOUNT } as unknown as Store;
  for (const [name, body] of odd) {
    disputesAnswer = { body, status: 200 };
    is(`${name}: disputeLost refuses`, await outcome(() => disputeLost(ACCOUNT, disputedPayment)), "threw StripeListUnreadable");
    is(`${name}: givenBack refuses (a pre-order is not handed over)`, await outcome(() => givenBack(ACCOUNT, disputedPayment)), "threw StripeListUnreadable");
    is(`${name}: offerRefunded refuses (the offer's file is not handed over)`, await outcome(() => offerRefunded(store, "pi_refundsexact0001")), "threw StripeListUnreadable");
    is(`${name}: keptUnlessLost still lets in`, await keptUnlessLost(ACCOUNT, disputedPayment), false);
  }

  done();
}

main();
