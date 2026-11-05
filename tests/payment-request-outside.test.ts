/**
 * 639 [GL7](30): a payment request marked as paid outside Stripe
 * (lib/payment-requests.ts markPaidOutside, the studio route, the buyer's
 * page as the receipt). Never two payments for one request: an open checkout
 * is closed on Stripe first, one already paid there is written down as paid
 * online and the mark refused, one still being paid is refused, and if
 * Stripe cannot close it nothing is marked. Only an open request is marked;
 * the mark reads back whole; the buyer's page says how, without claiming an
 * email; the route refuses a method or a day it cannot take.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readDraft, parseRequest, readOutside } from "@/lib/payment-request-rules";
import { changeRequest, createRequest, requestOf } from "@/lib/payment-request-store";
import { markPaidOutside } from "@/lib/payment-requests";
import { requestWords } from "@/lib/buyer-words/requests";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_paid_outside_only";

const sessions: Record<string, Record<string, unknown>> = {};
const expired: string[] = [];
let expireFails = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
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

async function main(): Promise<void> {
  redis.clear();
  const owner = "outside@example.com";
  await claimHandle(owner, "outsideshop", "Outside Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Outsidexxxxxxx", true);
  await setSubscription(owner, { active: true, tier: "creator", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const draft = readDraft({ email: "client@example.com", name: "Client", lines: [{ text: "Coaching, October", quantity: 1, amount: "120" }], note: "", dueDate: "", autoReminders: 0, consent: true }, store.currency);
  if (!draft.ok) throw new Error(`draft ${draft.problem}`);
  const make = async () => {
    const made = await createRequest(store, draft.draft);
    if (!made.ok) throw new Error(made.reason);
    return made.request.id;
  };
  const withSession = async (id: string, session: string, state: Record<string, unknown>) => {
    sessions[session] = { id: session, ...state };
    await changeRequest(store, id, (r) => ({ next: { ...r, session, sessionAt: Date.now() }, answer: true }));
  };
  const day = Date.UTC(2026, 9, 30, 12);

  part("No checkout opened: marked");
  const plain = await make();
  const marked = await markPaidOutside(store, plain, { method: "transfer", note: "Ref 4471", paidAt: day });
  const read = await requestOf(store, plain);
  is("paid, by transfer, with the note, the total and no Stripe payment", marked.ok ? [read?.state, read?.outside, read?.amountPaid, read?.payment, read?.paidAt] : marked.reason, ["paid", { method: "transfer", note: "Ref 4471" }, read?.total, "", day]);
  is("marked twice: refused", (await markPaidOutside(store, plain, { method: "cash", note: "", paidAt: day })).ok ? "marked" : "refused", "refused");

  part("A checkout open on Stripe: closed first");
  const open = await make();
  await withSession(open, "cs_test_openone1234", { status: "open", payment_status: "unpaid" });
  const closed = await markPaidOutside(store, open, { method: "cash", note: "", paidAt: day });
  is("closed on Stripe, then marked", [closed.ok, expired.includes("cs_test_openone1234"), (await requestOf(store, open))?.outside?.method], [true, true, "cash"]);
  const stuck = await make();
  await withSession(stuck, "cs_test_stuckone123", { status: "open", payment_status: "unpaid" });
  expireFails = true;
  const failed = await markPaidOutside(store, stuck, { method: "cash", note: "", paidAt: day });
  expireFails = false;
  is("Stripe could not close it: nothing marked", [failed.ok ? "marked" : failed.reason, (await requestOf(store, stuck))?.state], ["error", "open"]);

  part("Already paid online: written down as such, the mark refused");
  const online = await make();
  await withSession(online, "cs_test_paidone1234", { status: "complete", payment_status: "paid", amount_total: 12000, payment_intent: "pi_test_paid12345", created: Math.floor(day / 1000) });
  const refused = await markPaidOutside(store, online, { method: "cash", note: "", paidAt: day });
  const after = await requestOf(store, online);
  is("refused as paid online", refused.ok ? "marked" : refused.reason, "paid_online");
  is("paid online, with its payment, and no outside mark", [after?.state, after?.payment, after?.outside], ["paid", "pi_test_paid12345", undefined]);
  const pending = await make();
  await withSession(pending, "cs_test_slowone1234", { status: "complete", payment_status: "unpaid" });
  is("still being paid: refused, left open", [(await markPaidOutside(store, pending, { method: "cash", note: "", paidAt: day })).ok, (await requestOf(store, pending))?.state], [false, "open"]);

  part("Kept and said");
  is("a mark reads only whole", [readOutside({ method: "cheque" }), readOutside({ method: "cash", note: "  a\\nb  " })], [null, { method: "cash", note: "a\\nb" }]);
  is("an open request never carries a mark", parseRequest({ ...read, state: "open" })?.outside, undefined);
  const w = requestWords("en");
  const receipt = w.paidOutsideBody("$120.00", "Outside Shop", "October 30, 2026", "transfer");
  is("the receipt says how, and claims no email", [receipt.includes("by bank transfer"), receipt.includes("emailed")], [true, false]);
  for (const lang of ["es", "fr", "de", "it", "nl", "pt"]) is(`${lang}: its own words`, requestWords(lang).paidOutsideBody("1", "S", "D", "cash") !== receipt, true);
  const route = readFileSync("app/api/store/payment-requests/route.ts", "utf8");
  is("the route refuses a method or a day it cannot take", route.includes('refuse("method"') && route.includes('refuse("date"'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
