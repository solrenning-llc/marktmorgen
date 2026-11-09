/**
 * The pre-review of claude5/affiliate-pending-link @ 5ef27a497d (owner's decision 6), its proofs P1-P5 kept as
 * checks, with the findings it raised besides:
 *
 *   ALTO 1   the notice told the creator to "write the payment down in your studio", but a payout written down is
 *            taken off what the affiliate earns next (owed = earned - paid out): the advice must be the truth;
 *   MÉDIO 2  a confirmed sale keeps the share it was made at (components/affiliate-studio.tsx: "A sale keeps the
 *            share it was made at"), not the program's share at the confirmation;
 *   MÉDIO 3  the deadline runs from when the order is first seen paid, and the link is read at least once first;
 *   MÉDIO 4  pending orders are decided, or told about, even when the program was switched off since;
 *   MÉDIO 5  an offer taken after paying on a pending order is credited once the order is;
 *   MÉDIO 6  a membership confirmed later carries the affiliate on its subscription, so its renewals earn;
 *   MÉDIO 7  a booking's lead is marked done only when recordLead wrote it;
 *   LEVE 8   on a PayPal order the pending mark never pushes the visit's tags out of the twenty kept keys.
 *
 * Proof P3 asserted that a payout written down by hand for the pending sale does not eat the next commission; the
 * book's arithmetic (owed = earned - paid out) is the program's and is not changed here, so P3 is held instead by the
 * notice no longer giving that advice and saying what a payout written down does (rule 23). P5 grepped lib/upsell.ts,
 * which five open PRs touch; the offer is credited through noteCharge, which upsell.ts calls, so P5 is held by the
 * behavior (rule 23).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import {
  PENDING_LINK_SECONDS,
  VIA_PENDING_META,
  attributionOrPending,
  creditPayPalSale,
  noteCharge,
  notePayPalPendings,
  notePendingLinks,
  pendingChannel,
  pendingNotice,
} from "@/lib/affiliates";
import { viaCookieValue } from "@/lib/affiliate-setting";
import type { SendOutcome } from "@/lib/email";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_prerev_pending";
process.env.RESEND_API_KEY = "re_test_prerev_pending";

const OWNER = "baker@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";

// Stripe, as the creator's account answers: the customer's payments, and a subscription changed.
const offers: Record<string, unknown>[] = [];
const subscriptionPosts: { url: string; body: string }[] = [];
let subscriptionAnswer: "ok" | "error" = "ok";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/payment_intents" && (init?.method ?? "GET") === "GET") {
    return json({ object: "list", data: offers.filter((pi) => pi.customer === url.searchParams.get("customer")), has_more: false });
  }
  if (url.hostname === "api.stripe.com" && url.pathname.startsWith("/v1/subscriptions/") && init?.method === "POST") {
    const body = String(init.body ?? "");
    subscriptionPosts.push({ url: url.pathname, body });
    if (subscriptionAnswer === "error") return json({ error: { message: "synthetic" } }, 500);
    const params = new URLSearchParams(body);
    const metadata: Record<string, string> = {};
    for (const [key, value] of params) {
      const m = key.match(/^metadata\[(.+)\]$/);
      if (m) metadata[m[1]] = value;
    }
    return json({ id: url.pathname.split("/").pop(), object: "subscription", metadata });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

let sends = 0;
const send = async (): Promise<SendOutcome> => {
  sends += 1;
  return "sent";
};
const person = (id: string, email: string, code: string) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" });
const order = (id: string, email: string, meta: Record<string, string>, created: number, over: Record<string, unknown> = {}) => ({
  id, mode: "payment", status: "complete", payment_status: "paid", created, amount_total: 5_000, amount_subtotal: 5_000, currency: "usd",
  total_details: { amount_tax: 0 }, payment_intent: `pi_${id}`,
  metadata: { store: "oven", product: "prod01", title: "Sourdough course", ...meta } as Record<string, string>,
  customer_details: { email },
  ...over,
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "oven", "Oven Notes", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPrerevPend01", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, days: 30 }));
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")], ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA]]);
  const sale = async (ref: string) => {
    const [raw] = await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, ref]]);
    return typeof raw === "string" ? (JSON.parse(raw) as { rate: number; aff: string; how: string; base: number }) : null;
  };
  const mark = async (ref: string) => (await redis.pipeline([["GET", `nl:aff:pend:${statsId}:${ref}`]]))[0];
  const codes = `nl:aff:${statsId}:codes`;
  const real = redis.pipeline.bind(redis);
  const breakCodes = () => real([["HSET", codes, "ana", JSON.stringify({ not: "an id" })]]);
  const mendCodes = () => real([["HSET", codes, "ana", ANA]]);
  // The mark a checkout carries, made by the real code at the share the program holds at the time of the sale.
  const pendingAt = async (products: string[] = ["prod01"]) => {
    await breakCodes();
    const credit = await attributionOrPending(store, products[0], { via: viaCookieValue(undefined, "ana", NOW - 600), session: undefined }, products);
    await mendCodes();
    return pendingChannel(credit)[VIA_PENDING_META] ?? "";
  };

  part("P1 / MÉDIO 2: the share credited is the one at the time of the sale");
  const at30 = await pendingAt();
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, percent: 10 }));
  store = (await storeForEmail(OWNER))!;
  await notePendingLinks(store, [order("cs_rate1", "jo@example.com", { [VIA_PENDING_META]: at30 }, NOW - 300)], NOW, undefined, undefined, send);
  is("a cut made after the sale does not reach back into it", (await sale("cs_rate1"))?.rate, 30);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, percent: 50 }));
  store = (await storeForEmail(OWNER))!;
  await notePendingLinks(store, [order("cs_rate2", "jo2@example.com", { [VIA_PENDING_META]: at30 }, NOW - 300)], NOW, undefined, undefined, send);
  is("a raise made after the sale does not either: the creator never pays more than the sale's share", (await sale("cs_rate2"))?.rate, 30);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, percent: 30 }));
  store = (await storeForEmail(OWNER))!;

  part("P2 / MÉDIO 3: paid more than PENDING_LINK_SECONDS after the checkout opened");
  sends = 0;
  // Written as the checkout writes it, with the shares of the sale (no renewals, 30% on prod01).
  const pend = `ana.${NOW - 600}~ana.${NOW - 600}~-~0;prod01=30`;
  // The click came before the checkout opened, as it always does (the proof's fixture had it after, which no window credits).
  const before = `ana.${NOW - 4 * 3_600}~ana.${NOW - 4 * 3_600}~-~0;prod01=30`;
  const lateOpen = order("cs_late", "late@example.com", { [VIA_PENDING_META]: before }, NOW - 3 * 3_600);
  const counts = await notePendingLinks(store, [lateOpen], NOW, undefined, undefined, send);
  is("read at least once after it is seen paid, and credited", [counts.credited, (await sale("cs_late"))?.aff ?? null, sends], [1, ANA, 0]);
  await breakCodes();
  const lateUnknown = order("cs_late2", "late2@example.com", { [VIA_PENDING_META]: before }, NOW - 3 * 3_600);
  await notePendingLinks(store, [lateUnknown], NOW, undefined, undefined, send);
  is("still unknown at its first sight: not told yet, read again", [sends, typeof (await mark("cs_late2")) === "string" && String(await mark("cs_late2")).startsWith("seen:")], [0, true]);
  await notePendingLinks(store, [lateUnknown], NOW + 300, undefined, undefined, send);
  is("the deadline runs from the first sight, not from the checkout's opening", sends, 0);
  await notePendingLinks(store, [lateUnknown], NOW + PENDING_LINK_SECONDS + 60, undefined, undefined, send);
  is("past the deadline from the first sight: told", [sends, await mark("cs_late2")], [1, "told"]);
  await mendCodes();

  part("P3 / ALTO 1: the notice's advice is the truth");
  const notice = pendingNotice(store, "cs_x", pend, "unread");
  is("it no longer says to write the payment down in the studio", /write the payment down/i.test(notice.text), false);
  is("it says a payout written down in the studio is taken off what they earn next", /payout[^.]*studio[^.]*taken off what they earn next/i.test(notice.text), true);

  part("P4 / MÉDIO 4: the program switched off inside the window");
  sends = 0;
  const pp = { store: "oven", order: "PPORDERPREREV1", capture: "CAPPREREV1", email: "pp@example.com", product: "prod01", cents: 4_000, currency: "USD", at: NOW - 60, handle: "oven", meta: { [VIA_PENDING_META]: pend } };
  await real([["SET", `nl:ppsell:paid:${pp.order}`, JSON.stringify(pp)]]);
  await breakCodes();
  await creditPayPalSale(store, pp, "Sourdough course", send);
  await mendCodes();
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, enabled: false }));
  store = (await storeForEmail(OWNER))!;
  const off = { ...store, paypalSeller: { merchant: "SYNTHETICMERCH1", at: NOW } } as typeof store;
  await breakCodes();
  await notePayPalPendings(off, NOW + 3 * 3_600, send);
  await mendCodes();
  is("past the deadline the creator is told though the program was switched off since", [sends, await mark(`paypal:${pp.order}`)], [1, "told"]);
  const offSale = order("cs_off", "off@example.com", { [VIA_PENDING_META]: pend }, NOW - 300);
  await notePendingLinks(store, [offSale], NOW, undefined, undefined, send);
  is("a Stripe order made while it was on is still credited at its share", (await sale("cs_off"))?.rate, 30);
  const sweep = readFileSync(join(process.cwd(), "lib/checkout-sweep.ts"), "utf8");
  const gate = sweep.indexOf("if (affiliatesOn(store) && paid.length)");
  const call = sweep.indexOf("notePendingLinks(store");
  is("the sweep reaches notePendingLinks outside the program's gate", gate !== -1 && call > gate && call < sweep.indexOf("noteFirstSale(store", gate), false);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, enabled: true }));
  store = (await storeForEmail(OWNER))!;

  part("P5 / MÉDIO 5: offers taken after paying on a pending order");
  const offer = (id: string, parent: string, customer: string) => ({
    id, object: "payment_intent", status: "succeeded", amount: 2_000, currency: "usd", created: NOW - 200, receipt_email: "of@example.com", customer,
    metadata: { store: "oven", product: "prod02", title: "Starter kit", kind: "upsell", parent },
  });
  offers.push(offer("pi_offer_before", "cs_offer1", "cus_offer1"));
  await notePendingLinks(store, [order("cs_offer1", "of@example.com", { [VIA_PENDING_META]: pend }, NOW - 300, { customer: "cus_offer1" })], NOW, undefined, undefined, send);
  is("an offer paid before the order was confirmed is credited with it", [(await sale("pi_offer_before"))?.aff, (await sale("pi_offer_before"))?.rate], [ANA, 30]);
  await noteCharge(store, offer("pi_offer_after", "cs_offer1", "cus_offer1"));
  is("one paid after it is credited when it is noted", (await sale("pi_offer_after"))?.aff, ANA);
  await noteCharge(store, offer("pi_offer_none", "cs_nobody", "cus_offer2"));
  is("an offer on an order nobody brought stays nobody's", await sale("pi_offer_none"), null);
  const unkept = order("cs_unkept", "uk@example.com", { [VIA_PENDING_META]: `ana.${NOW - 600}~ana.${NOW - 600}~-~0` }, NOW - 300);
  await notePendingLinks(store, [unkept], NOW, undefined, undefined, send);
  is("a sale whose share at the sale was not kept is never credited at today's share", await sale("cs_unkept"), null);

  part("MÉDIO 6: a membership confirmed later carries the affiliate on its subscription");
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, recurring: 12 }));
  store = (await storeForEmail(OWNER))!;
  const memberPend = await pendingAt();
  const member = order("cs_sub1", "sub@example.com", { [VIA_PENDING_META]: memberPend }, NOW - 300, { mode: "subscription", subscription: "sub_1Pending01", invoice: "in_1Pending01" });
  subscriptionPosts.length = 0;
  sends = 0;
  await notePendingLinks(store, [member], NOW, undefined, undefined, send);
  const posted = new URLSearchParams(subscriptionPosts[0]?.body ?? "");
  is("its subscription is told the affiliate, the share, the months and when it was sold", [subscriptionPosts[0]?.url, posted.get("metadata[via]"), posted.get("metadata[via_rate]"), posted.get("metadata[via_months]"), posted.get("metadata[via_at]")], ["/v1/subscriptions/sub_1Pending01", ANA, "30", "12", String(NOW - 300)]);
  is("its first payment, already made, is credited as a renewal of it", [(await sale("in_1Pending01"))?.aff, (await sale("in_1Pending01"))?.how], [ANA, "recurring"]);
  is("and the creator is not told anything", [sends, String(await mark("cs_sub1")).startsWith("credited")], [0, true]);
  is("no notice says renewals cannot be credited", /cannot be credited/.test(readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8")), false);
  subscriptionAnswer = "error";
  const failing = order("cs_sub2", "sub2@example.com", { [VIA_PENDING_META]: memberPend }, NOW - 300, { mode: "subscription", subscription: "sub_1Pending02", invoice: "in_1Pending02" });
  await notePendingLinks(store, [failing], NOW, undefined, undefined, send);
  is("a subscription Stripe did not take: nothing credited, read again", [await sale("in_1Pending02"), String(await mark("cs_sub2")).startsWith("seen:")], [null, true]);
  await notePendingLinks(store, [failing], NOW + PENDING_LINK_SECONDS + 60, undefined, undefined, send);
  is("past the deadline the creator is told, honestly", [sends, await mark("cs_sub2")], [1, "told"]);
  subscriptionAnswer = "ok";

  part("MÉDIO 7: a booking's lead is done only when it was written");
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, lead: { kind: "booking", cents: 500, hold: 30, daily: 10, budget: 50_000 } }));
  store = (await storeForEmail(OWNER))!;
  const callEnd = (NOW + 86_400) * 1000;
  const booking = order("cs_call1", "caller@example.com", { [VIA_PENDING_META]: pend, kind: "call", start: String(callEnd - 1_800_000), end: String(callEnd) }, NOW - 300);
  // The program's lead count does not read: recordLead answers "unavailable", never "recorded".
  const realPipeline = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => String(c[1] ?? "").includes(":leads"))) throw new Error("the leads do not read");
    return realPipeline.call(redis, commands);
  }) as typeof redis.pipeline;
  await notePendingLinks(store, [booking], NOW, undefined, undefined, send);
  redis.pipeline = realPipeline;
  is("a lead not written leaves the order to be tried again, never marked done", String(await mark("cs_call1")).startsWith("lead:"), true);
  await notePendingLinks(store, [booking], NOW + 300, undefined, undefined, send);
  const [leads] = await real([["HGETALL", `nl:aff:${statsId}:leads`]]);
  is("written at the next pass, and only then done", [JSON.stringify(leads ?? []).includes("cs_call1"), String(await mark("cs_call1")).startsWith("credited")], [true, true]);

  part("LEVE 8: PayPal keeps the visit's tags");
  const route = readFileSync(join(process.cwd(), "app/api/store/paypal/checkout/route.ts"), "utf8");
  const metaStart = route.indexOf("const meta = {");
  const metaBlock = route.slice(metaStart, route.indexOf("\n  };", metaStart));
  is("the pending mark comes after the channel and the tags", metaBlock.indexOf("pendingChannel(") > metaBlock.indexOf("utm_campaign"), true);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
