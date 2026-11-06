/**
 * 232 [CA1] unit 5: a creator who disputes a payment they made to us for
 * their plan has what costs us to run paused, as for an unpaid renewal, and
 * the dispute is written on the store's record.
 *
 *   - Stripe's statuses read as open, won (won, inquiry closed) or lost;
 *   - open pauses; won lifts; lost pauses to the end of the period paid for
 *     (a year when that cannot be read); the oldest spent ones go first;
 *   - checkout and sign-ups (isPaidUp), emails to the list, AI, uploads and
 *     video (costStandingOf) stop; the upload routes refuse with their own
 *     code, and the studio and the Terms say the same words;
 *   - the daily job reads Stripe's disputes, finds the plan invoice and its
 *     store, skips the Store assistant and anything that is not a plan,
 *     carries on past one that cannot be read, is bounded by a deadline and
 *     a page cap and keeps a cursor, and writing the same dispute twice
 *     changes nothing.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isPaidUp } from "@/lib/billing";
import { canUse } from "@/lib/plan";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { costPauseCode, costStandingOf, costsPaused } from "@/lib/plan-standing";
import {
  DISPUTE_KEPT_WORDS,
  DISPUTE_OUTCOME_WORDS,
  DISPUTE_PAUSED_WORDS,
  PLAN_DISPUTES_KEPT,
  type PlanDispute,
  coveredUntil,
  disputeStatusOf,
  parsePlanDisputes,
  planDisputed,
  withPlanDispute,
} from "@/lib/plan-dispute-rules";
import { MAX_PAGES, syncPlanDisputes } from "@/lib/plan-disputes";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { PlanDisputeNotice } from "@/components/plan-dispute-notice";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_dispute_only";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const owner = "plan-dispute@example.com";
const handle = "plan-dispute-shop";
const SUB = "sub_PlanDispute01";
const ADDON = "sub_PlanDisputeAddon";
const OTHER = "sub_PlanDisputeOther";
const BROKEN = "sub_PlanDisputeBroken";

let byId: Record<string, Record<string, unknown>> = {};
let pages: { data: Record<string, unknown>[]; has_more: boolean }[] = [];
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    asked.push(`${method} ${url.pathname}${url.search}`);
    if (method !== "GET") return new Response("{}", { status: 400 });
    if (url.pathname.startsWith("/v1/disputes/")) {
      const id = url.pathname.split("/").pop() ?? "";
      return byId[id] ? Response.json(byId[id]) : new Response(JSON.stringify({ error: { message: "missing" } }), { status: 404 });
    }
    if (url.pathname === "/v1/disputes") {
      const after = url.searchParams.get("starting_after");
      const index = after ? pages.findIndex((page) => page.data.some((row) => row.id === after)) + 1 : 0;
      return Response.json(pages[index] ?? { data: [], has_more: false });
    }
    if (url.pathname === `/v1/subscriptions/${SUB}`) return Response.json({ id: SUB, metadata: { store: handle }, customer: "cus_PlanDispute01" });
    if (url.pathname === `/v1/subscriptions/${ADDON}`) return Response.json({ id: ADDON, metadata: { store: handle, addon: "assistant" }, customer: "cus_PlanDispute01" });
    if (url.pathname === `/v1/subscriptions/${OTHER}`) return Response.json({ id: OTHER, metadata: { store: handle }, customer: "cus_SomeoneElse" });
    if (url.pathname === `/v1/subscriptions/${BROKEN}`) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

function dispute(id: string, status: string, subscription: string | null, periodEnd = NOW + 20 * DAY): Record<string, unknown> {
  return {
    id,
    object: "dispute",
    status,
    created: NOW - DAY,
    charge: { id: `ch_${id.slice(3)}`, invoice: subscription ? { id: `in_${id.slice(3)}`, subscription, lines: { data: [{ period: { start: NOW - 10 * DAY, end: periodEnd } }] } } : null },
  };
}

async function setup() {
  redis.clear();
  asked.length = 0;
  await claimHandle(owner, handle, "Plan dispute shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_PlanDispute01", subscriptionId: SUB, active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

const open: PlanDispute = { id: "du_Open1", status: "open", at: NOW - DAY, coversUntil: NOW + 20 * DAY };

async function main() {
  part("Stripe's statuses read as what the bank decided");
  is("won", disputeStatusOf("won"), "won");
  is("an inquiry closed without a chargeback", disputeStatusOf("warning_closed"), "won");
  is("lost", disputeStatusOf("lost"), "lost");
  for (const status of ["needs_response", "under_review", "warning_needs_response", "warning_under_review", "something_new", undefined]) {
    is(`${String(status)} is open`, disputeStatusOf(status), "open");
  }

  part("Open pauses, won lifts, lost pauses to the end of the period paid for");
  is("open pauses", planDisputed({ planDisputes: [open] }, NOW), true);
  is("won does not", planDisputed({ planDisputes: [{ ...open, status: "won" }] }, NOW), false);
  is("lost pauses before the period ends", planDisputed({ planDisputes: [{ ...open, status: "lost" }] }, NOW), true);
  is("lost stops pausing once it ended", planDisputed({ planDisputes: [{ ...open, status: "lost" }] }, NOW + 21 * DAY), false);
  is("no dispute pauses nothing", planDisputed({}, NOW), false);
  const unknownEnd = parsePlanDisputes([{ id: "du_NoEnd", status: "lost", at: NOW - DAY }]);
  is("a period that could not be read is kept for a year", unknownEnd[0]?.coversUntil, NOW - DAY + 366 * DAY);
  is("a broken entry is dropped", parsePlanDisputes([{ id: "x", status: "open", at: 1 }, { id: "du_A", status: "nope", at: 1 }, null]).length, 0);
  is("coveredUntil reads the latest line end", coveredUntil({ lines: { data: [{ period: { end: 5 } }, { period: { end: 9 } }] } }), 9);
  is("coveredUntil is 0 with no lines", coveredUntil(null), 0);
  const known = withPlanDispute([open], { ...open, status: "lost", at: 1, coversUntil: 2 }, NOW);
  is("a known dispute takes its new status and keeps what was first read", known, [{ ...open, status: "lost" }]);
  is("a decided dispute is never reopened", withPlanDispute([{ ...open, status: "won" }], { ...open, status: "open" }, NOW), [{ ...open, status: "won" }]);
  const twelve = Array.from({ length: 12 }, (_, i) => ({ ...open, id: `du_Keep${i}` }));
  is("reading a record never drops one that still pauses", parsePlanDisputes(twelve).length, 12);
  let many: PlanDispute[] = [];
  for (let i = 0; i < PLAN_DISPUTES_KEPT; i += 1) many = withPlanDispute(many, { id: `du_Open${i}`, status: "open", at: NOW, coversUntil: NOW + DAY }, NOW);
  const full = withPlanDispute(many, { id: "du_Extra", status: "open", at: NOW, coversUntil: NOW + DAY }, NOW);
  is("past the limit, none that still pauses is dropped", full.length, PLAN_DISPUTES_KEPT + 1);
  const spent = withPlanDispute([{ ...open, id: "du_Won", status: "won" }, ...many.slice(1)], { id: "du_New", status: "open", at: NOW, coversUntil: NOW + DAY }, NOW);
  is("past the limit, a decided one goes first", spent.some((kept) => kept.id === "du_Won"), false);

  part("A paused plan stops what costs us to run, without ending");
  {
    const store = await setup();
    is("paid up before", isPaidUp(store), true);
    const disputed = { ...store, planDisputes: [open] };
    is("not paid up while disputed", isPaidUp(disputed), false);
    is("emails to the list stop", canUse(disputed, "email"), false);
    is("its domain and look stay", canUse(disputed, "domain"), true);
    is("costs stand as an ended plan", costStandingOf(disputed, NOW), "ended");
    is("costsPaused", costsPaused(disputed, NOW), true);
    is("routes refuse with their own code", costPauseCode(disputed, NOW), "plan_disputed");
    is("an unpaid renewal keeps its own code", costPauseCode({ ...disputed, renewalUnpaidSince: NOW }, NOW), "renewal_unpaid");
    is("won: paid up again", isPaidUp({ ...store, planDisputes: [{ ...open, status: "won" }] }), true);
    is("a plan that is not running is not paused by it", costPauseCode({ ...disputed, subscriptionActive: false }, NOW), null);
  }

  part("The upload routes refuse with plan_disputed");
  for (const route of ["app/api/store/file/route.ts", "app/api/store/image/upload/route.ts", "app/api/store/mail/picture/route.ts", "app/api/store/vault/route.ts", "app/api/store/stream/route.ts"]) {
    const source = readFileSync(route, "utf8");
    is(`${route} asks costPauseCode`, source.includes("costPauseCode(store)") && !source.includes("renewalUnpaid(store)"), true);
  }
  for (const route of ["app/api/store/file/route.ts", "app/api/store/image/upload/route.ts"]) {
    const source = readFileSync(route, "utf8");
    is(`${route} answers plan_disputed with 409, not a server error`, /"plan_disputed"\]\.includes\(reason\)/.test(source) && source.includes('reason === "plan_disputed" ? 409'), true);
  }
  is("the studio has a sentence for it", typeof STUDIO_MESSAGES.plan_disputed, "string");
  is("the course editor stops on it", readFileSync("components/course-editor.tsx", "utf8").includes('"plan_disputed"'), true);

  part("The studio and the Terms say the same words");
  const notice = renderToStaticMarkup(createElement(PlanDisputeNotice));
  const html = (text: string) => text.replace(/'/g, "&#x27;");
  is("the notice says what pauses, what stays and what comes next", [DISPUTE_PAUSED_WORDS, DISPUTE_KEPT_WORDS, DISPUTE_OUTCOME_WORDS].every((words) => notice.includes(html(words))), true);
  const terms = readFileSync("app/terms/page.tsx", "utf8");
  is("the Terms use the same words", ["{DISPUTE_PAUSED_WORDS}", "{DISPUTE_KEPT_WORDS}", "{DISPUTE_OUTCOME_WORDS}"].every((words) => terms.includes(words)), true);
  is("the studio shows the notice", readFileSync("app/studio/page.tsx", "utf8").includes("planDisputed(current) ? <PlanDisputeNotice />"), true);
  is("the daily job runs it", readFileSync("app/api/cron/plans/route.ts", "utf8").includes("syncPlanDisputes("), true);

  part("The daily job writes a dispute of a plan payment on its store");
  {
    await setup();
    pages = [{ data: [dispute("du_Plan1", "needs_response", SUB), dispute("du_Addon1", "needs_response", ADDON), dispute("du_NoInvoice", "needs_response", null), dispute("du_Other1", "needs_response", OTHER), dispute("du_Broken1", "needs_response", BROKEN)], has_more: false }];
    const first = await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("counts", first, { seen: 5, recorded: 1, unmatched: 3, reread: 0, failed: 1, complete: true });
    const after = (await storeForEmail(owner))!;
    is("the plan's dispute is written down", after.planDisputes?.map((kept) => [kept.id, kept.status, kept.coversUntil]), [["du_Plan1", "open", NOW + 20 * DAY]]);
    is("and pauses the store's costs", costPauseCode(after, NOW), "plan_disputed");
    is("the list asked looks back 120 days and expands the invoice", asked.some((line) => line.startsWith("GET /v1/disputes?") && line.includes(`created%5Bgte%5D=${NOW - 120 * DAY}`) && line.includes("expand%5B%5D=data.charge.invoice")), true);
    is("nothing but reads is sent to Stripe", asked.every((line) => line.startsWith("GET ")), true);
    asked.length = 0;
    const again = await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("the same dispute again changes nothing", again.recorded, 0);
    const unmatchedNow = asked.filter((line) => line.includes(OTHER)).length;
    is("one that matched no plan is asked about again within the week", unmatchedNow, 1);
    asked.length = 0;
    await syncPlanDisputes(Date.now() + 10_000, NOW + 8 * DAY);
    is("and no longer after it", asked.filter((line) => line.includes(OTHER)).length, 0);
    asked.length = 0;
    await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("disputes already read cost no subscription read", asked.filter((line) => line.startsWith("GET /v1/subscriptions/") && !line.includes(BROKEN) && !line.includes(OTHER) && !line.includes(ADDON)).length, 0);
    is("still one", (await storeForEmail(owner))!.planDisputes?.length, 1);
    pages = [{ data: [dispute("du_Plan1", "won", SUB)], has_more: false }];
    const won = await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("the bank's decision is written", won.recorded, 1);
    const lifted = (await storeForEmail(owner))!;
    is("won lifts the pause", [lifted.planDisputes?.[0]?.status, costPauseCode(lifted, NOW), isPaidUp(lifted)], ["won", null, true]);
    asked.length = 0;
    await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("a decided dispute listed again costs no subscription read", asked.filter((line) => line.startsWith("GET /v1/subscriptions/")).length, 0);
  }

  part("Bounded, newest first, and open ones past the window read by id");
  {
    await setup();
    pages = Array.from({ length: MAX_PAGES + 2 }, (_, page) => ({ data: [dispute(`du_Page${page}`, "lost", SUB)], has_more: page < MAX_PAGES + 1 }));
    const capped = await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("stops at the page cap, not complete", [capped.seen, capped.complete], [MAX_PAGES, false]);
    pages = [{ data: [dispute("du_Newest", "needs_response", SUB)], has_more: true }, ...pages];
    const next = await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("a new dispute is read first in the next run", (await storeForEmail(owner))!.planDisputes?.some((kept) => kept.id === "du_Newest" && kept.status === "open"), true);
    is("and only it costs a subscription read", next.recorded, 1);
    asked.length = 0;
    const late = await syncPlanDisputes(Date.now() - 1, NOW);
    is("a deadline already passed asks Stripe nothing", [late.seen, asked.length], [0, 0]);
    pages = [{ data: [], has_more: false }];
    byId = { du_Newest: { id: "du_Newest", object: "dispute", status: "won", created: NOW - 200 * DAY } };
    const reread = await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("an open dispute the list no longer returns is read by id", [reread.reread, reread.recorded], [1, 1]);
    const lifted = (await storeForEmail(owner))!;
    is("and its decision is written", lifted.planDisputes?.find((kept) => kept.id === "du_Newest")?.status, "won");
    asked.length = 0;
    await syncPlanDisputes(Date.now() + 10_000, NOW);
    is("once decided it is not read again", asked.filter((line) => line.startsWith("GET /v1/disputes/")).length, 0);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
