/**
 * The payout file (GET app/api/store/affiliates/payout-batch) reads the book
 * without naming any product: the file has no product column (lib/affiliate-
 * payouts.ts batchFile), so neither a card nor a listing is read for it
 * (readBook's `titles: false`; sibling-routes cost study of 7 November 2026,
 * P1). Checked on the real route, synthetic data only:
 *
 *   - the GET reads no card hash and no listing record for the invoices' products;
 *   - healthy control: the file is byte for byte the one the book read with its
 *     titles gives, for both providers;
 *   - the book read with titles (the spreadsheet, the studio, the POST that
 *     records a batch) still names every payment.
 */
import { NextRequest } from "next/server";
import { readBook } from "@/lib/affiliates";
import { batchFile } from "@/lib/affiliate-payouts";
import { onTheirWay, payableLines } from "@/lib/paypal-payouts";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { GET as batchRoute } from "@/app/api/store/affiliates/payout-batch/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_payout_batch_titles_stand_in";

const OWNER = "owner@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const SARA = "0123456789ab";
const PRODUCTS = 30;

let invoices: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === "/invoices") return answer({ object: "list", data: invoices, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

let seen: (string | number)[][] = [];
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  seen.push(...commands);
  return original(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "creator", period: paidPeriod() });
  const ids: string[] = [];
  for (let i = 0; i < PRODUCTS; i += 1) {
    const made = await addProduct(OWNER, `Supper Club ${i}`, "", "20", { interval: "month", trialDays: 0, payments: 0 });
    if (!made.ok) throw new Error("no product");
    ids.push(made.product.id);
  }
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30, recurring: 12 });
  const store = (await storeForEmail(OWNER))!;
  const cat = store.catalog.id!;
  await redis.pipeline([
    ["HSET", `nl:aff:${store.statsId}:people`, SARA, JSON.stringify({ id: SARA, email: "sara@example.com", paypal: "sara.pay@example.com", code: "sara", status: "approved", appliedAt: (NOW - 400 * DAY) * 1000, decidedAt: 1, note: "" })],
  ]);
  invoices = ids.map((product, i) => ({
    id: `in_Batch${String(i).padStart(7, "0")}`,
    status: "paid",
    amount_paid: 2000,
    currency: "usd",
    customer_email: "member@example.com",
    created: NOW - 10 * DAY - i,
    status_transitions: { paid_at: NOW - 10 * DAY - i },
    total_taxes: [],
    parent: { subscription_details: { metadata: { store: "harbor", product, via: SARA, via_rate: "30", via_months: "12", via_at: String(NOW - 30 * DAY) } } },
    payments: { data: [{ payment: { type: "payment_intent", payment_intent: `pi_batch_${i}` } }] },
  }));
  const session = await openSession(OWNER);
  const download = async (provider: string) => {
    const response = await batchRoute(new NextRequest(`https://marktmorgen.com/api/store/affiliates/payout-batch?provider=${provider}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
    return { status: response.status, body: await response.text() };
  };
  const named = (command: (string | number)[]) => String(command[1]) === `nl:catalog:${cat}:t` || String(command[1]).startsWith(`nl:catalog:${cat}:l:`);

  part("The book with its titles still names every payment");
  const book = await readBook(store);
  is("every payment named after its product", book.lines.filter((l) => l.how === "recurring").every((l) => /^Supper Club \d+$/.test(l.title)), true);
  const away = await onTheirWay(store);
  const want = (provider: "paypal" | "worksheet") => batchFile(provider, payableLines(book, away), store, new Date().toISOString().slice(0, 10)).body;

  for (const provider of ["paypal", "worksheet"] as const) {
    part(`The payout file (${provider})`);
    seen = [];
    const got = await download(provider);
    is("answered with the file", got.status, 200);
    is("byte for byte the file the book with its titles gives", got.body, want(provider));
    is("no card and no listing read for it", seen.filter(named).map((c) => `${c[0]} ${String(c[1]).split(":").slice(3).join(":")}`), []);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
