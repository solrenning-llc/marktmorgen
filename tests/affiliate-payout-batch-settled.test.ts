/**
 * The payout batch file is handed out only on a book that its "I paid" confirmation would accept (first money review
 * of #3378 by Claude 2, 9 November 2026, comment 6736820606).
 *
 * HIGH: GET app/api/store/affiliates/payout-batch built the file from payableLines without checking refundsChecked or
 * invoicesChecked, while the POST that records the batch refused with 409. The creator downloaded the file, paid it in
 * their own PayPal, the confirmation was refused, nothing was recorded, and the next download carried the same lines:
 * the same batch paid twice. Probe: GET 200 with `sara.pay@example.com,30.00,USD`, POST 409 `invoices`, GET 200 again.
 * Now the GET refuses on exactly the POST's conditions, with the same reason, before any line is written, and the
 * studio does not offer the files then.
 *
 * MEDIUM: past the kept invoices' ceiling (INVOICES_KEPT_MAX_LINES or INVOICES_KEPT_MAX_BYTES) the store was held for
 * good while every word said "try again in a moment". Now the book says so (invoicesPastCeiling), every reading after,
 * while it is still past it, and the studio, the POST, the GET, the PayPal press and the payday email say plainly that
 * reloading will not help and that paying each affiliate by hand still works.
 *
 * LOW: a daily reading again that ends on an invoice it cannot read still said whole; the public API and MCP did not
 * say invoices_checked.
 *
 * Synthetic data, Stripe, PayPal and Resend stand-ins.
 */
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { NO_AFFILIATES, RECURRING_ALWAYS, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { INVOICES_KEPT_MAX_LINES, readBook } from "@/lib/affiliates";
import { autoPayEmail, paydayEmail } from "@/lib/affiliate-payday";
import { connectPayPal, payWithPayPal } from "@/lib/paypal-payouts";
import { affiliates as apiAffiliates } from "@/lib/api-read";
import { affiliatesTool } from "@/lib/mcp-tools";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { GET as downloadBatch, POST as recordBatch } from "@/app/api/store/affiliates/payout-batch/route";
import { AffiliateStudio } from "@/components/affiliate-studio";
import { AffiliateCommissionHistory } from "@/components/affiliate-commission-history";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_payout_batch_settled_only";
process.env.RESEND_API_KEY = "re_test_payout_batch_settled_only";

const OWNER = "owner@example.com";
const DAY = 86_400;
const REAL_NOW = Date.now;
let shift = 0;
Date.now = () => REAL_NOW() + shift;
const NOW = Math.floor(REAL_NOW() / 1000);
const SARA = "0123456789ab";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";

let all: Record<string, unknown>[] = [];
let invoicesUnreadable = false;
let refundsUnreadable = false;
const payouts: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.hostname === "api-m.paypal.com") {
    if (url.pathname === "/v1/oauth2/token") return answer({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts openid", expires_in: 32400 });
    if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
      payouts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return answer({ batch_header: { payout_batch_id: `BATCH${payouts.length}ABC`, batch_status: "PENDING" } }, 201);
    }
    return answer({ name: "RESOURCE_NOT_FOUND" }, 404);
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/invoices") {
    if (invoicesUnreadable) return answer({ object: "list", has_more: false });
    const q = url.searchParams;
    const num = (name: string) => (q.has(name) ? Number(q.get(name)) : null);
    const [gte, gt, lte, lt] = [num("created[gte]"), num("created[gt]"), num("created[lte]"), num("created[lt]")];
    const rows = all.filter((i) => {
      const at = Number(i.created);
      return (!q.get("status") || i.status === q.get("status")) && (gte === null || at >= gte) && (gt === null || at > gt) && (lte === null || at <= lte) && (lt === null || at < lt);
    });
    const after = q.get("starting_after");
    const from = after ? rows.findIndex((i) => i.id === after) + 1 : 0;
    if (after && from === 0) return answer({ error: { message: "No such invoice" } }, 400);
    const limit = Number(q.get("limit") ?? 10);
    return answer({ object: "list", data: rows.slice(from, from + limit), has_more: from + limit < rows.length });
  }
  if (path === "/refunds" && refundsUnreadable) return answer({ object: "list", has_more: false });
  if ((init?.method ?? "GET") === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({}, 404);
}) as typeof fetch;

const inv = (id: string, at: number, meta: Record<string, string>, status = "paid", taxes: unknown = []) => ({
  id, object: "invoice", status, billing_reason: "subscription_cycle", amount_paid: status === "paid" ? 2000 : 0, currency: "usd", customer_email: "m@example.com",
  created: at, status_transitions: { paid_at: status === "paid" ? at : null }, total_taxes: taxes,
  parent: { subscription_details: { metadata: { store: "harbor", ...meta } } },
  payments: { object: "list", has_more: false, data: status === "paid" ? [{ object: "invoice_payment", status: "paid", payment: { type: "payment_intent", payment_intent: `pi_${id}` } }] : [] },
});

async function setUp(): Promise<{ product: string; terms: Record<string, string> }> {
  redis.clear();
  shift = 0;
  invoicesUnreadable = false;
  refundsUnreadable = false;
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  const club = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30, recurring: RECURRING_ALWAYS, hold: 0, payday: new Date().getUTCDate() });
  const store = (await storeForEmail(OWNER))!;
  await redis.pipeline([
    ["HSET", `nl:aff:${store.statsId}:people`, SARA, JSON.stringify({ id: SARA, email: "sara@example.com", paypal: "sara.pay@example.com", code: "sara", status: "approved", appliedAt: (NOW - 400 * DAY) * 1000, decidedAt: 1, note: "" })],
    // A sale by click Sara is owed on, so the batch has a line whatever the invoices say.
    ["HSET", `nl:aff:${store.statsId}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff: SARA, at: NOW - 100 * DAY, product: "prod01", title: "Bread course", base: 10000, total: 10000, currency: "usd", rate: 30, self: false, how: "click" })],
  ]);
  return { product: club.product.id, terms: { product: club.product.id, via: SARA, via_rate: "30", via_months: String(RECURRING_ALWAYS), via_at: String(NOW - 300 * DAY) } };
}

const owner = async () => `${SESSION_COOKIE}=${await openSession(OWNER)}`;
async function download(provider = "paypal"): Promise<{ status: number; body: string }> {
  const response = await downloadBatch(new NextRequest(`https://marktmorgen.com/api/store/affiliates/payout-batch?provider=${provider}`, { headers: { cookie: await owner() } }));
  return { status: response.status, body: await response.text() };
}
async function confirm(): Promise<{ status: number; error?: string }> {
  const response = await recordBatch(new NextRequest("https://marktmorgen.com/api/store/affiliates/payout-batch", { method: "POST", headers: { "content-type": "application/json", cookie: await owner() }, body: JSON.stringify({ date: new Date().toISOString().slice(0, 10), reference: "PayPal batch 1" }) }));
  return { status: response.status, error: ((await response.json()) as { error?: string }).error };
}
const ADDRESS = /sara\.pay@example\.com/;

const row = {
  affiliate: { id: SARA, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" },
  clicks: 1, sales: 1, earned: 3000, paid: 0, owed: 3000, waiting: 0, payable: 3000, held: 0, flags: [], paidClicks: 0, link: "https://example.com/?via=sara",
};
function studio(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never },
    createElement(AffiliateStudio, {
      handle: "harbor", setting: parseAffiliateSetting({ enabled: true }), products: [], rows: [row] as never, lines: [], payouts: [],
      refundsChecked: true, invoicesChecked: true, today: "2026-11-09", pendingPayoutsChecked: true, payPanel: createElement("span", null, "Provider controls"),
      ...props,
    } as never)));
}

async function main(): Promise<void> {
  part("HIGH: invoices not all read — the GET refuses as the POST does, with no line handed out");
  await setUp();
  invoicesUnreadable = true;
  const first = await download();
  is("GET: 409, no address in what is answered", [first.status, ADDRESS.test(first.body)], [409, false]);
  is("GET says why, in the words the studio gives the POST's refusal", /membership and plan payment/.test(first.body), true);
  is("POST: 409 invoices", await confirm(), { status: 409, error: "invoices" });
  const again = await download("worksheet");
  is("GET again (worksheet): still 409, no address", [again.status, ADDRESS.test(again.body)], [409, false]);
  invoicesUnreadable = false;
  const healthy = await download();
  is("healthy control: read whole, the file is handed out with Sara's line", [healthy.status, ADDRESS.test(healthy.body)], [200, true]);

  part("HIGH, the sibling: refunds not all read — the GET refuses as the POST does");
  await setUp();
  refundsUnreadable = true;
  const refunds = await download();
  is("GET: 409, no address", [refunds.status, ADDRESS.test(refunds.body)], [409, false]);
  is("GET says refunds could not all be checked", /refund/i.test(refunds.body), true);
  is("POST: 409 refunds", await confirm(), { status: 409, error: "refunds" });
  refundsUnreadable = false;

  part("HIGH: the studio does not offer the batch files on a book the confirmation would refuse");
  const offered = /PayPal Payouts file|Worksheet for Wise|I have paid this batch/;
  is("whole: the files are offered (control)", offered.test(studio({})), true);
  const noInvoices = studio({ invoicesChecked: false });
  is("invoices not all read: no file offered", offered.test(noInvoices), false);
  is("and it says why", /membership and plan payment/.test(noInvoices), true);
  const noRefunds = studio({ refundsChecked: false });
  is("refunds not all read: no file offered", offered.test(noRefunds), false);
  is("the full export and the provider panel stay", [/Download everything/.test(noInvoices), /Provider controls/.test(noInvoices)], [true, true]);

  part("MEDIUM: past the kept invoices' ceiling, the book says so, every reading after, while it is still past it");
  const { terms } = await setUp();
  all = [];
  for (let i = 0; i <= INVOICES_KEPT_MAX_LINES; i += 1) all.push(inv(`in_Many${String(i).padStart(7, "0")}`, NOW - 1000 - i, terms));
  const store = (await storeForEmail(OWNER))!;
  const states: string[] = [];
  for (let n = 0; n < 16; n += 1) {
    const book = await readBook(store);
    states.push(`${book.invoicesChecked ? "whole" : "short"}${book.invoicesPastCeiling ? "+ceiling" : ""}`);
  }
  const at = states.indexOf("short+ceiling");
  is("it comes to say past the ceiling", at >= 0, true);
  is("never whole, and past the ceiling on every reading after it first said so", states.slice(at).every((s) => s === "short+ceiling") && !states.includes("whole"), true);
  const ceilingGet = await download();
  is("GET: 409, no address", [ceilingGet.status, ADDRESS.test(ceilingGet.body)], [409, false]);
  is("GET: reloading will not help, and paying by hand still works", [/try again in a moment/i.test(ceilingGet.body), /will not/.test(ceilingGet.body), /Mark as paid/.test(ceilingGet.body)], [false, true, true]);
  is("POST: 409 invoices_ceiling", await confirm(), { status: 409, error: "invoices_ceiling" });
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("PayPal stand-in not connected");
  payouts.length = 0;
  is("the PayPal press: nothing sent, the ceiling given as the reason", await payWithPayPal(store), { ok: false, reason: "invoices_ceiling" });
  is("no payout asked of PayPal", payouts.length, 0);
  const auto = autoPayEmail({ ok: false, reason: "invoices_ceiling" } as Parameters<typeof autoPayEmail>[0], "usd");
  is("the PayPal email names the ceiling, no promise of a retry", [/more membership and plan payments/.test(auto.text), /try again/i.test(auto.text)], [true, false]);
  const payday = paydayEmail({ storeName: "Harbor", payday: 5, people: 1, totalCents: 100, currency: "usd", waitingCents: 0, hold: 0, refundsChecked: true, invoicesChecked: false, invoicesPastCeiling: true } as Parameters<typeof paydayEmail>[0]);
  is("the payday email: reloading will not help, pay by hand", [/reads them again each time/.test(payday.text), /will not/.test(payday.text), /Mark as paid/.test(payday.text)], [false, true, true]);
  const ceilingStudio = studio({ invoicesChecked: false, invoicesPastCeiling: true });
  is("the studio: no file, reloading will not help, Mark as paid", [offered.test(ceilingStudio), /will not/.test(ceilingStudio), /Mark as paid/.test(ceilingStudio)], [false, true, true]);
  const history = renderToStaticMarkup(createElement(AffiliateCommissionHistory, { lines: [], total: 0, who: {}, refundsChecked: true, invoicesChecked: false, invoicesPastCeiling: true } as never));
  is("the commission history does not say reload to try again", [/reload to try again/.test(history), /will not/.test(history)], [false, true]);

  part("MEDIUM: back under the ceiling, the book reads whole again and no longer says so");
  all.pop();
  let back = { whole: false, ceiling: true };
  for (let n = 0; n < 16 && !back.whole; n += 1) {
    const book = await readBook(store);
    back = { whole: book.invoicesChecked, ceiling: Boolean(book.invoicesPastCeiling) };
  }
  is("whole, not past the ceiling", back, { whole: true, ceiling: false });
  const fits = await download();
  is("and the file is handed out", [fits.status, ADDRESS.test(fits.body)], [200, true]);

  part("LOW: a daily reading again that ends on an invoice it cannot read does not say whole");
  const { terms: t2 } = await setUp();
  all = [];
  for (let i = 0; i < 1000; i += 1) all.push(inv(`in_Other${String(i).padStart(6, "0")}`, NOW - 1000 - i, { product: t2.product }));
  const late = inv("in_SaraLate001", NOW - 150 * DAY, t2, "open");
  all.push(late);
  for (let i = 0; i < 50; i += 1) all.push(inv(`in_Sara0${String(i).padStart(6, "0")}`, NOW - 200 * DAY - i, t2));
  const s2 = (await storeForEmail(OWNER))!;
  let whole = false;
  for (let n = 0; n < 6 && !whole; n += 1) whole = (await readBook(s2)).invoicesChecked;
  is("whole before the late payment", whole, true);
  // Paid late, with a tax that does not read: the reading again cannot count it.
  all[all.indexOf(late)] = inv("in_SaraLate001", NOW - 150 * DAY, t2, "paid", null);
  shift = 2 * DAY * 1000;
  const wrong: number[] = [];
  for (let n = 0; n < 6; n += 1) {
    const book = await readBook(s2);
    const [raw] = (await redis.pipeline([["GET", `nl:aff:${s2.statsId}:invoices`]])) as (string | null)[];
    const kept = raw ? (JSON.parse(raw) as { kept?: { whole?: boolean } | null; walk?: unknown }) : null;
    // A reading after which what is kept says it was not read whole never says the book was.
    if (kept?.kept?.whole === false && book.invoicesChecked) wrong.push(n);
  }
  is("no reading says whole once what it kept is not", wrong, []);

  part("LOW: the public API and MCP say when invoices were not all read");
  await setUp();
  invoicesUnreadable = true;
  const s3 = (await storeForEmail(OWNER))!;
  const api = (await apiAffiliates(s3, async () => null)) as { invoices_checked?: unknown; refunds_checked?: unknown };
  is("/api/v1/affiliates: invoices_checked false", [api.invoices_checked, api.refunds_checked], [false, true]);
  const mcp = (await affiliatesTool(s3, async () => null)) as { invoices_checked?: unknown };
  is("get_affiliates: invoices_checked false", mcp.invoices_checked, false);
  invoicesUnreadable = false;
  const apiFine = (await apiAffiliates(s3, async () => null)) as { invoices_checked?: unknown };
  is("and true when they were", apiFine.invoices_checked, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
