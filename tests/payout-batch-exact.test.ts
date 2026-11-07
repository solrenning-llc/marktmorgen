/**
 * The payout file (GET app/api/store/affiliates/payout-batch) is made only
 * from a book whose Stripe reads were complete, and the batch is written down
 * (POST) only from one too (rule 24: an unknown answer fails closed).
 *
 * The file is what the creator pays from, in their own PayPal or Wise. A file
 * made while the refunds or the disputes could not be read pays commission on
 * sales that may have been refunded; one made while the membership and plan
 * invoices could not all be read (a Stripe error, or the INVOICE_PAGES limit)
 * leaves payments out or gets amounts wrong. Either way the money has left
 * the creator before anything here could refuse. Checked on the real route,
 * synthetic data only:
 *
 *   (a) the refunds, or the disputes, cannot be read: no file (503);
 *   (b) the invoices cannot all be read, by an error or by the page limit: no file (503);
 *   (c) healthy control: the file is byte for byte the one the book gives, under the same name;
 *   POST: the invoices cannot all be read: nothing is written down (409), as with the refunds.
 */
import { NextRequest } from "next/server";
import { INVOICE_PAGES, readBook } from "@/lib/affiliates";
import { batchFile } from "@/lib/affiliate-payouts";
import { onTheirWay, payableLines } from "@/lib/paypal-payouts";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { GET as batchRoute, POST as recordRoute } from "@/app/api/store/affiliates/payout-batch/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_payout_batch_exact_stand_in";

const OWNER = "owner@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const SARA = "0123456789ab";

type Mode = "healthy" | "refunds-fail" | "disputes-fail" | "invoices-fail" | "invoices-endless";
let mode: Mode = "healthy";
let invoices: Record<string, unknown>[] = [];
let invoicePages = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const broken = () => answer({ error: { type: "api_error", message: "stand-in outage" } }, 500);
  if (path === "/invoices") {
    if (mode === "invoices-fail") return broken();
    invoicePages += 1;
    // Every page says there is more: the read stops at INVOICE_PAGES, incomplete.
    if (mode === "invoices-endless") return answer({ object: "list", data: invoices.map((inv) => ({ ...inv, id: `${inv.id}p${invoicePages}` })), has_more: true });
    return answer({ object: "list", data: invoices, has_more: false });
  }
  if (path === "/refunds" && mode === "refunds-fail") return broken();
  if (path === "/disputes" && mode === "disputes-fail") return broken();
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("no product");
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30, recurring: 12 });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, SARA, JSON.stringify({ id: SARA, email: "sara@example.com", paypal: "sara.pay@example.com", code: "sara", status: "approved", appliedAt: (NOW - 400 * DAY) * 1000, decidedAt: 1, note: "" })],
    // A one-off sale, so Sara is owed something even when no invoice can be read.
    ["HSET", `nl:aff:${statsId}:sales`, "cs_one", JSON.stringify({ ref: "cs_one", pi: "pi_one", aff: SARA, at: NOW - 20 * DAY, product: made.product.id, title: "Supper Club", base: 5000, total: 5000, currency: "usd", rate: 30, self: false, how: "click" })],
  ]);
  invoices = [0, 1, 2].map((i) => ({
    id: `in_Exact${String(i).padStart(7, "0")}`,
    status: "paid",
    amount_paid: 2000,
    currency: "usd",
    customer_email: "member@example.com",
    created: NOW - 10 * DAY - i,
    status_transitions: { paid_at: NOW - 10 * DAY - i },
    total_taxes: [],
    parent: { subscription_details: { metadata: { store: "harbor", product: made.product.id, via: SARA, via_rate: "30", via_months: "12", via_at: String(NOW - 30 * DAY) } } },
    payments: { data: [{ payment: { type: "payment_intent", payment_intent: `pi_exact_${i}` } }] },
  }));
  const session = await openSession(OWNER);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const download = async (provider: string) => {
    invoicePages = 0;
    const response = await batchRoute(new NextRequest(`https://marktmorgen.com/api/store/affiliates/payout-batch?provider=${provider}`, { headers: { cookie } }));
    return { status: response.status, body: await response.text(), disposition: response.headers.get("content-disposition") ?? "", type: response.headers.get("content-type") ?? "" };
  };
  const record = async () => {
    const response = await recordRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/payout-batch", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ date: new Date().toISOString().slice(0, 10), reference: "PayPal batch 1" }) }));
    return { status: response.status, data: (await response.json()) as { ok?: boolean; error?: string; written?: number } };
  };
  const payoutsWritten = async () => {
    const [all] = await redis.pipeline([["HGETALL", `nl:aff:${statsId}:payouts`]]);
    return Array.isArray(all) ? all.length / 2 : all && typeof all === "object" ? Object.keys(all).length : 0;
  };

  part("(c) Healthy control: the file is the one the book gives");
  mode = "healthy";
  const book = await readBook(store);
  is("the book read in full", book.refundsChecked && book.invoicesChecked, true);
  const away = await onTheirWay(store);
  const day = new Date().toISOString().slice(0, 10);
  for (const provider of ["paypal", "worksheet"] as const) {
    const want = batchFile(provider, payableLines(book, away), store, day);
    const got = await download(provider);
    is(`${provider}: answered with the file`, got.status, 200);
    is(`${provider}: byte for byte the file the book gives`, got.body, want.body);
    is(`${provider}: under the same name`, got.disposition, `attachment; filename="${want.filename}"`);
    is(`${provider}: as a CSV`, got.type, "text/csv; charset=utf-8");
  }

  const refused: { mode: Mode; why: string }[] = [
    { mode: "refunds-fail", why: "(a) the refunds cannot be read" },
    { mode: "disputes-fail", why: "(a) the disputes cannot be read" },
    { mode: "invoices-fail", why: "(b) the invoices answer with an error" },
    { mode: "invoices-endless", why: "(b) the invoices run past INVOICE_PAGES" },
  ];
  for (const { mode: next, why } of refused) {
    part(`${why}: no file`);
    mode = next;
    for (const provider of ["paypal", "worksheet"] as const) {
      const got = await download(provider);
      is(`${provider}: refused as unavailable`, got.status, 503);
      is(`${provider}: no file to save`, got.disposition, "");
      is(`${provider}: nobody's address in the answer`, /sara/.test(got.body), false);
      is(`${provider}: says so plainly`, /no file was made/i.test(got.body), true);
    }
    if (next === "invoices-endless") is("the page limit was what stopped the read", invoicePages >= INVOICE_PAGES, true);
  }

  part("POST: nothing written down while the invoices cannot all be read");
  for (const next of ["invoices-fail", "invoices-endless"] as const) {
    mode = next;
    const got = await record();
    is(`${next}: refused`, got.status, 409);
    is(`${next}: named as the invoices`, got.data.error, "invoices");
    is(`${next}: no payout written`, await payoutsWritten(), 0);
  }
  mode = "refunds-fail";
  const refunds = await record();
  is("refunds unread: still refused as before", [refunds.status, refunds.data.error], [409, "refunds"]);
  is("refunds unread: no payout written", await payoutsWritten(), 0);

  part("POST: a book read in full is written down as before");
  mode = "healthy";
  const recorded = await record();
  is("written down", [recorded.status, recorded.data.ok, recorded.data.written], [200, true, 1]);
  is("one payout", await payoutsWritten(), 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
