/**
 * 232 [CA1] unit 4: a renewal Stripe could not collect stops what costs us
 * to run from the first day it is seen, without ending the plan.
 *
 *   - Stripe's `past_due` (in its grace) is read as an active plan with its
 *     renewal unpaid; the first payment after a trial stays "inactive";
 *   - the store's record dates it once, keeps the date while it stays
 *     unpaid, clears it when paid, when the plan stops or for another
 *     subscription; the plan is not ended, not put in line for closing, and
 *     the store leaves the list of stores that pay;
 *   - checkout, free copies, sign-ups (isPaidUp), emails to the list
 *     (canUse "email"), AI drafts, AI spending, uploads and lesson video
 *     (costStandingOf) stop; the studio's own figure, the store's domain and
 *     look and its billing window do not;
 *   - the reminders job writes it down before its email says so, and a
 *     failure to write it keeps the email for the next run;
 *   - the studio shows Stripe's own page that pays the open invoice, read
 *     fresh, and says what stopped and what did not; the email and the Terms
 *     say the same words.
 */
import { readFileSync } from "node:fs";
import { mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isPaidUp, renewalInvoicePage, stateOf } from "@/lib/billing";
import { recordState, recordUnpaidRenewal } from "@/lib/billing-sync";
import { failedPlan, failedPlanEmail, sendFailedPlanNotices } from "@/lib/billing-reminders";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { SETUP_VIDEO_SECONDS, costPauseCode, costStandingOf, renewalUnpaid, standingOf, videoLimitFor } from "@/lib/plan-standing";
import { paidVideoSeconds } from "@/lib/video-admission-rules";
import { canUse } from "@/lib/plan";
import { uploadScopeFor } from "@/lib/upload-budget";
import { allowanceWindow } from "@/lib/allowance-window";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { PAYING_INDEX } from "@/lib/free-pool-rules";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { picturesLimitFor } from "@/lib/community-picture-rules";
import { taskRoomFor } from "@/lib/assignment-rules";
import { RENEWAL_KEPT_WORDS, RENEWAL_PAUSED_WORDS, RENEWAL_RESUME_WORDS } from "@/lib/renewal-unpaid-words";
import { RenewalUnpaidNotice } from "@/components/renewal-unpaid-notice";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_renewal_unpaid_only";
process.env.RESEND_API_KEY = "re_test_renewal_unpaid_only";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const owner = "renewal-unpaid@example.com";
const handle = "renewal-unpaid-shop";
const SUB = "sub_RenewalUnpaid01";

type Reply = { status: number; body: unknown };
let detail: Reply = { status: 200, body: {} };
let list: Record<string, unknown>[] = [];
const asked: string[] = [];
const emails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    asked.push(`${method} ${url.pathname}${url.search}`);
    if (method === "GET" && url.pathname === "/v1/subscriptions") return Response.json({ data: list, has_more: false });
    if (method === "GET" && url.pathname === `/v1/subscriptions/${SUB}`) return new Response(JSON.stringify(detail.body), { status: detail.status });
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) return Response.json({ id: url.pathname.split("/").pop() });
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, text: body.text });
    return Response.json({ id: "re_1" });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

function subscription(status: string, over: Record<string, unknown> = {}, invoice: Record<string, unknown> = {}): Record<string, unknown> {
  const period = paidPeriod(NOW * 1_000);
  return {
    id: SUB,
    status,
    created: NOW - 90 * DAY,
    trial_end: NOW - 76 * DAY,
    metadata: { store: handle },
    customer: { email: owner },
    cancel_at: null,
    cancel_at_period_end: false,
    items: { data: [{ current_period_start: period.start, current_period_end: period.end, price: { lookup_key: "nimbus_labs_pro_month", unit_amount: 44900, recurring: { interval: "month" } } }] },
    latest_invoice: { id: "in_RenewalUnpaid01", status: "open", amount_due: 44900, hosted_invoice_url: "https://invoice.stripe.com/i/acct_x/test_unpaid", next_payment_attempt: NOW + 3 * DAY, ...invoice },
    ...over,
  };
}

async function setup() {
  redis.clear();
  asked.length = 0;
  emails.length = 0;
  await claimHandle(owner, handle, "Renewal unpaid shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_RenewalUnpaid01", subscriptionId: SUB, active: true, tier: "pro", cycle: "month", period: paidPeriod(NOW * 1_000) });
  return (await storeForEmail(owner))!;
}

const members = async (key: string) => ((await redis.pipeline([["SMEMBERS", key]]))[0] as string[]) ?? [];
const scored = async (key: string, member: string) => (await redis.pipeline([["ZSCORE", key, member]]))[0] !== null;

async function main() {
  part("Stripe's past_due is an active plan with its renewal unpaid");
  {
    const unpaid = stateOf(subscription("past_due"));
    is("a renewal in its grace is still active", unpaid.state, "active");
    is("and is read as unpaid", unpaid.state === "active" && unpaid.renewalUnpaid, true);
    const paid = stateOf(subscription("active"));
    is("an active plan is not unpaid", paid.state === "active" && paid.renewalUnpaid, false);
    const trial = stateOf(subscription("trialing", { trial_end: NOW + 5 * DAY }));
    is("a trial is not unpaid", trial.state === "active" && trial.renewalUnpaid, false);
    const period = paidPeriod(NOW * 1_000);
    const afterTrial = stateOf(subscription("past_due", { trial_end: period.start }));
    is("the first payment after a trial is still not a running plan", afterTrial.state, "inactive");
  }

  part("The record dates it once, keeps it, clears it");
  {
    const store = await setup();
    is("a paying store starts in the list of stores that pay", (await members(PAYING_INDEX)).includes(storeRef(store)), true);
    is("written when Stripe says past_due", await recordState(store, stateOf(subscription("past_due"))), true);
    const unpaid = (await storeForEmail(owner))!;
    const since = unpaid.renewalUnpaidSince ?? 0;
    is("dated now", since > 0 && Math.abs(since - Math.floor(Date.now() / 1000)) < 60, true);
    is("still an active plan", unpaid.subscriptionActive, true);
    is("not an ended plan", unpaid.planEndedAt, "");
    is("not in line for closing", await scored(ENDED_INDEX, storeRef(unpaid)), false);
    is("no longer in the list of stores that pay", (await members(PAYING_INDEX)).includes(storeRef(unpaid)), false);
    is("its billing month is kept", allowanceWindow(unpaid)?.billing, true);
    // Re-reading the same Stripe fixture must stay unchanged even when the
    // wall clock crosses a second between the two reads.
    const secondReadAt = Date.now() + 1_000;
    const clock = mock.method(Date, "now", () => secondReadAt);
    try {
      is("a second reading writes nothing", await recordState(unpaid, stateOf(subscription("past_due"))), false);
    } finally {
      clock.mock.restore();
    }
    await setSubscription(owner, { active: true, tier: "pro", cycle: "month", period: paidPeriod(NOW * 1_000) });
    is("a write that does not say keeps the first day", (await storeForEmail(owner))!.renewalUnpaidSince, since);
    is("paid: written again", await recordState((await storeForEmail(owner))!, stateOf(subscription("active"))), true);
    const paid = (await storeForEmail(owner))!;
    is("paid: cleared", paid.renewalUnpaidSince, 0);
    is("paid: back in the list of stores that pay", (await members(PAYING_INDEX)).includes(storeRef(paid)), true);

    await recordState(paid, stateOf(subscription("past_due")));
    await setSubscription(owner, { subscriptionId: "sub_AnotherPlan0001", active: true, tier: "pro", cycle: "month", period: paidPeriod(NOW * 1_000) });
    is("another subscription starts paid up", (await storeForEmail(owner))!.renewalUnpaidSince, 0);
    await recordState((await storeForEmail(owner))!, { ...stateOf(subscription("past_due")) });
    await setSubscription(owner, { active: false });
    is("a plan that stops is not unpaid, it is ended", [(await storeForEmail(owner))!.renewalUnpaidSince, Boolean((await storeForEmail(owner))!.planEndedAt)], [0, true]);
  }

  part("What stops, and what does not");
  {
    await setup();
    await recordState((await storeForEmail(owner))!, stateOf(subscription("past_due")));
    const store = (await storeForEmail(owner))!;
    is("renewalUnpaid", renewalUnpaid(store), true);
    is("standingOf is still paid: nothing closes", standingOf(store), "paid");
    is("costs are run as an ended plan", costStandingOf(store), "ended");
    is("not paid up: no checkout, free copies or sign-ups", isPaidUp(store), false);
    is("no emails to the list", canUse(store, "email"), false);
    is("the store's domain and look stay", [canUse(store, "domain"), canUse(store, "branding")], [true, true]);
    // AI spending's scope (aiBudgetScopeFor, lib/ai-spend.ts) is held in tests/ai-spend.test.ts, which runs the real module.
    is("uploads are an ended store's", uploadScopeFor(store), "ended");
    is("lesson video is a store with no plan's", videoLimitFor(store), SETUP_VIDEO_SECONDS);
    is("no new community pictures", [picturesLimitFor(store), picturesLimitFor({ ...store, renewalUnpaidSince: 0 }) > 0], [0, true]);
    is("no new students' hand-ins", [taskRoomFor(store), taskRoomFor({ ...store, renewalUnpaidSince: 0 }) > 0], [0, true]);
    is("the studio keeps its plan's figure", allowanceFor(store, "studio"), allowanceFor({ ...store, renewalUnpaidSince: 0 }, "studio"));
    is("buyers keep their access emails", allowanceFor(store, "transactional"), allowanceFor({ ...store, renewalUnpaidSince: 0 }, "transactional"));
    const paid = { ...store, renewalUnpaidSince: 0 };
    is("paid up again: everything back", [isPaidUp(paid), canUse(paid, "email"), costStandingOf(paid), videoLimitFor(paid) === paidVideoSeconds("pro")], [true, true, "paid", true]);
    is("an ended plan with a stale date is not unpaid", renewalUnpaid({ subscriptionActive: false, renewalUnpaidSince: 5 }), false);
  }

  part("The upload doors refuse first, with words that say what to do");
  {
    for (const file of ["app/api/store/file/route.ts", "app/api/store/vault/route.ts", "app/api/store/stream/route.ts"]) {
      const source = readFileSync(file, "utf8");
      // costPauseCode answers renewal_unpaid for an unpaid renewal (unit 5 shares the door; checked below).
      const check = source.indexOf("costPauseCode(store)");
      is(`${file} checks before reserving`, check > 0 && check < source.indexOf("reserveStoreUpload(store"), true);
      is(`${file} answers the code it is given`, /const paused = costPauseCode\(store\); if \(paused\) (throw new Error\(paused\)|return fail\(paused, 409\)|return Response\.json\(\{ ok: false, error: paused \}, \{ status: 409 \}\))/.test(source), true);
    }
    for (const [file, before] of [["app/api/store/image/upload/route.ts", "issueSignedToken("], ["app/api/store/mail/picture/route.ts", "keepMailPicture("]] as const) {
      const source = readFileSync(file, "utf8");
      const check = source.indexOf("const paused = costPauseCode(store); if (paused)");
      is(`${file} refuses renewal_unpaid before storing`, check > 0 && check < source.indexOf(before), true);
    }
    is("costPauseCode says renewal_unpaid for it", costPauseCode({ subscriptionActive: true, renewalUnpaidSince: 5 }), "renewal_unpaid");
    const usage = readFileSync("app/api/cron/usage/route.ts", "utf8");
    is("the usage job does not send a 'video hours used' email for an unpaid renewal", usage.indexOf("if (costsPaused(store)) continue;") > 0 && usage.indexOf("if (costsPaused(store)) continue;") < usage.indexOf("videoUsageNotice({"), true);
        is("the studio has the sentence", /renewal payment did not go through/.test(STUDIO_MESSAGES.renewal_unpaid ?? ""), true);
  }

  part("The reminders job writes it down before it says it");
  {
    await setup();
    list = [subscription("past_due")];
    const sent = await sendFailedPlanNotices();
    is("one email", sent.sent, 1);
    is("the store is recorded unpaid", ((await storeForEmail(owner))!.renewalUnpaidSince ?? 0) > 0, true);
    is("the email says what stopped and what did not", [emails[0]?.text.includes(RENEWAL_PAUSED_WORDS), emails[0]?.text.includes(RENEWAL_KEPT_WORDS), emails[0]?.text.includes(RENEWAL_RESUME_WORDS)], [true, true, true]);
    is("it no longer says the store keeps taking payments", emails[0]?.text.includes("keeps taking payments"), false);

    // CX-123 rule 24: a renewal whose reply does not carry its stop fields
    // exactly is "unknown", never "not unpaid". The email says what has
    // stopped, so it waits: nothing is sent, the store is not touched, the
    // claim is let go, and the next run with a full reply does both.
    await setup();
    const unknownRenewal = subscription("past_due");
    delete unknownRenewal.cancel_at;
    is("a renewal reply without cancel_at is unknown", stateOf(unknownRenewal), { state: "unknown" });
    let refused = false;
    try { await recordUnpaidRenewal(unknownRenewal); } catch { refused = true; }
    is("recordUnpaidRenewal refuses an unknown plan rather than answering 'not unpaid'", refused, true);
    list = [unknownRenewal];
    emails.length = 0;
    const held = await sendFailedPlanNotices();
    is("no email goes while the plan is unknown", [held.sent, held.failed, emails.length], [0, 1, 0]);
    is("the store is not recorded unpaid", (await storeForEmail(owner))!.renewalUnpaidSince ?? 0, 0);
    is("the claim is let go, so the next run tries again", (await redis.pipeline([["GET", "nl:remind:failed:in_RenewalUnpaid01"]]))[0], null);
    list = [subscription("past_due")];
    const retried = await sendFailedPlanNotices();
    is("the next run with a full reply writes it down and sends the one email",
      [retried.sent, emails.length, ((await storeForEmail(owner))!.renewalUnpaidSince ?? 0) > 0], [1, 1, true]);
    const recorded = (await storeForEmail(owner))!.renewalUnpaidSince;
    refused = false;
    try { await recordUnpaidRenewal(unknownRenewal); } catch { refused = true; }
    is("an unknown reply is refused even once the renewal is written down", refused, true);
    is("and the written day is kept", (await storeForEmail(owner))!.renewalUnpaidSince, recorded);

    // Another store's subscription: nothing of this store is touched.
    await setup();
    is("a subscription the store did not write down is not recorded", await recordUnpaidRenewal({ ...subscription("past_due"), id: "sub_NotThisStore01" }), null);
    is("an add-on is not recorded", await recordUnpaidRenewal({ ...subscription("past_due"), metadata: { store: handle, addon: "assistant" } }), null);
    is("the store stays paid up", (await storeForEmail(owner))!.renewalUnpaidSince, 0);

    // The first payment after a trial is not a renewal: left to the daily job.
    await setup();
    const period = paidPeriod(NOW * 1_000);
    list = [subscription("past_due", { trial_end: period.start })];
    await sendFailedPlanNotices();
    is("after a trial, nothing is recorded as an unpaid renewal", (await storeForEmail(owner))!.renewalUnpaidSince, 0);
    const first = failedPlanEmail(failedPlan(subscription("past_due", { trial_end: period.start }))!);
    is("and its email keeps its own words", first.text.includes("Until it is paid, your checkout cannot take money."), true);
  }

  part("Stripe's own page that pays it, read fresh");
  {
    detail = { status: 200, body: subscription("past_due") };
    asked.length = 0;
    is("the open invoice's page", await renewalInvoicePage(SUB), "https://invoice.stripe.com/i/acct_x/test_unpaid");
    is("asked with the invoice expanded", asked, [`GET /v1/subscriptions/${SUB}?expand[]=latest_invoice`]);
    detail = { status: 200, body: subscription("past_due", {}, { status: "paid" }) };
    is("not a paid invoice", await renewalInvoicePage(SUB), null);
    detail = { status: 200, body: subscription("past_due", {}, { amount_due: 0 }) };
    is("not one with nothing on it", await renewalInvoicePage(SUB), null);
    detail = { status: 200, body: subscription("past_due", {}, { hosted_invoice_url: "https://evil.example/pay" }) };
    is("not a page that is not Stripe's", await renewalInvoicePage(SUB), null);
    detail = { status: 200, body: subscription("active") };
    is("not a plan that is paid", await renewalInvoicePage(SUB), null);
    detail = { status: 200, body: { ...subscription("past_due"), id: "sub_Somebodyelse01" } };
    is("not another subscription's", await renewalInvoicePage(SUB), null);
    detail = { status: 500, body: { error: { message: "down" } } };
    is("not when Stripe fails", await renewalInvoicePage(SUB), null);
    is("not a malformed id, and Stripe is not asked", [await renewalInvoicePage("sub_x/../../charges"), asked.filter((a) => a.includes("charges")).length], [null, 0]);
  }

  part("The studio's notice");
  {
    const withLink = renderToStaticMarkup(createElement(RenewalUnpaidNotice, { payUrl: "https://invoice.stripe.com/i/acct_x/test_unpaid", canPay: true }));
    is("a named region with a heading", /<section id="renewal-unpaid" aria-labelledby="renewal-unpaid-title"/.test(withLink) && /<h2 id="renewal-unpaid-title"/.test(withLink), true);
    is("says what stopped and what did not", withLink.includes(RENEWAL_PAUSED_WORDS.replace(/'/g, "&#x27;")) && withLink.includes(RENEWAL_KEPT_WORDS.replace(/'/g, "&#x27;")), true);
    is("links to Stripe's page with words that say where it goes", /href="https:\/\/invoice\.stripe\.com\/i\/acct_x\/test_unpaid"[^>]*>Pay the open invoice on Stripe/.test(withLink), true);
    const noLink = renderToStaticMarkup(createElement(RenewalUnpaidNotice, { payUrl: null, canPay: true }));
    is("without a page: how to get one from a person", noLink.includes("mailto:") && !noLink.includes("invoice.stripe.com"), true);
    const member = renderToStaticMarkup(createElement(RenewalUnpaidNotice, { payUrl: "https://invoice.stripe.com/i/acct_x/test_unpaid", canPay: false }));
    is("a team member without billing is told to ask, and gets no link", member.includes("Ask the store owner") && !member.includes("invoice.stripe.com"), true);

    const studio = readFileSync("app/studio/page.tsx", "utf8");
    is("the studio writes what Stripe says about the renewal", studio.includes("renewalUnpaid: live.renewalUnpaid === true") && studio.includes("plan.renewalUnpaid !== (store.renewalUnpaidSince ?? 0) > 0"), true);
    is("and draws the notice", studio.includes("<RenewalUnpaidNotice payUrl={renewalPage}"), true);
  }

  part("The Terms say the same words");
  {
    const terms = readFileSync("app/terms/page.tsx", "utf8");
    is("its own paragraph", terms.includes('id="renewal-unpaid"'), true);
    is("from the same words", ["{RENEWAL_PAUSED_WORDS}", "{RENEWAL_KEPT_WORDS}", "{RENEWAL_RESUME_WORDS}"].every((w) => terms.includes(w)), true);
    is("no unconditional promise that the plan ends", terms.includes("If Stripe\n          ends the plan after its last try"), true);
  }

  done();
}

main();
