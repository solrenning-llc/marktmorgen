/**
 * A membership sold to end after a set number of payments ("7-day free trial,
 * then 12 monthly payments of $9") can be cancelled by its member, from the
 * same page as any other membership, at the end of what is already paid for
 * or of the free trial. The thanks page, the confirmation email and the
 * store's facts all promise it: "at any time and without writing to anyone",
 * "cancel before then and you are not charged at all".
 *
 * finishPlan (lib/plans.ts) gives the subscription the end that was sold as
 * its cancel_at, at once, even in the trial. That end is not a cancellation:
 * it must not hide Cancel, refuse the form, or read as "ending" for a pause.
 * Stripe's own cancellation page is not used for it (it would act on a
 * subscription that already has a cancel_at); the store's page asks for the
 * confirmation and moves cancel_at to the end of the current period, never
 * later. The Stripe portal opened by "Change card" is held to the card for a
 * customer with such a membership, so it cannot offer to renew and wipe the
 * end that was sold.
 */
import { finishPlan } from "@/lib/plans";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { endsAtOf, membershipsFor, openCancel, openPortal } from "@/lib/membership-manage";
import { cannotPause, type PauseSub } from "@/lib/membership-pause-rules";
import { ordersWords } from "@/lib/buyer-words/orders";
import { MEMBERSHIP_WORDS } from "@/lib/buyer-words/membership";
import { deliveryWords } from "@/lib/answers";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
const TRIAL_END = NOW + 6 * 86_400;
const SESSION = "cs_test_" + "f".repeat(24);
let sub: Record<string, unknown> = {};
const portalSessions: URLSearchParams[] = [];
const updates: URLSearchParams[] = [];
let updateFails: "none" | "refused" | "down" | "other-end" = "none";
let listFails = false;

class Down extends Error {}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return json({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === `/checkout/sessions/${SESSION}`) {
    return json({ id: SESSION, status: "complete", subscription: "sub_Fixed00000001", metadata: { store: "club", product: (sub.metadata as Record<string, string>).product, ends_after: "12", ends_interval: "month", trial_days: "7" } });
  }
  if (path === "/subscriptions" && method === "GET") {
    if (listFails) return json({ error: { message: "down" } }, 500);
    return json({ object: "list", data: [sub], has_more: false });
  }
  if (path === "/subscriptions/sub_Fixed00000001" && method === "GET") return json(sub);
  if (path === "/subscriptions/sub_Fixed00000001" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    // finishPlan's own write is not one of the member's.
    if (!body.get("cancel_at") || sub.cancel_at !== undefined) updates.push(body);
    if (updateFails === "refused") return json({ error: { message: "refused" } }, 400);
    if (updateFails === "down") throw new Down("connection reset");
    const meta = { ...(sub.metadata as Record<string, string>) };
    for (const [k, v] of body) if (k.startsWith("metadata[")) meta[k.slice(9, -1)] = v;
    if (body.get("cancel_at")) sub = { ...sub, cancel_at: Number(body.get("cancel_at")) };
    sub = { ...sub, metadata: meta };
    return json(updateFails === "other-end" ? { ...sub, cancel_at: Number(sub.cancel_at) + 86_400 } : sub);
  }
  if (path === "/billing_portal/configurations" && method === "POST") return json({ id: "bpc_Test000001" });
  if (path === "/billing_portal/sessions" && method === "POST") {
    portalSessions.push(new URLSearchParams(String(init?.body)));
    return json({ id: "bps_1", url: "https://billing.stripe.com/p/session/x" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";
  process.env.RESEND_API_KEY = "re_test_only";
  const OWNER = "club@example.com";
  await claimHandle(OWNER, "club", "Supper Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestClub000001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "The Inner Circle", "", "9", { interval: "month", trialDays: 7, payments: 12 });
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const fresh = () => ({
    id: "sub_Fixed00000001",
    status: "trialing",
    customer: "cus_Member000001",
    trial_end: TRIAL_END,
    billing_cycle_anchor: TRIAL_END,
    metadata: { store: "club", product: made.product.id, ends_after: "12", ends_interval: "month" },
    items: { data: [{ current_period_end: TRIAL_END, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
  });
  sub = fresh();

  const token = "a".repeat(64);
  const hash = createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0, 40);
  const opens = createHash("sha256").update(`nimbus-manage-opens:${token}`).digest("hex").slice(0, 40);
  const link = async () => {
    await redis.pipeline([
      ["SET", `nl:manage:link:${hash}`, JSON.stringify({ a: "acct_1TestClub000001", c: "cus_Member000001", h: "club" }), "EX", 3600],
      // A fresh count of opens for each step: the limit on opens is not what this file is about.
      ["DEL", `nl:manage:opens:${opens}`],
    ]);
  };
  await link();
  const back = `https://marktmorgen.com/@club/manage?status=cancelled&token=${token}`;

  part("What the member is told (unchanged: the promise this file holds the code to)");
  const w = ordersWords("en");
  is("cancel before the trial ends and pay nothing", w.trialCharge("$9.00", false, 7, "November 15").includes("Cancel before then and you are not charged at all."), true);
  is("cancel it yourself, at any time, without writing to anyone", w.manageAt(true, "https://x/@club/manage", "member@example.com").startsWith("To manage or cancel it yourself before that, at any time and without writing to anyone"), true);
  is("store facts: can cancel at any time from a link", deliveryWords(product).includes("can cancel at any time from a link on the store"), true);

  part("The end that was sold is written at once, in the trial");
  is("finishPlan done", await finishPlan("acct_1TestClub000001", SESSION), "done");
  const sold = sub.cancel_at as number;
  is("cancel_at written while trialing", typeof sold === "number" && sub.status === "trialing", true);
  is("the sold end is not a cancellation: endsAtOf null", endsAtOf(sub as never), null);

  part("The member's page shows Cancel, and the end that was sold");
  let listed = await membershipsFor(store, token);
  is("listed", listed?.length, 1);
  is("Cancel shown (endsAt null)", listed?.[0]?.endsAt, null);
  is("the sold end is shown", listed?.[0]?.soldEnd, sold);
  is("pause: refused as fixed, not as ending", cannotPause({ ...sub, status: "active" } as unknown as PauseSub, 3), "fixed");

  part("Cancel in the trial: ends when the trial ends, nothing charged, from the store's own page");
  updates.length = 0;
  let result = await openCancel(store, token, "sub_Fixed00000001", "https://marktmorgen.com");
  is("accepted, back to the member's page with the confirmation", result, { ok: true, url: back });
  is("one update at Stripe", updates.length, 1);
  is("cancel_at moved to the trial's end", updates[0]?.get("cancel_at"), String(TRIAL_END));
  is("no proration", updates[0]?.get("proration_behavior"), "none");
  is("Stripe's cancellation page not used for it", portalSessions.length, 0);
  listed = await membershipsFor(store, token);
  is("the page now says when it ends", listed?.[0]?.endsAt, TRIAL_END);
  is("cancelled is not shown as the sold end", listed?.[0]?.soldEnd, null);
  updates.length = 0;
  result = await openCancel(store, token, "sub_Fixed00000001", "https://marktmorgen.com");
  is("a second Cancel is refused, nothing written", [result.ok, updates.length], [false, 0]);

  part("Cancel after the trial: ends with the period already paid for");
  const periodEnd = TRIAL_END + 30 * 86_400;
  sub = { ...fresh(), status: "active", cancel_at: sold, items: { data: [{ current_period_end: periodEnd, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] } };
  await link();
  updates.length = 0;
  result = await openCancel(store, token, "sub_Fixed00000001", "https://marktmorgen.com");
  is("accepted", result.ok, true);
  is("cancel_at moved to the paid period's end", updates[0]?.get("cancel_at"), String(periodEnd));

  part("The last period: nothing left to cancel");
  sub = { ...fresh(), status: "active", cancel_at: sold, items: { data: [{ current_period_end: sold, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] } };
  await link();
  updates.length = 0;
  is("endsAt is the sold end", (await membershipsFor(store, token))?.[0]?.endsAt, sold);
  result = await openCancel(store, token, "sub_Fixed00000001", "https://marktmorgen.com");
  is("refused, nothing written", [result.ok, updates.length], [false, 0]);

  part("A sold end that cannot be read fails closed: treated as already ending");
  sub = { ...fresh(), billing_cycle_anchor: undefined, trial_end: undefined, cancel_at: sold };
  await link();
  updates.length = 0;
  listed = await membershipsFor(store, token);
  is("endsAt is the cancel_at, and no sold end is claimed", [listed?.[0]?.endsAt, listed?.[0]?.soldEnd], [sold, null]);
  is("refused, nothing written", [(await openCancel(store, token, "sub_Fixed00000001", "https://marktmorgen.com")).ok, updates.length], [false, 0]);

  part("Stripe's answer decides what the member is told");
  for (const [fails, reason] of [["refused", "error"], ["down", "unsure"], ["other-end", "unsure"]] as const) {
    sub = { ...fresh(), cancel_at: sold };
    await link();
    updateFails = fails;
    result = await openCancel(store, token, "sub_Fixed00000001", "https://marktmorgen.com");
    is(`${fails}: ${reason}`, result, { ok: false, reason });
  }
  updateFails = "none";

  part("Every language has the confirmation and the unsure notice");
  for (const [lang, words] of Object.entries(MEMBERSHIP_WORDS)) {
    const ok =
      Boolean(words.manageNotices.cancelled?.title && words.manageNotices.cancelled?.body) &&
      Boolean(words.manageNotices.unsure?.title && words.manageNotices.unsure?.body) &&
      typeof words.fixedCancelNote === "function" &&
      words.fixedCancelNote("May 1").includes("May 1");
    is(`${lang}: cancelled, unsure, fixedCancelNote`, ok, true);
  }

  part("The pages ask for the confirmation before a fixed end is cancelled");
  const page = readFileSync("app/[handle]/manage/page.tsx", "utf8");
  const leave = readFileSync("app/[handle]/manage/leave/page.tsx", "utf8");
  is("manage page: fixed end cancels behind a confirmation (data-fixed-cancel)", page.includes("data-fixed-cancel") && page.includes("fixedCancelNote"), true);
  is("manage page: shows the sold end (endLine reads one.soldEnd)", page.includes("endLine(m, one, endDate)") && readFileSync("lib/membership-manage.ts", "utf8").includes("one.endsAt ?? one.soldEnd"), true);
  is("leave page: no 'Stripe's page opens' for a fixed end", leave.includes("one.fixedEnd ? m.fixedCancelNote"), true);

  part("Change card: the portal is held to the card while a fixed end is set");
  sub = { ...fresh(), cancel_at: sold };
  await link();
  portalSessions.length = 0;
  is("opened", (await openPortal(store, token, "https://marktmorgen.com")).ok, true);
  is("payment_method_update flow", portalSessions[0]?.get("flow_data[type]"), "payment_method_update");
  is("back to the store after the card", portalSessions[0]?.get("flow_data[after_completion][type]"), "redirect");
  listFails = true;
  portalSessions.length = 0;
  await link();
  is("unknown list: held to the card too", [(await openPortal(store, token, "https://marktmorgen.com")).ok, portalSessions[0]?.get("flow_data[type]")], [true, "payment_method_update"]);
  listFails = false;

  part("Control: without a fixed end, Stripe's own pages as before");
  sub = { ...fresh(), metadata: { store: "club", product: made.product.id } };
  await link();
  portalSessions.length = 0;
  is("Cancel shown", (await membershipsFor(store, token))?.[0]?.endsAt, null);
  is("Stripe's cancellation page opened", [(await openCancel(store, token, "sub_Fixed00000001", "https://marktmorgen.com")).ok, portalSessions[0]?.get("flow_data[type]")], [true, "subscription_cancel"]);
  await link();
  portalSessions.length = 0;
  is("the whole portal for Change card", [(await openPortal(store, token, "https://marktmorgen.com")).ok, portalSessions[0]?.get("flow_data[type]")], [true, null]);
  done();
}

void main();
