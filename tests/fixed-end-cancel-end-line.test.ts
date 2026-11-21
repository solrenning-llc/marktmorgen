/**
 * After a Cancel whose answer was lost (Claude 3's M1 on #3488, confirmed by Codex U): the "unsure" notice tells
 * the member how to tell from the page whether the cancellation went through, and the page must not show a
 * membership that is still running on to its sold end the way it shows a cancelled one. Before, both read
 * "Ends <date>", and the notice said "if it shows the day it ends, it is canceled": a member whose cancel did not
 * land was told it had, and the remaining payments were charged.
 *
 * Now a cancelled membership reads "Canceled. Ends <date>", the end that was sold reads "Ends <date>, after the
 * last payment", and the notice points at "Canceled", in every language.
 */
import { finishPlan } from "@/lib/plans";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as manage from "@/lib/membership-manage";
import { membershipsFor, openCancel } from "@/lib/membership-manage";
import { MEMBERSHIP_WORDS, type MembershipWords } from "@/lib/buyer-words/membership";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
const TRIAL_END = NOW + 6 * 86_400;
const SESSION = "cs_test_" + "f".repeat(24);
let sub: Record<string, unknown> = {};
const portalSessions: URLSearchParams[] = [];
const updates: URLSearchParams[] = [];
let updateFails: "none" | "refused" | "down" | "other-end" = "none";
let otherId = false;

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
    if (otherId) return json({ ...sub, id: "sub_Other00000001" });
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

  type Line = (m: MembershipWords, one: manage.Membership, date: (at: number) => string) => string | null;
  const endLine = (manage as unknown as { endLine?: Line }).endLine;
  const line = (one: manage.Membership | undefined) => (typeof endLine === "function" && one ? endLine(MEMBERSHIP_WORDS.en, one, (at) => `day ${at}`) : "no endLine");
  const mark = (MEMBERSHIP_WORDS.en as unknown as { canceledMark?: string }).canceledMark ?? "(no canceledMark)";

  part("The sold end, after finishPlan: payments still to come");
  is("finishPlan done", await finishPlan("acct_1TestClub000001", SESSION), "done");
  const sold = sub.cancel_at as number;
  let one = (await membershipsFor(store, token))?.[0];
  is("the line says the end that was sold, after the last payment", line(one), `Ends day ${sold}, after the last payment`);

  part("Cancel, Stripe's answer lost, the update not applied: the page must not read as canceled");
  updateFails = "down";
  is("unsure", await openCancel(store, token, "sub_Fixed00000001", "https://marktmorgen.com"), { ok: false, reason: "unsure" });
  updateFails = "none";
  is("the update did not land", sub.cancel_at, sold);
  one = (await membershipsFor(store, token))?.[0];
  const shown = line(one) ?? "";
  is("the unsure notice names the word a canceled membership shows", MEMBERSHIP_WORDS.en.manageNotices.unsure.body.includes(`“${mark}”`), true);
  is("and the line of this membership, not canceled, does not show it", shown.includes(mark) || shown === "no endLine", false);

  part("Cancel that went through: the page says Canceled");
  await link();
  is("accepted", (await openCancel(store, token, "sub_Fixed00000001", "https://marktmorgen.com")).ok, true);
  one = (await membershipsFor(store, token))?.[0];
  is("the line says Canceled and the day it ends", line(one), `Canceled. Ends day ${TRIAL_END}`);

  part("The last period of a fixed end: not canceled, nothing left to cancel");
  sub = { ...fresh(), status: "active", cancel_at: sold, items: { data: [{ current_period_end: sold, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] } };
  await link();
  one = (await membershipsFor(store, token))?.[0];
  is("the line says the end after the last payment, not Canceled", line(one), `Ends day ${sold}, after the last payment`);

  part("An ordinary membership canceled on Stripe's page reads Canceled");
  sub = { ...fresh(), status: "active", metadata: { store: "club", product: made.product.id }, cancel_at_period_end: true, items: { data: [{ current_period_end: TRIAL_END + 9, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] } };
  await link();
  one = (await membershipsFor(store, token))?.[0];
  is("Canceled. Ends …", line(one), `Canceled. Ends day ${TRIAL_END + 9}`);

  part("Claude 3's L2: an answer for another subscription with the same end is not taken as done");
  sub = { ...fresh(), cancel_at: sold };
  await link();
  otherId = true;
  is("unsure", await openCancel(store, token, "sub_Fixed00000001", "https://marktmorgen.com"), { ok: false, reason: "unsure" });
  otherId = false;

  part("Every language: the notice points at the word only a canceled membership shows");
  for (const [lang, words] of Object.entries(MEMBERSHIP_WORDS)) {
    const w = words as MembershipWords & { canceledMark?: string; endsCanceled?: (d: string) => string; endsAfterLast?: (d: string) => string };
    const ok =
      typeof w.canceledMark === "string" && w.canceledMark.length > 0 &&
      typeof w.endsCanceled === "function" && typeof w.endsAfterLast === "function" &&
      w.manageNotices.unsure.body.includes(w.canceledMark) &&
      w.endsCanceled("May 1").includes(w.canceledMark) && w.endsCanceled("May 1").includes("May 1") &&
      !w.endsAfterLast("May 1").includes(w.canceledMark) && w.endsAfterLast("May 1").includes("May 1");
    is(`${lang}: canceledMark in the notice and the canceled line, never in the sold end's`, ok, true);
  }

  part("The manage page draws the line from endLine");
  is("page uses endLine", readFileSync("app/[handle]/manage/page.tsx", "utf8").includes("endLine(m, one, endDate)"), true);

  done();
}

void main();
