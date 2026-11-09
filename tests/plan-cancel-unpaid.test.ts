/**
 * Canceling a plan whose renewal did not go through (plan-lifecycle audit,
 * finding M3). The studio said "Nothing more will be charged. Your store keeps
 * taking payments until the date below", yet the route only set the plan to
 * stop at the period's end: the open renewal invoice kept being retried, so
 * the card could be charged after that promise, and a store whose renewal is
 * unpaid takes no payments at all.
 *
 * Now a cancel on a past-due plan also voids that open invoice (once, under
 * its own idempotency key, the answer read back), and the studio says what is
 * true in that state; when the void cannot be confirmed it says so. A voided
 * renewal keeps the period unpaid however Stripe then reads the subscription,
 * so nothing that costs us opens for a period never paid.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/billing/cancel/route";
import { stateOf } from "@/lib/billing";
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { state } from "./billing-resume-route-world";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_cancel_unpaid";
const NOW = Math.floor(Date.now() / 1000);
const period = paidPeriod(NOW * 1000);
const SUB = "sub_CancelUnpaid01";
const INVOICE = "in_CancelUnpaidOpen1";

let status: "past_due" | "active" = "past_due";
let invoiceStatus: "open" | "void" | "paid" = "open";
/** "lost": Stripe voided it but the answer did not arrive. */
let voidAnswer: "void" | "open" | "error" | "lost" = "void";
/** Whether Stripe's answer to the cancellation shows the mark it carried (pre-review G1). */
let markTaken = true;
/** Collection paused at Stripe (pause_collection), set only from its dashboard. */
let paused = false;
const metadata: Record<string, string> = { store: "cancel-unpaid" };
const asked: { method: string; path: string; body: string; key: string | null }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = String(init?.body ?? "");
  const key = new Headers(init?.headers).get("Idempotency-Key");
  asked.push({ method, path: url.pathname, body, key });
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected ${method} ${url}`);
  if (method === "POST" && url.pathname === `/v1/subscriptions/${SUB}`) {
    const form = new URLSearchParams(body);
    const mark = form.get("metadata[renewal_voided_before]");
    if (mark !== null && markTaken) metadata.renewal_voided_before = mark;
    const expanded = form.getAll("expand[]").includes("latest_invoice") || url.searchParams.getAll("expand[]").includes("latest_invoice");
    return Response.json({
      id: SUB, object: "subscription", status, cancel_at_period_end: form.has("cancel_at_period_end") ? form.get("cancel_at_period_end") === "true" : true, cancel_at: null, trial_end: null,
      customer: "cus_CancelUnpaid01", metadata: { ...metadata }, pause_collection: paused ? { behavior: "void", resumes_at: null } : null,
      items: { data: [{ id: "si_1", quantity: 1, current_period_start: period.start, current_period_end: period.end, price: { unit_amount: 44900, currency: "usd", lookup_key: "marktmorgen_pro_month", recurring: { interval: "month", interval_count: 1 } } }] },
      latest_invoice: expanded
        ? { id: INVOICE, object: "invoice", status: status === "past_due" ? invoiceStatus : "paid", billing_reason: "subscription_cycle", collection_method: "charge_automatically", created: period.start, amount_due: 44900, next_payment_attempt: status === "past_due" && invoiceStatus === "open" ? NOW + 3 * 86_400 : null }
        : INVOICE,
    });
  }
  if (method === "POST" && url.pathname === `/v1/invoices/${INVOICE}/void`) {
    if (voidAnswer === "error") return Response.json({ error: { message: "unavailable" } }, { status: 500 });
    if (voidAnswer === "void" || voidAnswer === "lost") invoiceStatus = "void";
    if (voidAnswer === "lost") return Response.json({ error: { message: "the answer was lost" } }, { status: 500 });
    return Response.json({ id: INVOICE, object: "invoice", status: voidAnswer === "void" ? "void" : "open" });
  }
  if (method === "GET" && url.pathname === `/v1/invoices/${INVOICE}`) return Response.json({ id: INVOICE, object: "invoice", status: invoiceStatus });
  throw new Error(`no stand-in for ${method} ${url.pathname}`);
}) as typeof fetch;

const cancel = async () => {
  const response = await POST(new NextRequest("https://local.example/api/billing/cancel", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "intent=cancel" }));
  return new URL(response.headers.get("location")!).searchParams.get("billing");
};
const voids = () => asked.filter((a) => a.method === "POST" && a.path.endsWith("/void"));
const changes = () => asked.filter((a) => a.method === "POST" && a.path === `/v1/subscriptions/${SUB}`);
const rereads = () => asked.filter((a) => a.method === "GET" && a.path === `/v1/invoices/${INVOICE}`);

async function main() {
  const email = "cancel-unpaid@example.com";
  await claimHandle(email, "cancel-unpaid", "Cancel unpaid", "");
  await setSubscription(email, { customerId: "cus_CancelUnpaid01", subscriptionId: SUB, active: true, tier: "pro", cycle: "month", period, renewalUnpaid: true });
  state.store = (await storeForEmail(email))!;

  part("cancel with the renewal unpaid");
  const first = await cancel();
  is("the cancellation asks Stripe for the latest invoice with its answer", asked.some((a) => a.path === `/v1/subscriptions/${SUB}` && new URLSearchParams(a.body).getAll("expand[]").includes("latest_invoice")), true);
  is("the open renewal invoice is voided, once", voids().length, 1);
  is("under its own idempotency key", voids()[0]?.key, `plan-cancel-void:${INVOICE}`);
  // Pre-review G1: only a voided renewal marked as ours keeps its period unpaid. The mark rides on the cancellation
  // itself (no call of its own): since when the store recorded the renewal unpaid.
  const since = (await storeForEmail(email))!.renewalUnpaidSince ?? 0;
  is("the cancellation itself carries the mark, the moment the store recorded the renewal unpaid, and nothing else is sent", [changes().length, new URLSearchParams(changes()[0]?.body ?? "").get("metadata[renewal_voided_before]"), since > 0], [1, String(since), true]);
  is("the studio is sent to the notice for a canceled plan whose renewal was unpaid", first, "canceling-unpaid");

  part("cancel again: nothing to void");
  asked.length = 0;
  is("already void: the same notice", await cancel(), "canceling-unpaid");
  is("and no second void", voids().length, 0);

  part("the void cannot be confirmed");
  for (const answer of ["open", "error"] as const) {
    invoiceStatus = "open";
    voidAnswer = answer;
    asked.length = 0;
    is(`Stripe answered ${answer}: the studio says one payment may still be tried`, await cancel(), "canceling-unpaid-open");
  }
  is("(L-1) after an error the invoice is read again before saying so", rereads().length, 1);

  part("(L-1) the void went through but its answer was lost");
  invoiceStatus = "open";
  voidAnswer = "lost";
  asked.length = 0;
  is("the invoice read again is void: the card is not tried, and the studio says so", await cancel(), "canceling-unpaid");
  is("read once", rereads().length, 1);

  part("(G1) the mark is not taken");
  invoiceStatus = "open";
  voidAnswer = "void";
  markTaken = false;
  delete metadata.renewal_voided_before;
  asked.length = 0;
  is("nothing is voided without the mark that keeps its period unpaid", [await cancel(), voids().length], ["canceling-unpaid-open", 0]);
  markTaken = true;

  part("cancel a plan that is paid up");
  status = "active";
  asked.length = 0;
  is("the ordinary notice", await cancel(), "canceling");
  is("and nothing is voided", voids().length, 0);

  part("(L-3) cancel a plan whose collection is paused at Stripe");
  paused = true;
  asked.length = 0;
  is("its own notice: nothing failed, collection is paused", await cancel(), "canceling-paused");
  is("and nothing is voided", voids().length, 0);
  paused = false;

  part("what the studio says");
  const page = readFileSync("app/studio/page.tsx", "utf8");
  const notice = (name: string) => {
    const at = page.indexOf(`"${name}": {`);
    return at < 0 ? "" : page.slice(at, page.indexOf("},", at));
  };
  const unpaid = notice("canceling-unpaid");
  is("there is a notice for a canceled plan whose renewal was unpaid", unpaid !== "", true);
  is("it does not say the store keeps taking payments", /keeps taking payments/.test(unpaid), false);
  is("it says the checkout stays closed", /checkout stays closed/.test(unpaid), true);
  const open = notice("canceling-unpaid-open");
  is("the notice for an unconfirmed void says the card may still be charged", /may still be charged/.test(open), true);
  is("the plan card has its own words for a canceled plan with the renewal unpaid", page.includes("Its last renewal payment did not go through"), true);
  // Pre-review L-2: resuming does not pay the voided renewal, so the plan is charged on that date only if they resume.
  is("(L-2) it does not say the plan is next charged on that date whatever they do", unpaid.includes("and your plan is next charged on that date"), false);
  is("(L-2) it says the plan is charged on that date if they change their mind", unpaid.includes("if you do, it is next charged on that date"), true);
  const pausedNotice = notice("canceling-paused");
  is("(L-3) a canceled plan with collection paused has its own notice, which names no failed payment", [pausedNotice !== "", /did not go through/.test(pausedNotice), /paused at Stripe/.test(pausedNotice)], [true, false, true]);
  is("(L-3) the plan card has its own words for a plan whose collection is paused", [page.includes("Collection of your plan's payments is paused at Stripe"), page.includes("Its payments are paused at Stripe")], [true, true]);

  part("a voided renewal keeps its period unpaid");
  const read = (latest: Record<string, unknown>, meta: Record<string, string> = {}) => stateOf({
    id: SUB, status: "active", cancel_at_period_end: true, cancel_at: null, metadata: { store: "cancel-unpaid", ...meta },
    items: { data: [{ id: "si_1", quantity: 1, current_period_start: period.start, current_period_end: period.end, price: { unit_amount: 44900, currency: "usd", lookup_key: "marktmorgen_pro_month", recurring: { interval: "month", interval_count: 1 } } }] },
    latest_invoice: { id: INVOICE, object: "invoice", status: "void", next_payment_attempt: null, created: period.start, ...latest },
  });
  // Regra 23 (pre-review G1): was a void invoice with no reason and no mark, read as unpaid. Any void counted made a
  // switch's expired pending update (billing_reason subscription_update, voided by Stripe) an unpaid period.
  const mark = { renewal_voided_before: String(NOW) };
  const voided = read({ billing_reason: "subscription_cycle" }, mark);
  is("a renewal voided by our cancel (marked) is still a renewal unpaid: costs stay paused", voided.state === "active" && voided.renewalUnpaid, true);
  const unmarked = read({ billing_reason: "subscription_cycle" });
  is("(G1) a renewal voided by anything else is not read as unpaid", unmarked.state === "active" && !unmarked.renewalUnpaid, true);
  const later = read({ billing_reason: "subscription_cycle", created: NOW + 86_400 }, mark);
  is("(G1) nor a renewal made after the cancel that marked it", later.state === "active" && !later.renewalUnpaid, true);
  const switchVoided = read({ billing_reason: "subscription_update" }, mark);
  is("(G1) nor a switch's pending update Stripe voided when it expired", switchVoided.state === "active" && !switchVoided.renewalUnpaid, true);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
