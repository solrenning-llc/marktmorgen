/**
 * Withdrawing a payment request closes the checkout it already opened on Stripe first (lib/payment-requests.ts
 * withdrawRequest, the studio route's "cancel"), as marking it paid outside Stripe does (markPaidOutside).
 *
 * The defect this file was written around: the studio's cancel only changed the request's record in Redis. A Stripe
 * checkout the buyer had already opened for it stays payable for up to a day, so a creator who withdrew a $120
 * request to send a corrected $100 one could have the buyer pay both: the old tab, then the new request.
 *
 * Checked: an open checkout is closed on Stripe, then the request is withdrawn; one Stripe cannot close leaves the
 * request open and says so; one already paid is written down as paid online and not withdrawn; one still being paid
 * is refused and left open; a request with no checkout, or one past its checkout's life, is withdrawn with no call;
 * a request no longer open is refused; the studio's cancel goes through withdrawRequest. Stripe is a stand-in.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { changeRequest, createRequest, requestOf } from "@/lib/payment-request-store";
import * as requests from "@/lib/payment-requests";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_withdraw_only";

const sessions: Record<string, Record<string, unknown>> = {};
const expired: string[] = [];
let calls = 0;
let expireFails = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls += 1;
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const close = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)\/expire$/.exec(path);
  if (close && init?.method === "POST") {
    if (expireFails) return answer({ error: { message: "This Checkout Session is not in an expireable state." } }, 400);
    expired.push(close[1]);
    return answer({ ...sessions[close[1]], status: "expired" });
  }
  const read = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (read) return sessions[read[1]] ? answer(sessions[read[1]]) : answer({ error: { message: "No such checkout.session" } }, 404);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type Withdrawn = { ok: true; request: { state: string } } | { ok: false; reason: string };
const withdraw = (requests as unknown as { withdrawRequest?: (store: unknown, id: string) => Promise<Withdrawn> }).withdrawRequest;

async function main(): Promise<void> {
  redis.clear();
  const owner = "withdraw@example.com";
  await claimHandle(owner, "withdrawshop", "Withdraw Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Withdrawxxxxxx", true);
  await setSubscription(owner, { active: true, tier: "creator", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const draft = readDraft({ email: "client@example.com", name: "Client", lines: [{ text: "Coaching, October", quantity: 1, amount: "120" }], note: "", dueDate: "", autoReminders: 0, consent: true }, store.currency);
  if (!draft.ok) throw new Error(`draft ${draft.problem}`);
  const make = async () => {
    const made = await createRequest(store, draft.draft);
    if (!made.ok) throw new Error(made.reason);
    return made.request.id;
  };
  const withSession = async (id: string, session: string, state: Record<string, unknown>, at = Date.now()) => {
    sessions[session] = { id: session, ...state };
    await changeRequest(store, id, (r) => ({ next: { ...r, session, sessionAt: at }, answer: true }));
  };
  const outcome = async (id: string) => {
    if (!withdraw) return "no withdrawRequest";
    const result = await withdraw(store, id);
    return result.ok ? result.request.state : result.reason;
  };
  const route = readFileSync("app/api/store/payment-requests/route.ts", "utf8");

  part("The studio's cancel goes through withdrawRequest");
  is("withdrawRequest exists", typeof withdraw, "function");
  is("the route's cancel calls it", route.includes("withdrawRequest(store, id)"), true);

  part("A checkout open on Stripe is closed before the request is withdrawn");
  const open = await make();
  await withSession(open, "cs_test_openwd12345", { status: "open", payment_status: "unpaid" });
  is("closed on Stripe, then withdrawn", [await outcome(open), expired.includes("cs_test_openwd12345"), (await requestOf(store, open))?.state], ["canceled", true, "canceled"]);
  const stuck = await make();
  await withSession(stuck, "cs_test_stuckwd1234", { status: "open", payment_status: "unpaid" });
  expireFails = true;
  is("Stripe could not close it: not withdrawn, still open", [await outcome(stuck), (await requestOf(store, stuck))?.state], ["error", "open"]);
  expireFails = false;

  part("A checkout already paid, or being paid, is never withdrawn");
  const paid = await make();
  await withSession(paid, "cs_test_paidwd12345", { status: "complete", payment_status: "paid", amount_total: 12000, payment_intent: "pi_test_withdraw123", created: Math.floor(Date.now() / 1000) });
  is("paid online: written down as paid, the withdrawal refused", [await outcome(paid), (await requestOf(store, paid))?.state], ["paid_online", "paid"]);
  const slow = await make();
  await withSession(slow, "cs_test_slowwd12345", { status: "complete", payment_status: "unpaid" });
  is("still being paid: refused, left open", [await outcome(slow), (await requestOf(store, slow))?.state], ["processing", "open"]);

  part("Nothing to close: withdrawn with no call to Stripe");
  const plain = await make();
  calls = 0;
  is("no checkout opened: withdrawn, Stripe not asked", [await outcome(plain), calls], ["canceled", 0]);
  const old = await make();
  await withSession(old, "cs_test_oldwd123456", { status: "open", payment_status: "unpaid" }, Date.now() - 26 * 3_600_000);
  calls = 0;
  is("a checkout past its life (Stripe closed it by then): withdrawn, Stripe not asked", [await outcome(old), calls], ["canceled", 0]);
  is("withdrawn twice: refused as not open", await outcome(plain), "not_open");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
