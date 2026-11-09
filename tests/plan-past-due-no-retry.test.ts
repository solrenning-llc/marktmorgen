/**
 * A plan whose renewal failed and that Stripe no longer retries is not a plan
 * in its grace (plan-lifecycle audit, finding M1; the plans' twin of #3370 for
 * memberships). Our Stripe account may be set to leave a subscription
 * `past_due` after its last try instead of cancelling it; read as a plan in
 * good standing it never ends, never closes, and keeps the store's files,
 * video and records with nothing paid and no end.
 *
 * Past due counts as the renewal's grace only while the latest invoice has
 * another attempt scheduled (`next_payment_attempt`). With none, the plan has
 * ended, and section 8 of the Terms applies. A subscription whose latest
 * invoice was not expanded says nothing either way: read on its own it is
 * unknown, and the daily job asks for the invoice.
 *
 * Pre-review M-a: `next_payment_attempt` is always null on an invoice sent to
 * be paid by link (`send_invoice`), and 3DS or Billing automations can leave
 * it null while Stripe still has something to do. So only an invoice charged
 * automatically ends the plan, and only once it is older than Stripe's longest
 * retry window (NO_TRY_WAIT_DAYS); before that the renewal is in its grace.
 */
import { NO_TRY_WAIT_DAYS, readSubscription, stateOf } from "@/lib/billing";
import { failedPlan, failedPlanEmail, planEndedSeconds } from "@/lib/billing-reminders";
import { syncSubscriptions } from "@/lib/billing-sync";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { CLOSING_DAYS } from "@/lib/plan-closing-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_past_due_no_retry";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const period = paidPeriod((NOW - 20 * DAY) * 1_000);

function subscription(id: string, handle: string, invoice: Record<string, unknown> | string): Record<string, unknown> {
  return {
    id,
    object: "subscription",
    status: "past_due",
    customer: { id: "cus_PastDueNoRetry1", email: "owner@example.com" },
    metadata: { store: handle },
    cancel_at_period_end: false,
    cancel_at: null,
    trial_end: null,
    items: { data: [{ id: "si_1", quantity: 1, current_period_start: period.start, current_period_end: period.end, price: { unit_amount: 6900, currency: "usd", lookup_key: "marktmorgen_creator_month", recurring: { interval: "month", interval_count: 1 } } }] },
    latest_invoice: invoice,
  };
}
// Regra 23 (pre-review M-a): the invoice now says how it is collected and when it was made; with no try scheduled
// only an automatic one older than Stripe's longest retry window ends the plan, and this one is.
const openInvoice = (next: number | null, created = NOW - 70 * DAY) => ({ id: "in_PastDueNoRetry01", object: "invoice", status: "open", amount_due: 6900, hosted_invoice_url: "https://invoice.stripe.com/i/x", next_payment_attempt: next, attempt_count: 4, collection_method: "charge_automatically", created });

const asked: string[] = [];
let listed: Record<string, unknown>[] = [];
/** Stripe answering without the invoice it was asked to expand. */
let ignoreExpand = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  asked.push(`${url.pathname}?${url.searchParams.toString()}`);
  const expanded = url.searchParams.getAll("expand[]");
  if (url.pathname === "/v1/subscriptions") {
    const withInvoice = expanded.includes("data.latest_invoice");
    return Response.json({ object: "list", has_more: false, url: "/v1/subscriptions", data: listed.map((row) => ({ ...row, latest_invoice: withInvoice ? row.latest_invoice : (row.latest_invoice as { id: string }).id })) });
  }
  const one = /^\/v1\/subscriptions\/(sub_[A-Za-z0-9]+)$/.exec(url.pathname);
  if (one) {
    const row = listed.find((s) => s.id === one[1]);
    if (!row) return new Response("{}", { status: 500 });
    return Response.json({ ...row, latest_invoice: expanded.includes("latest_invoice") && !ignoreExpand ? row.latest_invoice : (row.latest_invoice as { id: string }).id });
  }
  return new Response("{}", { status: 500 });
}) as typeof fetch;

async function main() {
  part("reading one subscription");
  const exhausted = subscription("sub_PastDueNoRetry1", "no-retry", openInvoice(null));
  const retrying = subscription("sub_PastDueRetrying1", "retrying", openInvoice(NOW + 3 * DAY));
  const noRetry = stateOf(exhausted);
  is("past due with no attempt left is not a plan in good standing", noRetry.state, "inactive");
  is("and says why", noRetry.state === "inactive" ? noRetry.reason : "", "past_due_no_retry");
  const grace = stateOf(retrying);
  is("past due with an attempt scheduled is still the renewal's grace", grace.state, "active");
  is("with its renewal unpaid", grace.state === "active" && grace.renewalUnpaid, true);
  const unread = stateOf(subscription("sub_PastDueUnread1", "unread", "in_PastDueNoRetry01"));
  is("an invoice not expanded is read as before: the grace, costs paused, nothing closes", unread.state === "active" && unread.renewalUnpaid, true);
  const uncollectible = stateOf(subscription("sub_PastDueUncoll1", "uncollectible", { ...openInvoice(null), status: "uncollectible" }));
  is("an invoice Stripe marked uncollectible after its last try ends the plan too", uncollectible.state, "inactive");

  part("(M-a) no try scheduled is not, on its own, a plan that ended");
  const fresh = stateOf(subscription("sub_PastDueFresh01", "fresh", openInvoice(null, NOW - DAY)));
  is("a day-old invoice with no try scheduled is the grace (3DS, automations): nothing ends", fresh.state === "active" && fresh.renewalUnpaid, true);
  const almost = stateOf(subscription("sub_PastDueAlmost1", "almost", openInvoice(null, NOW - (NO_TRY_WAIT_DAYS - 1) * DAY)));
  is("nor one a day short of the longest retry window", almost.state, "active");
  const undated = stateOf(subscription("sub_PastDueUndated", "undated", { ...openInvoice(null), created: undefined }));
  is("an invoice whose age cannot be read never ends the plan", undated.state, "active");
  const manualInvoice = { ...openInvoice(null), collection_method: "send_invoice" };
  const manual = subscription("sub_PastDueManual01", "manual", manualInvoice);
  is("an invoice paid by link (send_invoice) always has no try scheduled: not an ended plan", stateOf({ ...manual, collection_method: "send_invoice" }).state, "active");
  // Second pre-review G-1: one paid by link has its own clock, its due date and the same window.
  const overdue = stateOf({ ...subscription("sub_PastDueManual02", "manual-overdue", { ...manualInvoice, due_date: NOW - (NO_TRY_WAIT_DAYS + 1) * DAY }), collection_method: "send_invoice" });
  is("(G-1) paid by link and unpaid past its due date and the window: ended", overdue.state, "inactive");
  const pausedUncollectible = stateOf({ ...subscription("sub_PastDuePaused01", "paused", { ...openInvoice(null), status: "uncollectible" }), pause_collection: { behavior: "mark_uncollectible", resumes_at: null } });
  is("(L-4) collection paused at Stripe, its invoices marked uncollectible: paused, not ended", pausedUncollectible.state === "active" && pausedUncollectible.renewalUnpaid, true);

  listed = [exhausted, retrying];
  asked.length = 0;
  const read = await readSubscription("sub_PastDueNoRetry1");
  is("readSubscription asks for the latest invoice", asked.some((a) => a.startsWith("/v1/subscriptions/sub_PastDueNoRetry1?") && a.includes("expand%5B%5D=latest_invoice")), true);
  is("and reads a plan Stripe no longer retries as ended", read.state, "inactive");
  is("a plan Stripe still retries stays in its grace", (await readSubscription("sub_PastDueRetrying1")).state, "active");
  ignoreExpand = true;
  is("past due read without its invoice says nothing either way: unknown", (await readSubscription("sub_PastDueNoRetry1")).state, "unknown");
  ignoreExpand = false;
  listed = [{ ...manual, collection_method: "send_invoice" }];
  is("(M-a) read from Stripe, a past-due plan paid by link is its grace, not unknown", (await readSubscription("sub_PastDueManual01")).state, "active");

  part("the daily job");
  redis.clear();
  await claimHandle("owner@example.com", "no-retry", "No retry", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_PastDueNoRetry1", subscriptionId: "sub_PastDueNoRetry1", active: true, tier: "creator", cycle: "month", period, renewalUnpaid: true });
  listed = [exhausted];
  asked.length = 0;
  await syncSubscriptions(Date.now() + 20_000);
  is("the list of every subscription is read with its latest invoices", asked.some((a) => a.startsWith("/v1/subscriptions?") && a.includes("status=all") && a.includes("expand%5B%5D=data.latest_invoice")), true);
  const after = (await storeForEmail("owner@example.com"))!;
  is("the store whose plan Stripe no longer retries is ended", after.subscriptionActive, false);
  is("its end is written down", after.planEndedAt !== "", true);
  is("and it is in the line of ended plans, to close as the Terms say", (await redis.pipeline([["ZSCORE", ENDED_INDEX, storeRef(after)]]))[0] !== null, true);

  await claimHandle("fresh@example.com", "no-retry-fresh", "No retry fresh", "");
  await ensureStatsId("fresh@example.com");
  await setSubscription("fresh@example.com", { customerId: "cus_PastDueNoRetry1", subscriptionId: "sub_PastDueFresh02", active: true, tier: "creator", cycle: "month", period, renewalUnpaid: true });
  listed = [subscription("sub_PastDueFresh02", "no-retry-fresh", openInvoice(null, NOW - DAY))];
  await syncSubscriptions(Date.now() + 20_000);
  const kept = (await storeForEmail("fresh@example.com"))!;
  is("(M-a) the daily job does not end a plan whose invoice is a day old", [kept.subscriptionActive, (kept.renewalUnpaidSince ?? 0) > 0], [true, true]);

  part("the email when Stripe will not try again");
  const due = failedPlan(exhausted)!;
  is("the email knows there is no other try", due.nextTry, 0);
  const email = failedPlanEmail(due);
  is("it never says there is nothing to do", email.text.includes("you do not need to do anything"), false);
  is("it says Stripe will not try the card again", email.text.includes("Stripe will not try your card again"), true);
  const closing = new Date((NOW + CLOSING_DAYS * DAY) * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  is("it gives the date before which nothing is removed", email.text.includes(closing), true);
  const freshDue = failedPlan(subscription("sub_PastDueFresh03", "fresh-mail", openInvoice(null, NOW - DAY)))!;
  const freshMail = failedPlanEmail(freshDue).text;
  const endsOn = new Date((NOW - DAY + NO_TRY_WAIT_DAYS * DAY) * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  is("(M-a) a fresh invoice with no try scheduled: the email never says the plan has ended", freshMail.includes("has ended") || freshMail.includes("will not try your card again"), false);
  is("(M-a) it says no try is scheduled and the day the plan ends if it is still unpaid", freshMail.includes("has not scheduled another try") && freshMail.includes(endsOn), true);
  const manualMail = failedPlanEmail(failedPlan(manual)!).text;
  is("(M-a) an invoice paid by link: no word of trying the card, or of a plan already ended", ["will not try your card again", "We will try your card again", "has ended"].some((words) => manualMail.includes(words)), false);
  is("(M-a) it says the plan can end if it is not paid", manualMail.includes("If it is not paid, your plan can end"), true);
  const withTry = failedPlanEmail(failedPlan(retrying)!);
  is("with a try scheduled it still names that day", withTry.text.includes("We will try your card again on"), true);

  part("the email counts from the day the store's plan end was written down");
  // The daily job may have ended the plan days before the email goes (it is
  // retried on the next run when it fails): the date is from that end.
  await claimHandle("mail@example.com", "no-retry-mail", "No retry mail", "");
  await ensureStatsId("mail@example.com");
  await setSubscription("mail@example.com", { customerId: "cus_PastDueMail01", subscriptionId: "sub_PastDueMail01", active: true, tier: "creator", cycle: "month", period });
  const realNow = Date.now;
  const fiveDaysAgo = realNow() - 5 * DAY * 1000;
  Date.now = () => fiveDaysAgo;
  try {
    await setSubscription("mail@example.com", { active: false });
  } finally {
    Date.now = realNow;
  }
  const endedAt = (await storeForEmail("mail@example.com"))!.planEndedAt;
  is("the store's end was written down five days ago", Math.round((realNow() - Date.parse(endedAt)) / (DAY * 1000)), 5);
  const mailed = subscription("sub_PastDueMail01", "no-retry-mail", { ...openInvoice(null), id: "in_PastDueMail0001" });
  const counted = await planEndedSeconds(mailed);
  is("the email's closing date is counted from the end the store wrote down", counted, Math.floor(Date.parse(endedAt) / 1000));
  const fromEnd = new Date((counted + CLOSING_DAYS * DAY) * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  is("and the email names that day", failedPlanEmail(failedPlan(mailed)!, counted).text.includes(fromEnd), true);
  is("a store that keeps another subscription is counted from today", await planEndedSeconds({ ...mailed, id: "sub_SomeOtherPlan1" }) >= NOW, true);
  done();
}
main();
