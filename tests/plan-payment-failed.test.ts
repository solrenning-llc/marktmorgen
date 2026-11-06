/**
 * A creator's own plan whose payment failed (added 11 October 2026,
 * lib/billing-reminders.ts, sendFailedPlanNotices). What is checked:
 *
 *   - a renewal that failed gets one email, to the creator, with the
 *     invoice's own Stripe page and the date the card is tried again, and
 *     the subscription is told to keep the card that pays it, before the
 *     email goes;
 *   - the first payment after a trial is told apart: the checkout has
 *     already stopped, and the email says so rather than promising a grace
 *     the store does not have;
 *   - never twice for the same invoice, and tried again on the next run when
 *     the email could not be sent;
 *   - nothing is sent for an invoice that is not open, has nothing on it,
 *     has no page to pay on, or has no address to write to.
 */
import { failedPlan, failedPlanEmail, sendFailedPlanNotices } from "@/lib/billing-reminders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_failed_plan_only";
process.env.RESEND_API_KEY = "re_test_failed_plan_only";

const NOW = 1_791_700_000;
const DAY = 86_400;
const emails: { to: string; subject: string; text: string }[] = [];
const kept: string[] = [];
let subscriptions: Record<string, unknown>[] = [];
let emailWorks = true;

function sub(id: string, over: Record<string, unknown> = {}, invoice: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: "past_due",
    created: NOW - 90 * DAY,
    trial_end: NOW - 76 * DAY,
    customer: { email: `${id}@example.com` },
    items: {
      data: [
        {
          current_period_start: NOW - 2 * DAY,
          current_period_end: NOW + 28 * DAY,
          price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } },
        },
      ],
    },
    latest_invoice: {
      id: `in_${id.slice(4)}inv`,
      status: "open",
      amount_due: 2900,
      hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
      next_payment_attempt: NOW + 3 * DAY,
      ...invoice,
    },
    ...over,
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    if (method === "GET" && url.pathname === "/v1/subscriptions") {
      return new Response(JSON.stringify({ data: subscriptions, has_more: false }), { status: 200 });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("payment_settings[save_default_payment_method]") === "on_subscription") {
        kept.push(url.pathname.split("/").pop() as string);
      }
      return new Response(JSON.stringify({ id: url.pathname.split("/").pop() }), { status: 200 });
    }
  }
  if (url.hostname === "api.resend.com") {
    if (!emailWorks) return new Response(JSON.stringify({ message: "down" }), { status: 500 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = Array.isArray(body.to) ? body.to[0] : body.to;
    emails.push({ to, subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main() {
  part("Which past-due plans can be paid from an email");
  {
    const renewal = failedPlan(sub("sub_renewal01"));
    is("a failed renewal is found", renewal?.invoice, "in_renewal01inv");
    is("it is not the first payment after a trial", renewal?.afterTrial, false);
    is("its amount", renewal?.amountCents, 2900);
    is("and the date the card is tried again", renewal?.nextTry, NOW + 3 * DAY);

    // The first payment after the trial: the period starts where the trial ended.
    const first = failedPlan(
      sub("sub_aftertrial1", {
        created: NOW - 15 * DAY,
        trial_end: NOW - DAY,
        items: { data: [{ current_period_start: NOW - DAY, current_period_end: NOW + 29 * DAY, price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } } }] },
      }),
    );
    is("the first payment after a trial is told apart", first?.afterTrial, true);

    is("not an invoice already paid", failedPlan(sub("sub_paid000001", {}, { status: "paid" })), null);
    is("not one with nothing on it", failedPlan(sub("sub_zero000001", {}, { amount_due: 0 })), null);
    is("not one with no page to pay on", failedPlan(sub("sub_nopage0001", {}, { hosted_invoice_url: null })), null);
    is("not one with no address", failedPlan(sub("sub_noaddr0001", { customer: { email: "" } })), null);
    is("not a subscription that is not past due", failedPlan(sub("sub_active0001", { status: "active" })), null);
    is("not when the invoice was not expanded", failedPlan(sub("sub_noexp00001", { latest_invoice: "in_abcdef123" })), null);
  }

  part("What the email says");
  {
    const renewal = failedPlanEmail(failedPlan(sub("sub_renewal01")) as NonNullable<ReturnType<typeof failedPlan>>);
    is("the subject names the plan", renewal.subject, "Your Marktmorgen payment did not go through");
    is("it says the amount", renewal.text.includes("The payment of $29 for your Marktmorgen plan did not go through."), true);
    is("it gives the page that pays it", renewal.text.includes("https://invoice.stripe.com/i/sub_renewal01"), true);
    // 232 [CA1] unit 4: a renewal that failed stops what costs us to run; the email says so, and never that the store keeps selling.
    is("it no longer says the store keeps selling", renewal.text.includes("keeps taking payments"), false);
    is("it says the checkout takes no new orders until it is paid", renewal.text.includes("Until it is paid, your checkout takes no new orders"), true);
    is("it says when the card is tried again", renewal.text.includes("We will try your card again on"), true);

    const first = failedPlanEmail({
      ...(failedPlan(sub("sub_renewal01")) as NonNullable<ReturnType<typeof failedPlan>>),
      afterTrial: true,
    });
    is("after a trial, the subject says the trial ended", first.subject, "Your Marktmorgen trial has ended: the first payment did not go through");
    is("and it does not promise a grace there is not", first.text.includes("keeps taking payments"), false);
    is("it says the checkout has stopped", first.text.includes("Until it is paid, your checkout cannot take money."), true);
  }

  part("Sent once per invoice, card kept first");
  {
    subscriptions = [sub("sub_renewal01"), sub("sub_paid000001", {}, { status: "paid" })];
    const first = await sendFailedPlanNotices();
    is("one email sent", first.sent, 1);
    is("to the creator who pays the plan", emails.map((e) => e.to), ["sub_renewal01@example.com"]);
    is("the subscription was told to keep the card that pays", kept, ["sub_renewal01"]);

    const again = await sendFailedPlanNotices();
    is("not sent a second time for the same invoice", again.sent, 0);
    is("still one email in all", emails.length, 1);

    // A new failed invoice on the same plan, a month later, is a new email.
    subscriptions = [sub("sub_renewal01", {}, { id: "in_nextmonth01" })];
    const next = await sendFailedPlanNotices();
    is("a later failed invoice is its own email", next.sent, 1);
  }

  part("Tried again when the email could not go");
  {
    subscriptions = [sub("sub_outage00001")];
    emailWorks = false;
    const down = await sendFailedPlanNotices();
    is("counted as failed", down.failed, 1);
    is("and not claimed", await redis.pipeline([["GET", "nl:remind:failed:in_outage00001inv"]]), [null]);
    emailWorks = true;
    const up = await sendFailedPlanNotices();
    is("sent on the next run", up.sent, 1);
  }

  done();
}

main();
