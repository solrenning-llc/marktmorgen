/**
 * The second money review of #3479 (Claude 1, comment 6799228085, head 5f1dd382) as checks:
 *
 *   MEDIUM 1  a PayPal order whose link was pending is put on the sweep's list before anything else at its hand-over:
 *             an unknown read of the partners' people (notePartners) no longer drops it, uncredited and untold;
 *   MEDIUM 2  a membership whose subscription already carries the affiliate (a pass that put it, then failed on its
 *             first invoice) is never told "No commission is counted" when it is read again at another share: it is
 *             credited, its first payment with it, so the creator never pays by hand what the book also owes.
 */
import { NO_AFFILIATES, parseAffiliateSetting, viaCookieValue } from "@/lib/affiliate-setting";
import {
  VIA_PENDING_META,
  attributionOrPending,
  creditPayPalSale,
  notePayPalPendings,
  notePendingLinks,
  pendingChannel,
} from "@/lib/affiliates";
import type { SendOutcome } from "@/lib/email";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_rev6_pending";
process.env.RESEND_API_KEY = "re_test_rev6_pending";

const OWNER = "baker@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";

// A small Stripe: subscriptions keep what a POST put on them; invoices, refunds, offers and sessions as set.
const subs = new Map<string, Record<string, string>>();
// Typed wide so the branch kept from the second review type-checks (the proof had it narrowed to "ok").
const postMode = "ok" as "ok" | "lost-then-down";
const getSubDown = false;
let posts = 0;
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
  await setStripeAccount(OWNER, "acct_1TestRev6Pendin", true);
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
    return typeof raw === "string" ? (JSON.parse(raw) as { rate: number; aff: string; pi: string; base: number }) : null;
  };
  const markKey = (ref: string) => `nl:aff:pend:${statsId}:${ref}`;
  const mark = async (ref: string) => (await redis.pipeline([["GET", markKey(ref)]]))[0];
  const pendingAt = async () => {
    await redis.pipeline([["HSET", codes, "ana", JSON.stringify({ not: "an id" })]]);
    const credit = await attributionOrPending(store, "prod01", { via: viaCookieValue(undefined, "ana", NOW - 600), session: undefined }, ["prod01"]);
    await redis.pipeline([["HSET", codes, "ana", ANA]]);
    return pendingChannel(credit)[VIA_PENDING_META] ?? "";
  };

  part("MEDIUM 1: a PayPal order's pending link is kept for the sweep when the partners' people do not read");
  {
    const pend = await pendingAt();
    const paid = { store: "oven", order: "PPORDERREV60001", capture: "CAPREV60001", email: "pp@example.com", product: "prod01", cents: 4_000, currency: "USD", at: NOW - 60, handle: "oven", meta: { [VIA_PENDING_META]: pend } };
    await redis.pipeline([["SET", `nl:ppsell:paid:${paid.order}`, JSON.stringify(paid)]]);
    const real = redis.pipeline.bind(redis);
    let failed = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!failed && commands.some((c) => c[0] === "HGETALL" && c[1] === people)) {
        failed = true;
        return [{ unknown: "shape" }];
      }
      return real(commands);
    }) as typeof redis.pipeline;
    let threw = false;
    try {
      await creditPayPalSale(store, paid, "Sourdough course", send);
    } catch {
      threw = true;
    } finally {
      redis.pipeline = real;
    }
    is("control: the people read failed at the hand-over", failed, true);
    const sellsPayPal = { ...store, paypalSeller: { merchant: "SYNTHETICMERCH1", at: NOW } } as typeof store;
    await notePayPalPendings(sellsPayPal, NOW + 300, send);
    await notePayPalPendings(sellsPayPal, NOW + 600, send);
    is("the order is credited to the affiliate once Redis answers, never dropped", (await sale(`paypal:${paid.order}`))?.aff, ANA);
    is("and the hand-over still says the partners failed, so it is logged", threw, true);
  }

  part("Claude 4's MEDIUM (cloud G): the sweep's list not confirmed still leaves the partners' shares written");
  {
    // A partner holding a share of the product, so the sale owes them something whatever the link.
    const BEA = "bbbbbbbbbbbb";
    await redis.pipeline([["HSET", people, BEA, JSON.stringify({ id: BEA, email: "bea@example.com", code: "bea", status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "", rate: null, share: { percent: 10, products: ["prod01"] } })]]);
    const pend = await pendingAt();
    const paid = { store: "oven", order: "PPORDERREV60009", capture: "CAPREV60009", email: "pp9@example.com", product: "prod01", cents: 4_000, currency: "USD", at: NOW - 60, handle: "oven", meta: { [VIA_PENDING_META]: pend } };
    await redis.pipeline([["SET", `nl:ppsell:paid:${paid.order}`, JSON.stringify(paid)]]);
    const real = redis.pipeline.bind(redis);
    let lost = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!lost && commands.some((c) => c[0] === "ZADD" && String(c[1]).startsWith("nl:aff:pend:pp:"))) {
        lost = true;
        return commands.map(() => ({ unknown: "shape" }));
      }
      return real(commands);
    }) as typeof redis.pipeline;
    let threw = false;
    try {
      await creditPayPalSale(store, paid, "Sourdough course", send);
    } catch {
      threw = true;
    } finally {
      redis.pipeline = real;
    }
    is("control: the sweep's list answered in an unknown shape once", lost, true);
    const [share] = await redis.pipeline([["HGET", `nl:aff:${statsId}:shares`, `paypal:${paid.order}:${BEA}`]]);
    is("the partner's share of the sale is still written", typeof share === "string", true);
    is("and the hand-over is still told something failed, so it is logged", threw, true);
    await redis.pipeline([["HDEL", people, BEA]]);
  }

  part("MEDIUM 2: a membership already carrying the affiliate is never told it is not credited");
  {
    const memberPend = await pendingAt();
    const id = "cs_Rev6Member";
    const sub = "sub_1Rev6Member";
    const invoice = "in_1Rev6Member";
    // Pass 1 put the affiliate on the subscription, then its first invoice did not answer: the mark stayed "seen".
    subs.set(sub, { via: ANA, via_rate: "30" });
    invoicesById.set(invoice, paidInvoice(invoice, "pi_firstRev6"));
    await redis.pipeline([["SET", markKey(id), `seen:${NOW - 120}`]]);
    // Before pass 2, the creator changes the affiliate's own share: the link now reads at another share.
    await redis.pipeline([["HSET", people, ANA, person({ rate: 45 })]]);
    sends = 0;
    texts.length = 0;
    const row = order(id, "member@example.com", { [VIA_PENDING_META]: memberPend }, NOW - 300, { mode: "subscription", payment_intent: null, subscription: sub, invoice });
    await notePendingLinks(store, [row], NOW, undefined, undefined, send);
    is("no notice that no commission is counted", texts.some((t) => /No commission is counted/i.test(t)), false);
    is("marked credited to the affiliate on its subscription", await mark(id), `credited:${ANA}`);
    is("its first payment credited with it", (await sale(invoice))?.aff, ANA);
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
