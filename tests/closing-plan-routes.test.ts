/**
 * The plan's routes run as a creator would reach them, for a store whose plan
 * has ended and that closes (queue item 307 [EC1]), against a stand-in for
 * our own Stripe account and the email sender. Only the sign-in, the sale
 * flag and the funding grant are stood in for (tests/test-config.mjs);
 * everything the routes decide is the real code. Nothing real is reached.
 *
 * What fails here:
 *   - the way back from a checkout finished on the closing day writing the
 *     plan down, or not ending and refunding it;
 *   - a plan checkout in the closing period that lasts longer than the
 *     shortest time Stripe allows;
 *   - a plan checkout opened after the last moment, or refused before it;
 *   - a store that does not close being given the short checkout.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { signedIn } from "./closing-route-studio";
import { GET as back } from "@/app/api/billing/return/route";
import { POST as checkout } from "@/app/api/billing/checkout/route";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { CLOSING_CHECKOUT_SECONDS, lastPlanMoment, markShut } from "@/lib/closing-plan-guard";
import { closingOf } from "@/lib/plan-closing";
import { redisPipeline } from "@/lib/redis";

const S = (ms: number) => Math.floor(ms / 1000);

const world = {
  subs: new Map<string, Record<string, unknown>>(),
  invoices: [] as Record<string, unknown>[],
  refunds: [] as Record<string, unknown>[],
  sessions: new Map<string, Record<string, unknown>>(),
  opened: [] as URLSearchParams[],
};
const sent: { to: string; subject: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string };
    sent.push({ to: [body.to].flat()[0], subject: body.subject });
    return json({ id: `email_${sent.length}` });
  }
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  const form = new URLSearchParams(String(init?.body ?? ""));
  if (path === "/checkout/sessions" && method === "POST") {
    world.opened.push(form);
    return json({ id: `cs_test_opened${String(world.opened.length).padStart(6, "0")}`, url: "https://checkout.stripe.test/session" });
  }
  const session = path.match(/^\/checkout\/sessions\/(cs_\w+)$/);
  if (session) return world.sessions.has(session[1]) ? json(world.sessions.get(session[1])) : json({ error: { message: "No such checkout session" } }, 404);
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = world.subs.get(sub[1]);
    if (!row) return json({ error: { message: "No such subscription" } }, 404);
    if (method === "DELETE") row.status = "canceled";
    return json(row);
  }
  // No price kept at Stripe yet: the checkout writes the amount out (lib/billing.ts, writeInline).
  if (path === "/prices" && method === "GET") return json({ object: "list", data: [], has_more: false });
  if (path === "/products" || path === "/products/search" || path === "/prices") return json({ error: { message: "not in this stand-in" } }, 400);
  if (path === "/subscriptions" && method === "GET") return json({ object: "list", data: [], has_more: false });
  if (path === "/subscriptions/search") return json({ object: "search_result", data: [], has_more: false, next_page: null });
  if (path === "/invoices" && method === "GET") return json({ object: "list", data: world.invoices.filter((row) => row.subscription === url.searchParams.get("subscription")), has_more: false });
  const intent = path.match(/^\/payment_intents\/(pi_\w+)$/);
  if (intent) return json({ id: intent[1], latest_charge: { id: `ch_${intent[1].slice(3)}`, payment_intent: intent[1], currency: "usd", amount: 6_900, amount_refunded: 0, disputed: false } });
  if (path === "/refunds" && method === "GET") return json({ object: "list", data: world.refunds.filter((row) => row.charge === url.searchParams.get("charge")), has_more: false });
  if (path === "/refunds" && method === "POST") {
    const refund = { id: `re_${String(world.refunds.length + 1).padStart(8, "0")}`, object: "refund", charge: `ch_${String(form.get("payment_intent")).slice(3)}`, payment_intent: form.get("payment_intent"), amount: Number(form.get("amount")), status: "succeeded", currency: "usd" };
    world.refunds.push(refund);
    return json(refund);
  }
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const billingOf = (response: Response) => new URL(response.headers.get("Location") ?? "https://x.test/").searchParams.get("billing");
const plan = (cycle = "month") => new NextRequest("https://marktmorgen.test/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://marktmorgen.test" }, body: new URLSearchParams({ tier: "creator", cycle }) });

/** A store whose plan ended an hour ago and that closes, its last notice sent and its buyers told, so its closing day is fixed. */
async function ended(handle: string) {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle[0].toUpperCase()}${handle.slice(1)} Shop`, "");
  await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId: `sub_${handle}old001`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  const store = (await storeForEmail(email))!;
  const endedAt = Date.parse(store.planEndedAt);
  await redisPipeline([["SET", `nl:plan:closing:${createHash("sha256").update(storeRef(store)).digest("hex").slice(0, 40)}`, JSON.stringify({ of: endedAt, week: endedAt, buyersDone: endedAt })]]);
  return { email, store, endedAt };
}

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const realNow = Date.now.bind(Date);

  part("The way back from a plan checkout finished on the closing day");
  const ana = await ended("ana");
  const day = realNow();
  // In its closing day; its last plan ended a month before (the line's score is that end).
  await redisPipeline([["ZADD", FINAL_INDEX, day - 30 * 86_400_000, storeRef(ana.store)]]);
  await markShut(ana.store, day);
  world.subs.set("sub_analate001", { id: "sub_analate001", status: "active", customer: "cus_ana0001", metadata: { store: "ana" }, created: S(day) - 600, items: { data: [] } });
  world.invoices.push({ id: "in_analate001", subscription: "sub_analate001", status: "paid", amount_paid: 6_900, payment_intent: "pi_analate001", created: S(day) - 600, status_transitions: { paid_at: S(day) + 60 } });
  world.sessions.set("cs_test_analate0001", { id: "cs_test_analate0001", mode: "subscription", status: "complete", customer: "cus_ana0001", subscription: "sub_analate001", metadata: { store: "ana" } });
  signedIn.email = ana.email;
  const returned = await back(new NextRequest("https://marktmorgen.test/api/billing/return?session_id=cs_test_analate0001"));
  is("the creator is sent back to say the payment was returned", billingOf(returned), "closing-returned");
  is("the plan is ended and refunded in full at Stripe, and never written down as the store's", [world.subs.get("sub_analate001")?.status, world.refunds.map((row) => row.amount), (await storeForEmail(ana.email))?.subscriptionActive], ["canceled", [6_900], false]);
  is("and the creator is emailed once", sent.filter((m) => m.to === ana.email).length, 1);
  is("pressing back again changes nothing", [billingOf(await back(new NextRequest("https://marktmorgen.test/api/billing/return?session_id=cs_test_analate0001"))), world.refunds.length, sent.filter((m) => m.to === ana.email).length], ["closing-returned", 1, 1]);
  is("a new plan checkout on that day is refused, and Stripe is not asked", [billingOf(await checkout(plan())), world.opened.length], ["closing", 0]);
  world.subs.set("sub_anaearly01", { id: "sub_anaearly01", status: "active", customer: "cus_ana0001", metadata: { store: "ana" }, created: S(day) - 600, items: { data: [] } });
  world.invoices.push({ id: "in_anaearly01", subscription: "sub_anaearly01", status: "paid", amount_paid: 6_900, payment_intent: "pi_anaearly01", created: S(day) - 600, status_transitions: { paid_at: S(day) - 300 } });
  world.sessions.set("cs_test_anaearly001", { id: "cs_test_anaearly001", mode: "subscription", status: "complete", customer: "cus_ana0001", subscription: "sub_anaearly01", metadata: { store: "ana" } });
  is("one paid just before the day began, coming back after: refunded, and told it came too late to stop the closing", [billingOf(await back(new NextRequest("https://marktmorgen.test/api/billing/return?session_id=cs_test_anaearly001"))), world.refunds.filter((row) => row.payment_intent === "pi_anaearly01").length], ["closing-returned-early", 1]);
  const studioPage = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
  const notice = (key: string) => studioPage.slice(studioPage.indexOf(`"${key}": {`), studioPage.indexOf("},", studioPage.indexOf(`"${key}": {`)));
  is("the studio says each truthfully", [notice("closing-returned").includes("paid for after your store's closing day began"), notice("closing-returned-early").includes("too late to stop"), notice("closing-returned-early").includes("after your store's closing day began")], [true, true, false]);

  part("In the closing period, a plan checkout lasts the shortest time Stripe allows");
  const ben = await ended("ben");
  signedIn.email = ben.email;
  const benDay = (await closingOf(ben.store))!.day;
  const opened = await checkout(plan());
  const expiresAt = Number(world.opened.at(-1)?.get("expires_at"));
  const at = S(realNow());
  is("it is opened, and expires in 31 minutes, not the funding grant's hour", [opened.headers.get("Location"), expiresAt >= at + CLOSING_CHECKOUT_SECONDS - 2 && expiresAt <= at + CLOSING_CHECKOUT_SECONDS], ["https://checkout.stripe.test/session", true]);
  is("31 minutes is Stripe's minimum of 30, and a minute for clocks", CLOSING_CHECKOUT_SECONDS, 31 * 60);

  part("From the last moment, no plan checkout is opened");
  const last = lastPlanMoment(benDay);
  is("the last moment is 32 minutes before the closing day begins", benDay - last, 32 * 60_000);
  Date.now = () => last - 1_000;
  const justBefore = await checkout(plan());
  const beforeExpiry = Number(world.opened.at(-1)?.get("expires_at"));
  is("a second before it, it opens, and expires before the day begins", [justBefore.headers.get("Location"), beforeExpiry * 1000 < benDay], ["https://checkout.stripe.test/session", true]);
  const count = world.opened.length;
  Date.now = () => last;
  is("at the last moment, it is refused with the reason, and Stripe is not asked", [billingOf(await checkout(plan())), world.opened.length], ["closing-late", count]);
  Date.now = () => benDay - 60_000;
  is("and so a minute before the day", [billingOf(await checkout(plan("year"))), world.opened.length], ["closing-late", count]);
  Date.now = realNow;

  part("A store whose plan has not ended is not touched");
  await claimHandle("cleo@example.com", "cleo", "Cleo Shop", "");
  signedIn.email = "cleo@example.com";
  const refundsBefore = world.refunds.length;
  await checkout(plan());
  is("its checkout keeps the funding grant's hour", Number(world.opened.at(-1)?.get("expires_at")) >= S(realNow()) + 3_500, true);
  is("nothing refunded or written for it", [world.refunds.length - refundsBefore, sent.filter((m) => m.to === "cleo@example.com").length], [0, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
