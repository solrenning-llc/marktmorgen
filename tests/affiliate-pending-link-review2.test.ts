/**
 * The second pre-review of claude5/affiliate-pending-link @ c0ed3da083 (owner's decision 6), its proofs kept as
 * checks, with a Stripe stand-in that answers what each one needs:
 *
 *   A (ALTO)   a membership's first payment credited at confirmation names its payment, so a refund takes it back,
 *              and the book never counts it twice;
 *   B          the affiliate's own share changed after the sale: not credited on its own, the creator told;
 *   C          a subscription change whose answer was lost is checked before anyone is told "not credited";
 *   D          an order seen once, at the end of its checkout's day, is told about at once, and a store's pending
 *              orders are kept on a list the sweep reads by itself, out of the day's listing;
 *   E          a PayPal order stays on the sweep's list though its mark could not be written;
 *   F-J        offers on a program switched off since, offers paid during the confirmation and on a later page,
 *              the truth when the sale's share was not kept, the sweep's own reads, and the pass's deadline.
 *
 * The proof's A expected the first payment credited although its invoice was not served; here the invoice is
 * served (GET /v1/invoices/{id}), since crediting it without its payment is the finding (rule 23). Its B expected
 * the sale's own share (30) after a raise; the sale's own share is not knowable once changed, so the creator is told
 * instead, as the coordinator's MÉDIO B asks (rule 23).
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
let postMode: "ok" | "lost-then-down" = "ok";
let getSubDown = false;
let posts = 0;
let calls = 0;
const invoicesById = new Map<string, Record<string, unknown>>();
let invoiceList: Record<string, unknown>[] = [];
let refunds: Record<string, unknown>[] = [];
let offers: Record<string, unknown>[] = [];
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
  await setStripeAccount(OWNER, "acct_1TestPrerev2Pen", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, days: 30, recurring: 12 }));
  let store = (await storeForEmail(OWNER))!;
  if (!store.sid) await ensureStoreId(storeRef(store));
  store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const codes = `nl:aff:${statsId}:codes`;
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, ANA, person()], ["HSET", codes, "ana", ANA]]);
  const sale = async (ref: string) => {
    const [raw] = await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, ref]]);
    return typeof raw === "string" ? (JSON.parse(raw) as { rate: number; aff: string; pi: string }) : null;
  };
  const mark = async (ref: string) => (await redis.pipeline([["GET", `nl:aff:pend:${statsId}:${ref}`]]))[0];
  const breakCodes = () => redis.pipeline([["HSET", codes, "ana", JSON.stringify({ not: "an id" })]]);
  const mendCodes = () => redis.pipeline([["HSET", codes, "ana", ANA]]);
  const pendingAt = async (products = ["prod01"]) => {
    await breakCodes();
    const credit = await attributionOrPending(store, products[0], { via: viaCookieValue(undefined, "ana", NOW - 600), session: undefined }, products);
    await mendCodes();
    return pendingChannel(credit)[VIA_PENDING_META] ?? "";
  };
  const memberPend = await pendingAt();
  const pend = await pendingAt();

  part("A (ALTO): a membership's first payment names its payment");
  invoicesById.set("in_1PrerevA01", paidInvoice("in_1PrerevA01", "pi_firstA"));
  const member = order("cs_subA", "subA@example.com", { [VIA_PENDING_META]: memberPend }, NOW - 300, { mode: "subscription", payment_intent: null, subscription: "sub_1PrerevA01", invoice: "in_1PrerevA01", customer: "cus_A" });
  await notePendingLinks(store, [member], NOW, undefined, undefined, send);
  is("credited at confirmation, with the invoice's payment", [(await sale("in_1PrerevA01"))?.aff, (await sale("in_1PrerevA01"))?.pi], [ANA, "pi_firstA"]);
  invoiceList = [{ id: "in_1PrerevA01", status: "paid", amount_paid: 5_000, currency: "usd", created: NOW - 300, status_transitions: { paid_at: NOW - 300 },
    parent: { subscription_details: { metadata: { store: "oven", product: "prod01" } } }, payments: { data: [{ payment: { payment_intent: "pi_firstA" } }] } }];
  refunds = [{ id: "re_A", status: "succeeded", payment_intent: "pi_firstA", amount: 5_000 }];
  is("refunded in full: the first payment earns nothing", (await readBook(store, ANA)).lines.filter((l) => l.ref === "in_1PrerevA01").map((l) => l.commission), [0]);
  refunds = [];
  invoiceList = [{ ...invoiceList[0], parent: { subscription_details: { metadata: { store: "oven", product: "prod01", ...(subs.get("sub_1PrerevA01") ?? {}) } } } }];
  is("were the invoice to carry the affiliate too, the first payment is one line, never two", (await readBook(store, ANA)).lines.filter((l) => l.ref === "in_1PrerevA01" && l.commission > 0).length, 1);
  invoiceList = [];
  const noInvoice = order("cs_subA2", "subA2@example.com", { [VIA_PENDING_META]: memberPend }, NOW - 300, { mode: "subscription", payment_intent: null, subscription: "sub_1PrerevA02", invoice: "in_1PrerevA02" });
  await notePendingLinks(store, [noInvoice], NOW, undefined, undefined, send);
  is("its invoice not answered: nothing credited, read again", [await sale("in_1PrerevA02"), String(await mark("cs_subA2")).startsWith("seen:")], [null, true]);
  invoicesById.set("in_1PrerevA02", paidInvoice("in_1PrerevA02", "pi_firstA2"));
  await notePendingLinks(store, [noInvoice], NOW + 300, undefined, undefined, send);
  is("answered at the next pass: credited then, once", [(await sale("in_1PrerevA02"))?.pi, String(await mark("cs_subA2")).startsWith("credited:")], ["pi_firstA2", true]);

  part("C (MÉDIO): a subscription change whose answer was lost");
  postMode = "lost-then-down";
  posts = 0;
  sends = 0;
  invoicesById.set("in_1PrerevC01", paidInvoice("in_1PrerevC01", "pi_firstC"));
  const lost = order("cs_C", "c@example.com", { [VIA_PENDING_META]: memberPend }, NOW - 300, { mode: "subscription", payment_intent: null, subscription: "sub_1PrerevC01", invoice: "in_1PrerevC01" });
  await notePendingLinks(store, [lost], NOW, undefined, undefined, send);
  is("Stripe took it though the answer was lost: read back, credited, nobody told", [String(await mark("cs_C")).startsWith("credited:"), (await sale("in_1PrerevC01"))?.aff, sends], [true, ANA, 0]);
  posts = 0;
  getSubDown = true;
  const unsure = order("cs_C2", "c2@example.com", { [VIA_PENDING_META]: memberPend }, NOW - 300, { mode: "subscription", payment_intent: null, subscription: "sub_1PrerevC02", invoice: "in_1PrerevC02" });
  await notePendingLinks(store, [unsure], NOW, undefined, undefined, send);
  await notePendingLinks(store, [unsure], NOW + PENDING_LINK_SECONDS + 60, undefined, undefined, send);
  is("still not known at the deadline: told, but never that it was not credited", [sends, await mark("cs_C2"), /not credited|are not credited/i.test(texts.at(-1) ?? "")], [1, "told", false]);
  is("it says what to check instead", /could not confirm/i.test(texts.at(-1) ?? ""), true);
  getSubDown = false;
  postMode = "ok";

  part("D (MÉDIO): seen once, at the end of its checkout's day");
  sends = 0;
  const createdD = NOW - (PENDING_SWEEP_SECONDS - 120);
  await breakCodes();
  // Regra 23: the click comes before the checkout opened (as in the proof); the RED commit had it after, which no window credits.
  await notePendingLinks(store, [order("cs_D", "d@example.com", { [VIA_PENDING_META]: `ana.${createdD - 60}~ana.${createdD - 60}~-~0;prod01=30` }, createdD)], NOW, undefined, undefined, send);
  await mendCodes();
  is("read once and still unknown: told in the same pass", [sends, await mark("cs_D")], [1, "told"]);
  is("the margin keeps the notice's tries inside the day", PENDING_TELL_MARGIN >= 300, true);
  // Regra 23: a checkout id as Stripe writes them (the RED commit's "cs_D2" was shorter than any).
  const listed = order("cs_D2listed", "d2@example.com", { [VIA_PENDING_META]: pend }, NOW - 600);
  await breakCodes();
  await notePendingLinks(store, [listed], NOW, undefined, undefined, send);
  await mendCodes();
  const [score] = await redis.pipeline([["ZSCORE", "nl:aff:pend:due", `${store.sid}|cs_D2listed`]]);
  is("a pending order is kept on the sweep's own list", score !== null && score !== undefined, true);
  sessions.set("cs_D2listed", listed);
  await notePendingDue(NOW + 900, undefined, send);
  is("which reads it by itself when the day's listing no longer brings it, and credits it", [(await sale("cs_D2listed"))?.aff, String(await mark("cs_D2listed")).startsWith("credited:")], [ANA, true]);
  const [gone] = await redis.pipeline([["ZSCORE", "nl:aff:pend:due", `${store.sid}|cs_D2listed`]]);
  is("and takes it off once decided", gone, null);

  part("E (MÉDIO): PayPal, the mark not written at the hand-over");
  const pp = { store: "oven", order: "PPPREREV2E", capture: "CAPPREREV2E", email: "pe@example.com", product: "prod01", cents: 4_000, currency: "USD", at: NOW - 60, handle: "oven", meta: { [VIA_PENDING_META]: pend } };
  await breakCodes();
  const real = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => (c[0] === "SET" || c[0] === "GET") && String(c[1]).startsWith(`nl:aff:pend:${statsId}:paypal:`))) throw new Error("synthetic: the mark does not answer");
    return real.call(redis, commands);
  }) as typeof redis.pipeline;
  await creditPayPalSale(store, pp, "Sourdough course", send).catch(() => undefined);
  redis.pipeline = real;
  await mendCodes();
  const [ppScore] = await redis.pipeline([["ZSCORE", `nl:aff:pend:pp:${statsId}`, pp.order]]);
  is("the order stays on the sweep's list", ppScore !== null && ppScore !== undefined, true);

  part("F (LEVE): the program switched off since: the order's offers follow it");
  offers = [{ id: "pi_offerF", object: "payment_intent", status: "succeeded", amount: 2_000, currency: "usd", created: NOW - 200, receipt_email: "f@example.com", customer: "cus_F",
    metadata: { store: "oven", product: "prod02", title: "Kit", kind: "upsell", parent: "cs_F" } }];
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, enabled: false }));
  store = (await storeForEmail(OWNER))!;
  await notePendingLinks(store, [order("cs_F", "f@example.com", { [VIA_PENDING_META]: pend }, NOW - 300, { customer: "cus_F" })], NOW, undefined, undefined, send);
  is("the order and its offer, paid before the confirmation", [(await sale("cs_F"))?.aff, (await sale("pi_offerF"))?.aff ?? null], [ANA, ANA]);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, enabled: true }));
  store = (await storeForEmail(OWNER))!;

  part("G (LEVE): offers on a later page, and one paid while the order is confirmed");
  offers = [];
  for (let i = 0; i < 150; i += 1) offers.push({ id: `pi_other${String(i).padStart(3, "0")}`, object: "payment_intent", status: "succeeded", amount: 100, currency: "usd", created: NOW - 500, customer: "cus_G", metadata: {} });
  offers.push({ id: "pi_offerG", object: "payment_intent", status: "succeeded", amount: 2_000, currency: "usd", created: NOW - 200, customer: "cus_G", metadata: { store: "oven", product: "prod02", title: "Kit", kind: "upsell", parent: "cs_G" } });
  await notePendingLinks(store, [order("cs_G", "g@example.com", { [VIA_PENDING_META]: pend }, NOW - 300, { customer: "cus_G" })], NOW, undefined, undefined, send);
  is("an offer on the buyer's second page of payments is credited", (await sale("pi_offerG"))?.aff ?? null, ANA);
  await redis.pipeline([["SET", `nl:aff:pend:${statsId}:cs_G2`, `offers:${ANA}:${NOW}`]]);
  await noteCharge(store, { id: "pi_offerG2", object: "payment_intent", status: "succeeded", amount: 2_000, currency: "usd", created: NOW, metadata: { store: "oven", product: "prod02", title: "Kit", kind: "upsell", parent: "cs_G2" } });
  is("an offer noted while its order's offers are still being read is credited too", (await sale("pi_offerG2"))?.aff ?? null, ANA);

  part("H (LEVE): the truth when the sale's share was not kept");
  sends = 0;
  texts.length = 0;
  await notePendingLinks(store, [order("cs_H", "h@example.com", { [VIA_PENDING_META]: `ana.${NOW - 600}~ana.${NOW - 600}~-~0` }, NOW - 300)], NOW, undefined, undefined, send);
  is("told at once, since the share will not become known", [sends, await mark("cs_H"), await sale("cs_H")], [1, "told", null]);
  is("saying the link was read and the share is what is not known", /share/i.test(texts[0] ?? "") && !/could not be read/i.test(texts[0] ?? ""), true);
  is("the notice for that case says so", /share/.test(pendingNotice(store, "cs_H", "x", "share").text), true);

  part("I (LEVE): the sweep hands its reads on");
  const sweep = readFileSync(join(process.cwd(), "lib/checkout-sweep.ts"), "utf8");
  // Regra 23: case-insensitive since the RED commit, the sweep's names being readOwners and readPartners.
  is("notePendingLinks gets the codes and the partners the sweep read", /notePendingLinks\(store, pendingRows[^)]*owners[^)]*partners/i.test(sweep), true);
  is("and the sweep reads its own list of pending orders", /notePendingDue\(/.test(sweep), true);

  part("J (LEVE): Stripe is never asked past the pass's deadline");
  calls = 0;
  invoicesById.set("in_1PrerevJ01", paidInvoice("in_1PrerevJ01", "pi_firstJ"));
  const late = order("cs_J", "j@example.com", { [VIA_PENDING_META]: memberPend }, NOW - 300, { mode: "subscription", payment_intent: null, subscription: "sub_1PrerevJ01", invoice: "in_1PrerevJ01" });
  await notePendingLinks(store, [late], NOW, undefined, undefined, send, Date.now() - 1);
  is("no request past it, and the order is left for the next pass", [calls, await sale("in_1PrerevJ01"), String(await mark("cs_J")).startsWith("seen:")], [0, null, true]);

  part("B (MÉDIO): the affiliate's own share changed after the sale");
  sends = 0;
  texts.length = 0;
  const pendB = await pendingAt();
  await setAffiliateRate(store, ANA, 50);
  await notePendingLinks(store, [order("cs_B", "b@example.com", { [VIA_PENDING_META]: pendB }, NOW - 300)], NOW, undefined, undefined, send);
  is("not credited on its own: the share it was sold at is not known now", await sale("cs_B"), null);
  is("and the creator is told", [sends, await mark("cs_B"), /share/i.test(texts[0] ?? "")], [1, "told", true]);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
