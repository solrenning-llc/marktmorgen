/**
 * A membership whose renewal failed opens its doors only while Stripe still
 * has another attempt scheduled (lib/membership-access.ts, memberState; audit
 * R43, finding 6; added 9 November 2026).
 *
 * The help pages promise exactly that: "When a membership ends (canceled, or
 * unpaid once Stripe has stopped retrying) its file, its course and your
 * community close by themselves ... While Stripe is still retrying a failed
 * payment, they keep access." (lib/help-content.ts; lib/feature-pages.ts).
 * Stripe's subscription carries no retry date of its own; its latest invoice
 * does (`next_payment_attempt`, null once no attempt is scheduled). Checked
 * here, against a stand-in for the creator's Stripe account that expands the
 * latest invoice only when it is asked to, as Stripe does:
 *
 *   - past due with an attempt scheduled: open, at every door (the course,
 *     the community, the download, the list of purchases);
 *   - past due with no attempt scheduled: ended, at every door;
 *   - past due whose latest invoice was not read (an id, nothing, or any
 *     other shape): ended, as every door already treats a state it cannot
 *     read; no door reads it that way, because each asks for it;
 *   - active and trialing are read exactly as before, whatever the invoice;
 *     a pause the member chose still reads as paused.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { isLiveSub, memberState } from "@/lib/membership-access";
import { paidCourses } from "@/lib/learn";
import { paidForAny } from "@/lib/community-access";
import { purchasesFor } from "@/lib/buyer-orders";
import { readOrder } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_past_due_retry_only";

const OWNER = "coach@example.com";
const ACCOUNT = "acct_1TestPastDue001";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** Checkouts by the address they were paid from, and by their id, with their subscription in full. */
const sessions: Record<string, Record<string, unknown>[]> = {};
const oneSession: Record<string, Record<string, unknown>> = {};

/** What Stripe sends for a subscription: its latest invoice in full only when that expansion was asked for. */
function shaped(session: Record<string, unknown>, expanded: boolean): Record<string, unknown> {
  const sub = session.subscription as Record<string, unknown> | null;
  if (!sub || typeof sub !== "object" || expanded) return session;
  const invoice = sub.latest_invoice as { id?: string } | null;
  return { ...session, subscription: { ...sub, latest_invoice: invoice && typeof invoice === "object" ? invoice.id : invoice } };
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  const expand = url.searchParams.getAll("expand[]");
  if (path === "/checkout/sessions") {
    const rows = sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [];
    return list(rows.map((row) => shaped(row, expand.includes("data.subscription.latest_invoice"))));
  }
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) return oneSession[one[1]] ? answer(shaped(oneSession[one[1]], expand.includes("subscription.latest_invoice"))) : answer({ error: { message: "no such" } }, 404);
  return list([]);
}) as typeof fetch;

/** A latest invoice as Stripe sends it once a renewal failed: open, with the next attempt or none. */
const invoice = (id: string, nextAttempt: number | null) => ({ id, object: "invoice", status: "open", collection_method: "charge_automatically", attempt_count: 2, next_payment_attempt: nextAttempt });
const RETRYING = (id: string) => invoice(`in_${id}`, NOW + 3 * DAY);
const STOPPED = (id: string) => invoice(`in_${id}`, null);

const member = (id: string, product: string, status: string, latest: unknown) => ({
  id,
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  created: NOW - 40 * DAY,
  customer: "cus_TestMember001",
  customer_details: { email: "member@example.com" },
  amount_total: 1500,
  metadata: { store: "coachclub", product },
  payment_intent: null,
  subscription: { id: `sub_${id.slice(8)}`, object: "subscription", status, latest_invoice: latest, items: { data: [{ current_period_end: NOW - 10 * DAY }] } },
});

async function main(): Promise<void> {
  redis.clear();

  part("The rule, on the subscription as Stripe sent it");
  is("past due, another attempt scheduled: open (the retry grace)", isLiveSub({ status: "past_due", latest_invoice: RETRYING("TestA") }), true);
  is("past due, an attempt due now that Stripe has not made yet: open", isLiveSub({ status: "past_due", latest_invoice: invoice("in_TestB", NOW - 60) }), true);
  is("past due, no attempt scheduled any more: ended", isLiveSub({ status: "past_due", latest_invoice: STOPPED("TestC") }), false);
  is("and it reads as a state of its own, not past_due", memberState({ status: "past_due", latest_invoice: STOPPED("TestC") }) === "past_due", false);
  for (const [what, latest] of [
    ["an invoice id Stripe did not expand", "in_TestNotRead01"],
    ["no latest invoice", null],
    ["the field missing", undefined],
    ["a list", [RETRYING("TestD")]],
    ["no next attempt field", { id: "in_TestE", status: "open" }],
    ["a date as text", { id: "in_TestF", next_payment_attempt: String(NOW + DAY) }],
    ["a date that is not a whole number", { id: "in_TestG", next_payment_attempt: NOW + 0.5 }],
    ["zero", { id: "in_TestH", next_payment_attempt: 0 }],
    ["a negative date", { id: "in_TestI", next_payment_attempt: -1 }],
  ] as const) {
    is(`past due, ${what}: ended, never read as a retry`, isLiveSub({ status: "past_due", latest_invoice: latest }), false);
  }
  for (const status of ["active", "trialing"]) {
    for (const [what, latest] of [["no invoice read", undefined], ["an id", "in_TestJ"], ["an invoice with no attempt", STOPPED("TestK")]] as const) {
      is(`${status}, ${what}: open, as before`, [isLiveSub({ status, latest_invoice: latest }), memberState({ status, latest_invoice: latest })], [true, status]);
    }
  }
  for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
    is(`${status}: ended, as before, whatever the invoice`, [isLiveSub({ status, latest_invoice: RETRYING("TestL") }), memberState({ status, latest_invoice: RETRYING("TestL") })], [false, status]);
  }
  const pause = { pause_collection: { behavior: "void", resumes_at: NOW + 20 * DAY }, metadata: { pause_from: String(NOW - DAY) } };
  is("a pause the member chose still reads as paused first", [memberState({ status: "active", ...pause }), memberState({ status: "past_due", latest_invoice: RETRYING("TestM"), ...pause })], ["paused", "paused"]);

  await claimHandle(OWNER, "coachclub", "Coach Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const course = await addProduct(OWNER, "Running Club", "", "15", { interval: "month" } as Parameters<typeof addProduct>[4]);
  const notes = await addProduct(OWNER, "Training Notes", "", "9", { interval: "month" } as Parameters<typeof addProduct>[4]);
  if (!course.ok || !notes.ok) throw new Error("no products");
  await setProductCourse(OWNER, course.product.id, { id: "c".repeat(32), lessons: 4 });
  await setProductLink(OWNER, notes.product.id, "https://example.com/training-notes");
  const store = (await storeForEmail(OWNER))!;
  const club = course.product.id;
  const ids = new Set([club]);

  part("The doors, each asking Stripe for the latest invoice with the membership");
  const cases = [
    ["retry", RETRYING, true],
    ["stop", STOPPED, false],
  ] as const;
  for (const [tag, latest, open] of cases) {
    const email = `${tag}@example.com`;
    const id = `cs_test_${tag}00000000001`;
    sessions[email] = [member(id, club, "past_due", latest(`Test${tag}01`))];
    const label = open ? "an attempt scheduled: open" : "no attempt scheduled: ended";
    is(`the course, ${label}`, [...(await paidCourses(store, email)).keys()], open ? [club] : []);
    is(`the community, ${label}`, await paidForAny(store, email, ids), open);

    const download = `cs_test_${tag}0000000dl01`;
    // Read within its three days, the window a download link has.
    oneSession[download] = { ...member(download, notes.product.id, "past_due", latest(`Test${tag}02`)), created: NOW - 3600 };
    const order = await readOrder(store, download);
    is(`the download, ${label}`, order.state === "paid" ? order.membership : order.state, open ? "live" : "ended");

    const listed = `${tag}list@example.com`;
    sessions[listed] = [member(`cs_test_${tag}000000list1`, notes.product.id, "past_due", latest(`Test${tag}03`))];
    const shown = (await purchasesFor(store, listed)).map((p) => ({ member: p.member, ended: p.ended }));
    is(`the list of purchases, ${label}`, shown, [open ? { member: true, ended: false } : { member: false, ended: true }]);
  }

  part("Active members are let in as before");
  sessions["act@example.com"] = [member("cs_test_act00000000001", club, "active", "in_TestActive01")];
  is("the course", [...(await paidCourses(store, "act@example.com")).keys()], [club]);
  is("the community", await paidForAny(store, "act@example.com", ids), true);

  part("The single read of a purchase asks for what the list asks for");
  const orders = readFileSync("lib/buyer-orders.ts", "utf8");
  is("lib/buyer-orders.ts reads a checkout alone with its membership's latest invoice", orders.includes('query.append("expand[]", "subscription.latest_invoice");'), true);

  done();
}

void main();
