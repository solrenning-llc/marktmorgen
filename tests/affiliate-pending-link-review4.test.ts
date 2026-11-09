/**
 * The first independent money review of #3479 (Claude 3, comments 6749606658 and 6749624969, 9 November 2026) as
 * checks:
 *
 *   MÉDIO (L5)  a membership's first payment whose total, or whose tax, is not a number is never taken for 0: not
 *               credited, no "credited" mark, read again at the next pass (rule 24; the tax is taken off the base the
 *               commission is worked out on);
 *   L1          a link read whose buyer could not be told apart from the affiliate themselves is told at once, in
 *               its own words, never read again for two hours nor told "could not be read";
 *   L4          an order whose offers after paying cannot be read is told about past its deadline ("offers"), its
 *               sale staying credited;
 *   L6a         an order found credited when a notice was due is marked credited to its affiliate, so its later
 *               offers follow it.
 */
import { NO_AFFILIATES, parseAffiliateSetting, viaCookieValue } from "@/lib/affiliate-setting";
import {
  PENDING_LINK_SECONDS,
  VIA_PENDING_META,
  attributionOrPending,
  notePendingLinks,
  pendingChannel,
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
    return typeof raw === "string" ? (JSON.parse(raw) as { rate: number; aff: string; pi: string; base: number }) : null;
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
  const pend = await pendingAt();
  const member = (id: string, over: Record<string, unknown>) =>
    order(id, `${id}@example.com`, { [VIA_PENDING_META]: memberPend }, NOW - 300, { mode: "subscription", payment_intent: null, subscription: `sub_1Rev4${id}`, invoice: `in_1Rev4${id}`, ...over });

  part("MÉDIO (L5): a total or a tax that is not a number is never 0");
  for (const [id, over] of [["NoTotal", { amount_total: null }], ["NoTax", { total_details: { amount_tax: "unknown" } }]] as const) {
    invoicesById.set(`in_1Rev4${id}`, paidInvoice(`in_1Rev4${id}`, `pi_first${id}`));
    await notePendingLinks(store, [member(id, over)], NOW, undefined, undefined, send);
    is(`${id}: nothing credited, no credited mark, read again`, [await sale(`in_1Rev4${id}`), String(await mark(id)).startsWith("seen:")], [null, true]);
  }
  invoicesById.set("in_1Rev4Fixed", paidInvoice("in_1Rev4Fixed", "pi_firstFixed"));
  await notePendingLinks(store, [member("Fixed", { amount_total: 5_000, total_details: { amount_tax: 1_000 } })], NOW, undefined, undefined, send);
  is("a known total and tax: credited on the total less the tax", (await sale("in_1Rev4Fixed"))?.base, 4_000);
  const trial = member("Trial", { amount_total: 0 });
  await notePendingLinks(store, [trial], NOW, undefined, undefined, send);
  is("a real 0 (a trial): nothing to credit, the subscription carries the affiliate", String(await mark("Trial")).startsWith("credited:"), true);

  part("L1: whether the buyer was the affiliate could not be told");
  sends = 0;
  texts.length = 0;
  const unsure = pend.replace(/~-~/, "~?~");
  await notePendingLinks(store, [order("cs_L1", "l1@example.com", { [VIA_PENDING_META]: unsure }, NOW - 300)], NOW, undefined, undefined, send);
  is("told at once, not read again for two hours", [sends, await mark("cs_L1"), await sale("cs_L1")], [1, "told", null]);
  is("in its own words: the link was read, the buyer could not be told apart from the affiliate", /could not tell whether the buyer was the affiliate/i.test(texts[0] ?? "") && !/could not be read when the buyer paid/.test(texts[0] ?? ""), true);

  part("L4: offers that cannot be read, past the deadline");
  sends = 0;
  texts.length = 0;
  await redis.pipeline([["SET", markKey("cs_L4"), `offers:${ANA}:${NOW - PENDING_LINK_SECONDS - 60}`]]);
  const l4 = order("cs_L4", "l4@example.com", { [VIA_PENDING_META]: pend }, NOW - PENDING_LINK_SECONDS - 300, { customer: "cus_unreadable" });
  offers.push(...Array.from({ length: 600 }, (_, i) => ({ id: `pi_many${String(i).padStart(3, "0")}`, object: "payment_intent", status: "succeeded", amount: 100, currency: "usd", created: NOW - 900, customer: "cus_unreadable", metadata: {} })));
  await notePendingLinks(store, [l4], NOW, undefined, undefined, send);
  is("told, with its own reason, not retried for ever", [sends, await mark("cs_L4"), /offer/i.test(texts[0] ?? "")], [1, "told", true]);

  part("L6a: a notice due on an order already credited");
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:sales`, "cs_L6", JSON.stringify({ ref: "cs_L6", pi: "pi_cs_L6", aff: ANA, at: NOW - 300, product: "prod01", title: "Sourdough course", base: 5_000, total: 5_000, currency: "usd", rate: 30, self: false, how: "click" })],
    ["SET", markKey("cs_L6"), `seen:${NOW - PENDING_LINK_SECONDS - 60}`],
  ]);
  await notePendingLinks(store, [order("cs_L6", "l6@example.com", { [VIA_PENDING_META]: pend }, NOW - PENDING_LINK_SECONDS - 300)], NOW, undefined, undefined, send);
  is("marked credited to its affiliate, so its offers follow it", await mark("cs_L6"), `credited:${ANA}`);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
