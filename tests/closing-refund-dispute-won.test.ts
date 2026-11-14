/**
 * A member whose last payment was disputed and the dispute WON by the creator still gets the time they paid for past
 * the closing day back (queue item 307 [EC1]; lib/closing-refunds.ts giveBackUnused).
 *
 * The defect this file was written around: giveBackUnused settled every charge with `disputed: true` as "disputed",
 * final, with no refund and no email. Stripe keeps `disputed` true on a charge once a dispute was opened on it, also
 * after the creator won it, and a won dispute gives the money back to the creator (lib/retained-revenue.ts,
 * DISPUTE_TAKES). So a member who paid, whose bank opened a dispute the creator then won, lost the unused part of what
 * they paid in silence when the store closed.
 *
 * Now a disputed charge has its disputes read (exactly: a whole list, every one this payment's own, rule 30). Only when
 * every one was won is the unused part given back as any other's; any other status stays "disputed" as before, and a
 * list that does not read decides nothing (the member is tried again, rule 24).
 *
 * Hypothesis, not checked against Stripe: that Stripe takes a refund of a charge whose dispute was won. If it refuses
 * (charge_disputed, refund_disputed_payment), the member is never settled in silence: before the closing day it is
 * tried again; on the closing day it is final and told, with what is left to give, as a refund Stripe refused is.
 *
 * Stripe and Redis are stand-ins; nothing real is charged, refunded or sent.
 */
import { giveBackUnused } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_closing_dispute_won_only";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const SUB = "sub_ClosingWon001";
const INTENT = "pi_ClosingWon00001";
const CHARGE = "ch_ClosingWon00001";

/** What GET /disputes answers: a list, an error status, or a body of its own. */
let disputes: { status: number; body: unknown } = { status: 200, body: { object: "list", data: [], has_more: false } };
/** What POST /refunds answers. */
let refundAnswer: { status: number; body: unknown } = { status: 200, body: {} };
let posts = 0;
let disputeReads = 0;

const dispute = (status: string, intent = INTENT, charge = CHARGE) => ({ id: `dp_ClosingWon${status}`, object: "dispute", status, amount: 1000, currency: "usd", charge, payment_intent: intent });
const listOf = (...rows: unknown[]) => ({ status: 200, body: { object: "list", data: rows, has_more: false } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  if (path === `/payment_intents/${INTENT}`) {
    return Response.json({ id: INTENT, object: "payment_intent", amount: 1000, currency: "usd", latest_charge: { id: CHARGE, object: "charge", payment_intent: INTENT, amount: 1000, currency: "usd", amount_refunded: 0, disputed: true, balance_transaction: null } });
  }
  if (path === "/disputes") {
    disputeReads += 1;
    return Response.json(disputes.body, { status: disputes.status });
  }
  if (path === "/refunds" && init?.method === "POST") {
    posts += 1;
    const body = new URLSearchParams(String(init.body));
    refundAnswer = refundAnswer.status === 200
      ? { status: 200, body: { id: "re_ClosingWon0001", object: "refund", amount: Number(body.get("amount")), currency: "usd", payment_intent: INTENT, status: "succeeded" } }
      : refundAnswer;
    return Response.json(refundAnswer.body, { status: refundAnswer.status });
  }
  if (path === "/refunds") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

const refused = { status: 400, body: { error: { type: "invalid_request_error", code: "charge_disputed", message: "TEST ONLY: this charge was disputed" } } };

async function run(label: string, final: boolean) {
  redis.clear();
  posts = 0;
  disputeReads = 0;
  const email = `closing-won-${label}@example.com`;
  await claimHandle(email, `closingwon${label}`, "Closing fixture", "");
  const shop = (await storeForEmail(email))!;
  const seller: Store = { ...shop, stripeAccountId: "acct_ClosingWon001" };
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: "in_ClosingWon00001", pi: INTENT, amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 20, "rcalls", 10],
  ]);
  const errors = console.error;
  console.error = () => {};
  let out: Awaited<ReturnType<typeof giveBackUnused>>;
  try {
    out = await giveBackUnused(seller, DAY, { final });
  } finally {
    console.error = errors;
  }
  const [raw] = await redis.pipeline([["HGET", paidKey(folder), SUB]]);
  const saved = JSON.parse(String(raw)) as { r?: string; back?: number; want?: number };
  const settled = typeof out === "object" ? out : null;
  return { posts, disputeReads, r: saved.r ?? null, settled };
}

async function main(): Promise<void> {
  part("A dispute the creator won: the unused part is given back");
  disputes = listOf(dispute("won"));
  refundAnswer = { status: 200, body: {} };
  const won = await run("won", true);
  is("its disputes were read", won.disputeReads, 1);
  is("a refund of the unused 500 was made, and the member is settled done", [won.posts, won.r, won.settled?.done.map((d) => d.amount)], [1, "done", [500]]);
  is("not counted as disputed", won.settled?.disputed, 0);

  part("Stripe refuses that refund (the hypothesis fails): never settled in silence");
  disputes = listOf(dispute("won"));
  refundAnswer = refused;
  const late = await run("refusedfinal", true);
  is("on the closing day: settled as not made, and told with what is left to give", [late.r, late.settled?.unmade.map((u) => u.amount)], ["over", [500]]);
  is("not counted as disputed", late.settled?.disputed, 0);
  refundAnswer = refused;
  const early = await run("refusedearly", false);
  is("before it: not settled, tried again", [early.r, early.settled?.failed, early.settled?.disputed], [null, 1, 0]);

  part("Any dispute not won stays disputed, as before (control)");
  for (const [i, status] of ["lost", "needs_response", "under_review", "warning_needs_response"].entries()) {
    disputes = listOf(dispute(status));
    refundAnswer = { status: 200, body: {} };
    const kept = await run(`kept${i}`, true);
    is(`${status}: no refund, settled disputed`, [kept.posts, kept.r, kept.settled?.disputed], [0, "disputed", 1]);
  }
  disputes = listOf(dispute("won"), dispute("lost"));
  const mixed = await run("mixed", true);
  is("one won and one lost: still disputed", [mixed.posts, mixed.r], [0, "disputed"]);

  part("A dispute list that does not read decides nothing (rule 24 and rule 30)");
  disputes = { status: 500, body: { error: { type: "api_error", message: "TEST ONLY down" } } };
  const down = await run("down", true);
  is("Stripe down: no refund, nothing settled, tried again", [down.posts, down.r, down.settled?.failed], [0, null, 1]);
  disputes = listOf(dispute("won", "pi_SomeoneElse00001"));
  const foreign = await run("foreign", true);
  is("another payment's dispute: no refund, nothing settled", [foreign.posts, foreign.r, foreign.settled?.failed], [0, null, 1]);
  disputes = listOf();
  const empty = await run("empty", true);
  is("a disputed charge with no dispute listed: nothing settled", [empty.posts, empty.r, empty.settled?.failed], [0, null, 1]);
  disputes = { status: 200, body: { object: "list", data: [dispute("won")], has_more: true } };
  const more = await run("more", true);
  is("a list that says there is more: nothing settled", [more.posts, more.r, more.settled?.failed], [0, null, 1]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
