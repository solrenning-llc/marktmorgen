/**
 * The third pre-review of claude5/affiliate-pending-link @ 36e645c0fd (owner's decision 6), its proofs Q1-Q5 kept as
 * checks: a membership at its deadline when the pass's time is spent waits instead of being told Stripe did not
 * answer (MÉDIO 1); a first invoice that never names a payment ends in a notice, and nothing leaves the company's
 * list undecided and untold (MÉDIO 2); a refused notice is tried once a run, never twice through the list and the
 * listing (LEVE 3); the notice never says an own share changed when its date is not known (LEVE 4); a product taken
 * out of the program earns nothing, so it is never told about (LEVE 5).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_AFFILIATES, parseAffiliateSetting, viaCookieValue } from "@/lib/affiliate-setting";
import {
  PENDING_LINK_SECONDS,
  PENDING_SWEEP_SECONDS,
  PENDING_TELL_MARGIN,
  VIA_PENDING_META,
  attributionOrPending,
  creditPayPalSale,
  noteCharge,
  notePendingDue,
  notePendingLinks,
  pendingChannel,
  pendingNotice,
  readBook,
  setAffiliateRate,
} from "@/lib/affiliates";
import type { SendOutcome } from "@/lib/email";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_prerev2_pending";
process.env.RESEND_API_KEY = "re_test_prerev2_pending";

const OWNER = "baker@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";

// A small Stripe: subscriptions keep what a POST put on them; invoices, refunds, offers and sessions as set.
const subs = new Map<string, Record<string, string>>();
// Typed wide so the branch kept from the second review type-checks (the proof had it narrowed to "ok").
const postMode = "ok" as "ok" | "lost-then-down";
const getSubDown = false;
let posts = 0;
let calls = 0;
const invoicesById = new Map<string, Record<string, unknown>>();
const invoiceList: Record<string, unknown>[] = [];
const refunds: Record<string, unknown>[] = [];
const offers: Record<string, unknown>[] = [];
const sessions = new Map<string, Record<string, unknown>>();
const applyPost = (id: string, body: string) => {
  const metadata: Record<string, string> = { ...(subs.get(id) ?? {}) };
  for (const [k, v] of new URLSearchParams(body)) {
    const m = k.match(/^metadata\[(.+)\]$/);
    if (m) metadata[m[1]] = v;
  }
  subs.set(id, metadata);
  return metadata;
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const list = (data: unknown[], more = false) => json({ object: "list", data, has_more: more });
  if (url.hostname === "api.stripe.com") calls += 1;
  const method = init?.method ?? "GET";
  if (url.pathname.startsWith("/v1/subscriptions/")) {
    const id = url.pathname.split("/").pop() as string;
    if (method === "POST") {
      posts += 1;
      if (postMode === "lost-then-down") {
        if (posts === 1) {
          applyPost(id, String(init?.body ?? ""));
          throw new TypeError("fetch failed (synthetic: reply lost)");
        }
        return json({ error: { message: "synthetic outage" } }, 503);
      }
      return json({ id, object: "subscription", metadata: applyPost(id, String(init?.body ?? "")) });
    }
    if (getSubDown) return json({ error: { message: "synthetic outage" } }, 503);
    return json({ id, object: "subscription", metadata: subs.get(id) ?? {} });
  }
  if (url.pathname.startsWith("/v1/invoices/")) {
    const found = invoicesById.get(url.pathname.split("/").pop() as string);
    return found ? json(found) : json({ error: { message: "synthetic: no such invoice" } }, 503);
  }
  if (url.pathname === "/v1/invoices") return list(invoiceList);
  if (url.pathname === "/v1/refunds") return list(refunds);
  if (url.pathname.startsWith("/v1/checkout/sessions/")) {
    const found = sessions.get(url.pathname.split("/").pop() as string);
    return found ? json(found) : json({ error: { message: "synthetic: no such session" } }, 404);
  }
  if (url.pathname === "/v1/payment_intents") {
    const mine = offers.filter((pi) => pi.customer === url.searchParams.get("customer"));
    const after = url.searchParams.get("starting_after");
    const from = after ? mine.findIndex((pi) => pi.id === after) + 1 : 0;
    const limit = Number(url.searchParams.get("limit") ?? "100");
    return list(mine.slice(from, from + limit), from + limit < mine.length);
  }
  return list([]);
}) as typeof fetch;

let sends = 0;
const texts: string[] = [];
const send = async (message: { subject: string; text: string }): Promise<SendOutcome> => {
  sends += 1;
  texts.push(`${message.subject}\n${message.text}`);
  return "sent";
};
const person = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "", rate: null, ...over });
const order = (id: string, email: string, meta: Record<string, string>, created: number, over: Record<string, unknown> = {}) => ({
  id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", created, amount_total: 5_000, amount_subtotal: 5_000, currency: "usd",
  total_details: { amount_tax: 0 }, payment_intent: `pi_${id}`,
  metadata: { store: "oven", product: "prod01", title: "Sourdough course", ...meta } as Record<string, string>,
  customer_details: { email },
  ...over,
});
const paidInvoice = (id: string, pi: string) => ({ id, object: "invoice", status: "paid", payments: { object: "list", has_more: false, data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: pi } }] } });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "oven", "Oven Notes", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPrerev2Pend", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, days: 30, recurring: 12 }));
  let store = (await storeForEmail(OWNER))!;
  if (!store.sid) await ensureStoreId(storeRef(store));
  store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const codes = `nl:aff:${statsId}:codes`;
  const people = `nl:aff:${statsId}:people`;
  await redis.pipeline([["HSET", people, ANA, person()], ["HSET", codes, "ana", ANA]]);
  const sale = async (ref: string) => {
    const [raw] = await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, ref]]);
    return typeof raw === "string" ? (JSON.parse(raw) as { rate: number; aff: string; pi: string }) : null;
  };
  const markKey = (ref: string) => `nl:aff:pend:${statsId}:${ref}`;
  const mark = async (ref: string) => (await redis.pipeline([["GET", markKey(ref)]]))[0];
  const breakCodes = () => redis.pipeline([["HSET", codes, "ana", JSON.stringify({ not: "an id" })]]);
  const mendCodes = () => redis.pipeline([["HSET", codes, "ana", ANA]]);
  const pendingAt = async () => {
    await breakCodes();
    const credit = await attributionOrPending(store, "prod01", { via: viaCookieValue(undefined, "ana", NOW - 600), session: undefined }, ["prod01"]);
    await mendCodes();
    return pendingChannel(credit)[VIA_PENDING_META] ?? "";
  };
  const memberPend = await pendingAt();
  void PENDING_SWEEP_SECONDS; void PENDING_TELL_MARGIN; void creditPayPalSale; void noteCharge; void pendingNotice; void readBook; void setAffiliateRate; void readFileSync; void join;

  part("Q1 (MÉDIO): a membership at its deadline when the pass's time is spent (Stripe never asked)");
  sends = 0; texts.length = 0; calls = 0;
  const createdQ1 = NOW - PENDING_LINK_SECONDS - 400;
  subs.set("sub_1PrerevQ101", { store: "oven", product: "prod01", via: ANA, via_rate: "30", via_months: "12", via_at: String(createdQ1) });
  invoicesById.set("in_1PrerevQ101", paidInvoice("in_1PrerevQ101", "pi_firstQ1"));
  await redis.pipeline([["SET", markKey("cs_Q1"), `seen:${NOW - PENDING_LINK_SECONDS - 60}`]]);
  const q1 = order("cs_Q1", "q1@example.com", { [VIA_PENDING_META]: memberPend }, createdQ1, { mode: "subscription", payment_intent: null, subscription: "sub_1PrerevQ101", invoice: "in_1PrerevQ101" });
  await notePendingLinks(store, [q1], NOW, undefined, undefined, send, Date.now() - 1);
  is("no Stripe request was made (deadline spent)", calls, 0);
  is("so nobody is told 'Stripe did not answer' and the order waits (expected 0 sends, mark seen)", [sends, String(await mark("cs_Q1")).startsWith("seen:")], [0, true]);
  await notePendingLinks(store, [q1], NOW + 300, undefined, undefined, send);
  is("the next pass, with time, credits the first payment the subscription already carries (expected Ana)", (await sale("in_1PrerevQ101"))?.aff ?? null, ANA);
  if (texts[0]) console.log("    notice sent:", JSON.stringify(texts[0].slice(0, 260)));

  part("Q2 (MÉDIO/LEVE): a membership whose first invoice never names a payment");
  sends = 0;
  invoicesById.set("in_1PrerevQ201", { id: "in_1PrerevQ201", object: "invoice", status: "paid", payments: { object: "list", has_more: false, data: [] } });
  const createdQ2 = NOW - 300;
  const q2 = order("cs_Q2", "q2@example.com", { [VIA_PENDING_META]: memberPend }, createdQ2, { mode: "subscription", payment_intent: null, subscription: "sub_1PrerevQ201", invoice: "in_1PrerevQ201" });
  for (const t of [NOW, NOW + PENDING_LINK_SECONDS + 60, createdQ2 + PENDING_SWEEP_SECONDS - PENDING_TELL_MARGIN + 10, createdQ2 + PENDING_SWEEP_SECONDS - 60]) {
    await notePendingLinks(store, [q2], t, undefined, undefined, send);
  }
  is("the subscription carries Ana (its renewals will be credited)", subs.get("sub_1PrerevQ201")?.via, ANA);
  is("by the end of the checkout's day the creator was told something (expected >= 1 send)", sends >= 1, true);
  console.log("    mark at the end of the day:", await mark("cs_Q2"));
  await redis.pipeline([["DEL", markKey("cs_Q2")]]); // its two-day mark expires
  await notePendingDue(createdQ2 + 2 * 86_400 + 60, undefined, send);
  const [q2left] = await redis.pipeline([["ZSCORE", "nl:aff:pend:due", `${store.sid}|cs_Q2`]]);
  is("it left the company's list (expected gone)", q2left, null);
  is("having left without any notice (expected: told before leaving)", sends >= 1, true);

  part("Q3 (LEVE): a refused notice tried twice in the same run (the list, then the listing)");
  let refusedSends = 0;
  const refuse = async (): Promise<SendOutcome> => {
    refusedSends += 1;
    return "refused";
  };
  const q3 = order("cs_Q3listed", "q3@example.com", { [VIA_PENDING_META]: memberPend }, NOW - 3_000);
  sessions.set("cs_Q3listed", q3);
  await redis.pipeline([["SET", markKey("cs_Q3listed"), "tell:unread"], ["ZADD", "nl:aff:pend:due", NOW - 700, `${store.sid}|cs_Q3listed`]]);
  await notePendingDue(NOW, undefined, refuse);
  await notePendingLinks(store, [q3], NOW, undefined, undefined, refuse);
  is("one try a run (expected 1)", refusedSends, 1);

  part("Q4 (LEVE, VR 2): an own share set before 9 November, never changed since");
  sends = 0; texts.length = 0;
  await redis.pipeline([["HSET", people, ANA, person({ rate: 40 })]]);
  const q4pend = await pendingAt();
  await notePendingLinks(store, [order("cs_Q4", "q4@example.com", { [VIA_PENDING_META]: q4pend }, NOW - 300)], NOW, undefined, undefined, send);
  is("told (by design: its date is not known)", sends, 1);
  is("the notice does not say the share changed when that is not known (expected no 'changed since the sale')", /changed since the sale/.test(texts[0] ?? ""), false);

  part("Q5 (LEVE): a product taken out of the program, the affiliate's own share changed since");
  sends = 0; texts.length = 0;
  await redis.pipeline([["HSET", people, ANA, person({ rate: 40, rateAt: Date.now() })]]);
  await notePendingLinks(store, [order("cs_Q5", "q5@example.com", { [VIA_PENDING_META]: `ana.${NOW - 600}~ana.${NOW - 600}~-~12;prod01=x` }, NOW - 300)], NOW, undefined, undefined, send);
  is("it earns nothing whatever the share: no notice (expected 0 sends, mark none)", [sends, await mark("cs_Q5")], [0, "none"]);
  await redis.pipeline([["HSET", people, ANA, person()]]);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
