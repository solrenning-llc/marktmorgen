/**
 * A past-due membership whose latest invoice was not read is an answer not
 * understood (rule 24), never an ended membership (Codex X8 on #3889).
 *
 * Every door asks Stripe for the subscription with its latest invoice
 * expanded, and Stripe's invoice always carries `next_payment_attempt`: a
 * date while another attempt is scheduled, an explicit null once none is.
 * Anything else (the invoice still its id, an invoice without the field, a
 * field that is not a date) says nothing about the retry, so the door says
 * to try again instead of telling somebody who pays that it ended. The read
 * by id alone (lib/membership-access.ts, membershipStatus) asks for the same
 * expansion before it decides or keeps the state.
 */
import { UnknownReplyError } from "@/lib/redis-reply";
import { liveExpanded, membershipStatus, memberState, PAST_DUE_NO_RETRY } from "@/lib/membership-access";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_past_due_invoice_unknown";
const NOW = Math.floor(Date.now() / 1000);

function throwsUnknown(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof UnknownReplyError;
  }
}

let asked: string[] = [];
let reply: unknown = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  asked.push(`${url.pathname}${url.search}`);
  const expanded = url.searchParams.getAll("expand[]").includes("latest_invoice");
  const sub = reply as Record<string, unknown>;
  const invoice = sub.latest_invoice as { id?: string } | null;
  const body = expanded || !invoice || typeof invoice !== "object" ? sub : { ...sub, latest_invoice: invoice.id };
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  part("Codex X8's reproduction: an invoice not read cannot certify an ended membership");
  for (const latest_invoice of ["in_synthetic123", { id: "in_synthetic123" }]) {
    is(`past due with ${JSON.stringify(latest_invoice)}: unknown`, throwsUnknown(() => liveExpanded({ status: "past_due", latest_invoice })), true);
  }

  part("Every other shape that says nothing about the retry is unknown too");
  for (const [what, latest] of [
    ["no latest invoice", null],
    ["the field missing", undefined],
    ["a list", [{ id: "in_TestD", next_payment_attempt: NOW + 3600 }]],
    ["a date as text", { id: "in_TestF", next_payment_attempt: String(NOW + 86_400) }],
    ["a date that is not a whole number", { id: "in_TestG", next_payment_attempt: NOW + 0.5 }],
    ["zero", { id: "in_TestH", next_payment_attempt: 0 }],
    ["a negative date", { id: "in_TestI", next_payment_attempt: -1 }],
  ] as const) {
    is(`past due, ${what}: unknown`, throwsUnknown(() => memberState({ status: "past_due", latest_invoice: latest })), true);
  }

  part("The two answers Stripe does give still decide");
  is("an attempt scheduled: open", liveExpanded({ status: "past_due", latest_invoice: { id: "in_A", next_payment_attempt: NOW + 3600 } }), true);
  is("an explicit null: ended", memberState({ status: "past_due", latest_invoice: { id: "in_B", next_payment_attempt: null } }), PAST_DUE_NO_RETRY);
  is("active, whatever the invoice: as before", memberState({ status: "active", latest_invoice: "in_C" }), "active");

  part("Read by its id alone, the membership is asked for with its latest invoice");
  const store = { stripeAccountId: "acct_1TestInvoice01" } as Store;
  asked = [];
  reply = { id: "sub_TestById0001", object: "subscription", status: "past_due", latest_invoice: { id: "in_D", object: "invoice", next_payment_attempt: NOW + 3600 } };
  is("a scheduled attempt read by id: past_due", await membershipStatus(store, "sub_TestById0001"), "past_due");
  is("the read asked for the latest invoice", asked.some((path) => path.includes("expand%5B%5D=latest_invoice") || path.includes("expand[]=latest_invoice")), true);
  asked = [];
  reply = { id: "sub_TestById0002", object: "subscription", status: "past_due", latest_invoice: { id: "in_E", object: "invoice", next_payment_attempt: null } };
  is("no attempt any more, read by id: ended", await membershipStatus(store, "sub_TestById0002"), PAST_DUE_NO_RETRY);

  done();
}

void main();
