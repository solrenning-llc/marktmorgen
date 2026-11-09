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
let voidAnswer: "void" | "open" | "error" = "void";
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
    const expanded = form.getAll("expand[]").includes("latest_invoice") || url.searchParams.getAll("expand[]").includes("latest_invoice");
    return Response.json({
      id: SUB, object: "subscription", status, cancel_at_period_end: form.get("cancel_at_period_end") === "true", cancel_at: null, trial_end: null,
      customer: "cus_CancelUnpaid01", metadata: { store: "cancel-unpaid" },
      items: { data: [{ id: "si_1", quantity: 1, current_period_start: period.start, current_period_end: period.end, price: { unit_amount: 44900, currency: "usd", lookup_key: "marktmorgen_pro_month", recurring: { interval: "month", interval_count: 1 } } }] },
      latest_invoice: expanded
        ? { id: INVOICE, object: "invoice", status: status === "past_due" ? invoiceStatus : "paid", amount_due: 44900, next_payment_attempt: status === "past_due" && invoiceStatus === "open" ? NOW + 3 * 86_400 : null }
        : INVOICE,
    });
  }
  if (method === "POST" && url.pathname === `/v1/invoices/${INVOICE}/void`) {
    if (voidAnswer === "error") return Response.json({ error: { message: "unavailable" } }, { status: 500 });
    if (voidAnswer === "void") invoiceStatus = "void";
    return Response.json({ id: INVOICE, object: "invoice", status: voidAnswer === "void" ? "void" : "open" });
  }
  throw new Error(`no stand-in for ${method} ${url.pathname}`);
}) as typeof fetch;

const cancel = async () => {
  const response = await POST(new NextRequest("https://local.example/api/billing/cancel", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "intent=cancel" }));
  return new URL(response.headers.get("location")!).searchParams.get("billing");
};
const voids = () => asked.filter((a) => a.method === "POST" && a.path.endsWith("/void"));

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
  is("the studio is sent to the notice for a canceled plan whose renewal was unpaid", first, "canceling-unpaid");

  part("cancel again: nothing to void");
  asked.length = 0;
  is("already void: the same notice", await cancel(), "canceling-unpaid");
  is("and no second void", voids().length, 0);

  part("the void cannot be confirmed");
  invoiceStatus = "open";
  for (const answer of ["open", "error"] as const) {
    voidAnswer = answer;
    asked.length = 0;
    is(`Stripe answered ${answer}: the studio says one payment may still be tried`, await cancel(), "canceling-unpaid-open");
  }
  voidAnswer = "void";

  part("cancel a plan that is paid up");
  status = "active";
  asked.length = 0;
  is("the ordinary notice", await cancel(), "canceling");
  is("and nothing is voided", voids().length, 0);

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

  part("a voided renewal keeps its period unpaid");
  const voided = stateOf({
    id: SUB, status: "active", cancel_at_period_end: true, cancel_at: null,
    items: { data: [{ id: "si_1", quantity: 1, current_period_start: period.start, current_period_end: period.end, price: { unit_amount: 44900, currency: "usd", lookup_key: "marktmorgen_pro_month", recurring: { interval: "month", interval_count: 1 } } }] },
    latest_invoice: { id: INVOICE, object: "invoice", status: "void", next_payment_attempt: null },
  });
  is("read as active, it is still a renewal unpaid: costs stay paused", voided.state === "active" && voided.renewalUnpaid, true);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
