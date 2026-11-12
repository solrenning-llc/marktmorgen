/**
 * A creator's billing email whose send came back unknown is not sent again
 * (lib/billing-reminders.ts: sendReminders and sendFailedPlanNotices).
 *
 * The sender answers a 5xx or a lost reply as "uncertain" (lib/email.ts,
 * sendEmailOutcome): the email may already be in the creator's inbox. These
 * two jobs pass no idempotency key, so a second run is a second email under
 * a fresh provider key. Before this fix both let their once-only mark go on
 * any false from sendEmail, so every daily run after an unknown answer wrote
 * the same trial warning or failed-payment notice again, each one paid by the
 * company. A known refusal (a 4xx, nothing taken) still lets the mark go, so
 * the email is tried again on the next run rather than never.
 */
import { sendFailedPlanNotices, sendReminders } from "@/lib/billing-reminders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_failed_plan_only";
process.env.RESEND_API_KEY = "re_test_failed_plan_only";

const NOW = 1_791_700_000;
const DAY = 86_400;
let posts = 0;
let answer = 200;
let subscriptions: Record<string, unknown>[] = [];
let status = "past_due";

const priced = { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } };

function pastDue(id: string): Record<string, unknown> {
  return {
    id, status: "past_due", created: NOW - 90 * DAY, trial_end: NOW - 76 * DAY,
    customer: { email: `${id}@example.com` },
    items: { data: [{ current_period_start: NOW - 2 * DAY, current_period_end: NOW + 28 * DAY, price: priced }] },
    latest_invoice: { id: `in_${id.slice(4)}inv`, status: "open", amount_due: 2900, hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, next_payment_attempt: NOW + 3 * DAY },
  };
}

function trialing(id: string): Record<string, unknown> {
  return {
    id, status: "trialing", created: NOW - 10 * DAY, trial_end: NOW + 3 * DAY,
    customer: { email: `${id}@example.com` },
    items: { data: [{ current_period_start: NOW - 10 * DAY, current_period_end: NOW + 3 * DAY, price: priced }] },
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    if (method === "GET" && url.pathname === "/v1/subscriptions") {
      const wanted = url.searchParams.get("status");
      return new Response(JSON.stringify({ data: wanted === status ? subscriptions : [], has_more: false }), { status: 200 });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) {
      return new Response(JSON.stringify({ id: url.pathname.split("/").pop() }), { status: 200 });
    }
  }
  if (url.hostname === "api.resend.com") {
    // Every POST reaches the provider: a 500 may follow acceptance.
    posts += 1;
    if (answer !== 200) return new Response(JSON.stringify({ message: "no" }), { status: answer });
    return new Response(JSON.stringify({ id: `re_${posts}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main() {
  part("A failed-payment notice whose send came back unknown is not sent again");
  {
    status = "past_due";
    subscriptions = [pastDue("sub_unknown0001")];
    answer = 500;
    posts = 0;
    await sendFailedPlanNotices();
    const first = posts;
    is("the first run reached the sender", first >= 1, true);
    is("its mark is kept: the email may be in the inbox", (await redis.pipeline([["GET", "nl:remind:failed:in_unknown0001inv"]]))[0] !== null, true);
    answer = 200;
    await sendFailedPlanNotices();
    is("the next run sends nothing more for the same invoice", posts, first);
  }

  part("A trial warning whose send came back unknown is not sent again");
  {
    status = "trialing";
    subscriptions = [trialing("sub_trialunk001")];
    answer = 500;
    posts = 0;
    await sendReminders(NOW);
    const first = posts;
    is("the first run reached the sender", first >= 1, true);
    answer = 200;
    await sendReminders(NOW);
    is("the next run sends nothing more for the same charge", posts, first);
  }

  part("A known refusal is still tried again on the next run");
  {
    status = "past_due";
    subscriptions = [pastDue("sub_refused0001")];
    answer = 422;
    const refused = await sendFailedPlanNotices();
    is("counted as failed", refused.failed, 1);
    is("and not claimed", await redis.pipeline([["GET", "nl:remind:failed:in_refused0001inv"]]), [null]);
    answer = 200;
    const again = await sendFailedPlanNotices();
    is("sent on the next run", again.sent, 1);

    status = "trialing";
    subscriptions = [trialing("sub_trialref001")];
    answer = 422;
    const warned = await sendReminders(NOW);
    is("a refused trial warning is counted as failed", warned.failed, 1);
    answer = 200;
    const later = await sendReminders(NOW);
    is("and sent on the next run", later.sent, 1);
  }

  done();
}

main();
