/**
 * One payment's refunds, read only when the creator opens it (coordinator's
 * decision C1-20261108-0315-C4-30, on top of #3160).
 *
 * The studio's list of payment requests reads the account's refunds at most
 * three pages (300). A store with more leaves a paid request "Paid, refunds
 * not checked" (#3160). Since this unit, such a request can be checked on its
 * own: one GET /v1/refunds?payment_intent=... when the creator presses its
 * button, never when the list is drawn. Checked here, with Redis in memory
 * and Stripe mocked:
 *
 *   - a store with 301 refunds: the list makes no call per payment, and says
 *     the request can be checked on its own; below the cap nothing changes;
 *   - the request checked on its own shows what Stripe says (part, in full),
 *     writes it upward, and is kept a short while per payment, so opening it
 *     again does not ask Stripe; a refund the store's Stripe events show
 *     forgets what was kept (lib/webhooks.ts, charge.refunded);
 *   - a read that fails, a list with more than one page, a row of another
 *     payment or in another shape, a refund under way: "not checked", never 0;
 *   - past the store's checks for the minute, Stripe is not asked: "not checked";
 *   - the studio offers the button only where the list was cut at its cap.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft, type PaymentRequest } from "@/lib/payment-request-rules";
import { createRequest, markPaid, readRequest } from "@/lib/payment-request-store";
import * as requests from "@/lib/payment-requests";
import { addEndpoint, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { PaymentRequestsStudio } from "@/components/payment-requests-studio";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Page = { status?: number; body: unknown };
/** The account's refund list, page by page (no payment_intent asked). */
let pages: Page[] = [];
let listReads = 0;
/** One payment's refunds (payment_intent asked): the n-th such read answers single[n]. */
let single: Page[] = [];
let singleReads = 0;
const singleAsked: string[] = [];
let events: unknown[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/refunds" && method === "GET") {
    if (url.searchParams.has("payment_intent")) {
      singleAsked.push(url.search);
      const page = single[singleReads] ?? { body: { object: "list", data: [], has_more: false } };
      singleReads += 1;
      return answer(page.body, page.status ?? 200);
    }
    const page = pages[listReads] ?? { body: { object: "list", data: [], has_more: false } };
    listReads += 1;
    return answer(page.body, page.status ?? 200);
  }
  if (path === "/events" && method === "GET") return answer({ object: "list", data: events, has_more: false });
  if (path.startsWith("/payment_intents/")) return answer({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, 404);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;
// An endpoint's name resolves to a private address: no delivery ever leaves this machine.
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });

const INTENT = "pi_RefundsOnDemand0001";
const PAID = 48_000;
const other = (n: number) => ({ id: `re_other_${n}`, object: "refund", payment_intent: `pi_SomethingElse${String(n).padStart(6, "0")}`, status: "succeeded", amount: 500 });
const ours = (id: string, amount: number, status = "succeeded") => ({ id, object: "refund", payment_intent: INTENT, status, amount });
const list = (data: unknown, more: unknown) => ({ body: { object: "list", data, has_more: more } });
const hundred = (from: number) => Array.from({ length: 100 }, (_, i) => other(from + i));
/** 301 refunds on the account, ours the 301st: the list's three pages never reach it. */
const capped = () => [list(hundred(0), true), list(hundred(100), true), list(hundred(200), true), list([ours("re_ours_301", 10_000)], false)];

const OWNER = "refund-demand@example.com";
async function paidStore(): Promise<Store> {
  await claimHandle(OWNER, "refunddemand", "Refund Demand Studio", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1RefDemand01", true);
  await setSubscription(OWNER, { customerId: "cus_refunddemand", subscriptionId: "sub_refunddemand", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(OWNER))!;
}

type Shown = PaymentRequest & { refundsChecked?: boolean; refundsRetry?: boolean; refundsOnDemand?: boolean };
type Check = { request: Shown; why: string } | null;
const api = requests as unknown as {
  checkRequestRefunds?: (store: Store, id: string, now?: number) => Promise<Check>;
  forgetRefundCheck?: (sid: string, payment: string) => Promise<void>;
  REFUND_CHECKS_PER_MINUTE?: number;
  REFUND_CHECK_SECONDS?: number;
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_refunds_on_demand_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_refunds_on_demand_only_a_stand_in";
  const now = Date.now();
  let store = await paidStore();
  const draft = (readDraft({ email: "client@example.com", name: "Dana", lines: [{ text: "Coaching", quantity: 1, amount: "480" }], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft;
  const made = await createRequest(store, draft, now);
  if (!made.ok) throw new Error("the request was not made");
  const id = made.request.id;
  await markPaid(store, id, { id: "cs_test_refundsondemand0000000001", amount_total: PAID, payment_intent: INTENT, created: Math.floor(now / 1000) }, now);
  store = (await storeForEmail(OWNER))!;
  const kept = async () => (await readRequest(id))!;

  const drawList = async (given: Page[]) => {
    pages = given;
    listReads = 0;
    singleReads = 0;
    const shown = (await requests.refreshRefunds(store, [await kept()], now)) as Shown[];
    return { shown: shown[0], listReads, singleReads };
  };
  const check = async (given: Page[]) => {
    single = given;
    singleReads = 0;
    singleAsked.length = 0;
    listReads = 0;
    const got = api.checkRequestRefunds ? await api.checkRequestRefunds(store, id, now) : null;
    return { got, request: got?.request, why: got?.why, singleReads, listReads, kept: await kept() };
  };

  part("The list never reads one payment at a time");
  let l = await drawList(capped());
  is("301 refunds on the account: the list reads its three pages, not one more, and no payment on its own", [l.listReads, l.singleReads], [3, 0]);
  is("the request is not checked, and can be checked on its own", [l.shown.state, l.shown.refunded, l.shown.refundsChecked, l.shown.refundsOnDemand], ["paid", 0, false, true]);
  l = await drawList([list([other(1)], false)]);
  is("below the cap the list is read in full and nothing changes: checked, nothing offered", [l.shown.refundsChecked, l.shown.refundsOnDemand, l.singleReads], [true, false, 0]);
  l = await drawList([{ status: 500, body: {} }]);
  is("a list that failed is not the cap: nothing offered (a reload is)", [l.shown.refundsChecked, l.shown.refundsRetry, l.shown.refundsOnDemand], [false, true, false]);

  part("Opened on its own, the request shows what Stripe says");
  is("there is a way to check one request's refunds", typeof api.checkRequestRefunds, "function");
  let c = await check([list([ours("re_ours_301", 10_000)], false)]);
  is("one call, for that payment only", [c.singleReads, c.listReads, singleAsked[0]?.includes(`payment_intent=${INTENT}`)], [1, 0, true]);
  is("$100 of $480 refunded, checked", [c.request?.state, c.request?.refunded, c.request?.refundsChecked, c.why], ["paid", 10_000, true, ""]);
  is("and kept, so the list shows at least that from now on", [c.kept.state, c.kept.refunded], ["paid", 10_000]);
  c = await check([{ status: 500, body: {} }]);
  is("opened again within the minute: Stripe is not asked, the same answer", [c.singleReads, c.request?.refunded, c.request?.refundsChecked], [0, 10_000, true]);

  part("A refund the store's Stripe events show forgets what was kept");
  is("there is a way to forget one payment's kept check", typeof api.forgetRefundCheck, "function");
  is("the events reader forgets it on a refunded charge, whether or not an endpoint listens for refunds", /event\.type === "charge\.refunded"\) \{[\s\S]{0,900}forgetRefundCheck\([\s\S]{0,900}heard\.has\("refund\.issued"\)/.test(readFileSync("lib/webhooks.ts", "utf8")), true);
  is("an endpoint that listens only for disputes is kept", (await addEndpoint(store, "https://hooks.example.net/in", ["dispute.opened"])).ok, true);
  events = [{ id: "evt_RefDemand1", type: "charge.refunded", created: Math.floor(now / 1000), data: { object: { id: "ch_RefDemand1", payment_intent: INTENT, amount_refunded: PAID, amount: PAID, refunded: true, currency: "usd", metadata: {} } } }];
  const quiet = console.error;
  console.error = () => undefined;
  try {
    await watchStripe(Date.now() + 10_000);
  } finally {
    console.error = quiet;
  }
  c = await check([list([ours("re_ours_301", 10_000), ours("re_ours_rest", 38_000)], false)]);
  is("after the refund event, Stripe is asked again, and the rest of the refund is read: refunded in full", [c.singleReads, c.request?.state, c.request?.refunded, c.request?.refundsChecked], [1, "refunded", PAID, true]);

  part("A read that cannot be trusted is \"not checked\", never 0");
  redis.clear();
  store = await paidStore();
  const made2 = await createRequest(store, draft, now);
  if (!made2.ok) throw new Error("the second request was not made");
  await markPaid(store, made2.request.id, { id: "cs_test_refundsondemand0000000002", amount_total: PAID, payment_intent: INTENT, created: Math.floor(now / 1000) }, now);
  store = (await storeForEmail(OWNER))!;
  const id2 = made2.request.id;
  const check2 = async (given: Page[]) => {
    single = given;
    singleReads = 0;
    const got = api.checkRequestRefunds ? await api.checkRequestRefunds(store, id2, now) : null;
    if (api.forgetRefundCheck) await api.forgetRefundCheck(store.sid, INTENT);
    return { request: got?.request, why: got?.why, singleReads, kept: (await readRequest(id2))! };
  };
  let d = await check2([{ status: 500, body: { error: { message: "Stripe is having trouble" } } }]);
  is("Stripe answers 500: not checked, reading again may help, nothing changed", [d.request?.state, d.request?.refunded, d.request?.refundsChecked, d.request?.refundsRetry, d.why, d.kept.refunded], ["paid", 0, false, true, "stripe", 0]);
  d = await check2([{ status: 500, body: {} }, list([ours("re_late", 10_000)], false)]);
  is("a failed read is not kept: the next opening asks Stripe again", d.singleReads, 1);
  d = await check2([list([ours("re_a", 10_000)], true)]);
  is("more than a hundred refunds on that one payment: not checked, nothing promised", [d.request?.refundsChecked, d.request?.refundsRetry, d.why], [false, false, "more"]);
  d = await check2([list([other(1)], false)]);
  is("a row of another payment in that payment's list: not checked", [d.request?.refundsChecked, d.why], [false, "shape"]);
  d = await check2([list([{ id: "re_odd", object: "refund", payment_intent: INTENT, status: "succeeded", amount: "10000" }], false)]);
  is("a refund whose amount is not a number: not checked", [d.request?.refundsChecked, d.request?.refunded, d.why], [false, 0, "shape"]);
  d = await check2([list([ours("re_wait", PAID, "pending")], false)]);
  is("a refund still under way: not checked, reading again may help", [d.request?.state, d.request?.refundsChecked, d.request?.refundsRetry, d.why], ["paid", false, true, "under_way"]);
  d = await check2([{ body: { object: "list", data: "none", has_more: false } }]);
  is("a page in another shape: not checked", [d.request?.refundsChecked, d.why], [false, "shape"]);
  d = await check2([list([], false)]);
  is("control: none on that payment, read whole: checked, nothing refunded", [d.request?.state, d.request?.refunded, d.request?.refundsChecked, d.why], ["paid", 0, true, ""]);

  part("Past the store's checks for the minute, Stripe is not asked");
  redis.clear();
  store = await paidStore();
  const made3 = await createRequest(store, draft, now);
  if (!made3.ok) throw new Error("the third request was not made");
  await markPaid(store, made3.request.id, { id: "cs_test_refundsondemand0000000003", amount_total: PAID, payment_intent: INTENT, created: Math.floor(now / 1000) }, now);
  store = (await storeForEmail(OWNER))!;
  const cap = api.REFUND_CHECKS_PER_MINUTE ?? 0;
  is("a finite cap a minute, below Stripe's read limit", cap > 0 && cap <= 30, true);
  let asked = 0;
  for (let i = 0; i < cap; i += 1) {
    single = [list([], false)];
    singleReads = 0;
    const got = api.checkRequestRefunds ? await api.checkRequestRefunds(store, made3.request.id, now) : null;
    asked += singleReads;
    if (got?.request.refundsChecked !== true) break;
    if (api.forgetRefundCheck) await api.forgetRefundCheck(store.sid, INTENT);
  }
  is("each check within the cap asks Stripe once", asked, cap);
  single = [list([], false)];
  singleReads = 0;
  const over = api.checkRequestRefunds ? await api.checkRequestRefunds(store, made3.request.id, now) : null;
  is("one more: Stripe not asked, not checked (never 0 refunded as if checked)", [singleReads, over?.request.refundsChecked, over?.why], [0, false, "limit"]);
  is("a request of another store is not found", api.checkRequestRefunds ? await api.checkRequestRefunds({ ...store, sid: "someoneelse" } as Store, made3.request.id, now) : "missing", null);

  part("The studio offers the check only where the list was cut at its cap");
  const route = readFileSync("app/api/store/payment-requests/route.ts", "utf8");
  is("the route checks one request for a role that may read orders", /action === "refunds"[\s\S]{0,120}"orders"/.test(route) && route.includes("checkRequestRefunds(store, id)"), true);
  const base = (await readRequest(made3.request.id))!;
  const row = (over: Partial<Shown>) => ({ ...base, state: "paid" as const, refunded: 0, refundsChecked: false, refundsRetry: false, link: "https://marktmorgen.com/pay/x", ...over });
  const draw = (rows: ReturnType<typeof row>[]) =>
    renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: {} as never },
        createElement(PaymentRequestsStudio, {
          rows: rows as never,
          now,
          currency: "usd",
          canSend: false,
          open: true,
          closedWhy: "",
          limits: { open: 10, kept: 50 },
          openNow: 0,
          emails: { used: 0, limit: 100 },
          shareWords: "",
          taxOn: false,
          prefill: { email: "", name: "", text: "", amount: "" },
          dueFirst: "2026-11-08",
          dueLast: "2026-12-08",
        }),
      ),
    );
  const offered = draw([row({ refundsOnDemand: true })]);
  is("cut at the cap: a button to check this payment's refunds, for a role that cannot send too", offered.includes(">Check refunds for this payment<"), true);
  is("and the notice says why and that each request can be checked on its own, in words", /role="status"[^>]*>Refunds on Stripe could not all be checked[^<]*more refunds than this list reads at once/.test(offered), true);
  is("the button says what it reads", offered.includes("Reads this one payment&#x27;s refunds on your Stripe account."), true);
  const notOffered = draw([row({ refundsOnDemand: false, refundsRetry: true })]);
  is("not at the cap: no button", notOffered.includes("Check refunds for this payment"), false);

  part("The studio believes only an answer in the route's exact shape");
  const reply = (requests as unknown as { refundCheckReply?: unknown }).refundCheckReply;
  const { refundCheckReply } = await import("@/lib/payment-request-reply");
  is("control: a whole check", refundCheckReply(true, { ok: true, checked: true, state: "paid", refunded: 10_000 }), { checked: true, state: "paid", refunded: 10_000 });
  is("not checked, with the route's own sentence", refundCheckReply(true, { ok: true, checked: false, state: "paid", refunded: 0, message: "Refunds were not checked: try again." }), { checked: false, message: "Refunds were not checked: try again." });
  for (const [what, body, httpOk] of [
    ["an HTTP error with a success body", { ok: true, checked: true, state: "paid", refunded: 0 }, false],
    ["checked as a string", { ok: true, checked: "true", state: "paid", refunded: 0 }, true],
    ["no amount", { ok: true, checked: true, state: "paid" }, true],
    ["an amount that is not whole", { ok: true, checked: true, state: "paid", refunded: 1.5 }, true],
    ["a state that cannot have refunds", { ok: true, checked: true, state: "open", refunded: 0 }, true],
    ["no answer at all", null, true],
  ] as const) is(`${what}: not checked, never 0 refunded`, refundCheckReply(httpOk, body).checked, false);
  is("(nothing of the reader is on lib/payment-requests)", reply, undefined);

  done();
}

void main();
