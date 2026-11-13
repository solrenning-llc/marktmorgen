/**
 * The low-stock job tells the creator only on a count it could read (623
 * [SZ7], Claude 1's MEDIUM on #3814, confirmed by Codex L and cloud E). The
 * mail job wired the check to stockLeft, which counts a lapsed hold whose
 * checkout Stripe could not answer for as sold: the safe way to be wrong for
 * selling, never proof of a sale. Read as units left, that guess crossed the
 * creator's number and sent the alert and the email for a sale that never
 * happened, and kept the guessed count as the one seen. The job now reads
 * the units left as lib/stock.ts reads them where something is decided
 * (stockLeftKnown): unknown, so nothing is sent or kept and the product waits
 * for its next check.
 *
 * Real job, stock count and low-stock records against tests/redis-stub.ts;
 * Stripe and Resend stand-ins. Synthetic data only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductExtras, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { LOW_STOCK_DUE, lowStockOf, setLowStock } from "@/lib/low-stock";
import * as alert from "@/lib/low-stock-alert";
import { type LowStockDeps, runLowStockChecks } from "@/lib/low-stock-alert";
import { readListing } from "@/lib/catalog";
import { storeForIdExactly } from "@/lib/store-exact";
import { stockLeft } from "@/lib/stock";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

// The same synthetic key as tests/store-alerts.test.ts: the Resend fixture takes only listed literals.
process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_low_stock_guessed";

const OWNER = "guess.owner@example.com";
const emails: string[] = [];
let stripeAnswers = true;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push((JSON.parse(String(init?.body)) as { subject: string }).subject);
    return new Response(JSON.stringify({ id: `email_${emails.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") {
    // A lapsed hold's checkout: Stripe does not answer, or says it expired unpaid.
    if (!stripeAnswers) return new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 500 });
    return new Response(JSON.stringify({ id: url.pathname.split("/").pop(), object: "checkout.session", status: "expired", payment_status: "unpaid" }), { status: 200 });
  }
  throw new Error(`Only synthetic calls: ${url.hostname}`);
}) as typeof fetch;

/** What the mail job hands the check: the job's own wiring, or, before it had one, the route's (left: stockLeft). */
const lowStockJobDeps: LowStockDeps = (alert as { lowStockJobDeps?: LowStockDeps }).lowStockJobDeps ?? { load: storeForIdExactly, readProduct: readListing, left: (s, p) => stockLeft(s, p) };

async function main(): Promise<void> {
  part("The mail job hands the check the job's own wiring");
  const route = readFileSync("app/api/cron/mail/route.ts", "utf8");
  is("the route runs the check with lowStockJobDeps", /runLowStockChecks\(deadline, lowStockJobDeps\)/.test(route), true);

  redis.clear();
  await claimHandle(OWNER, "guessstock", "Guess Goods", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGuessLw1", true);
  await setSubscription(OWNER, { customerId: "cus_guess", subscriptionId: "sub_guess", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Glazed Mug", "", "30", null);
  if (!made.ok) throw new Error("no product");
  const pid = made.product.id;
  await setProductExtras(OWNER, pid, { stock: 6 });
  const store = (await storeForEmail(OWNER)) as Store;
  const sid = store.statsId!;
  const member = `${store.sid}|${pid}`;
  is("a number of 5, with 6 left", await setLowStock(store, pid, 5, 6), "saved");

  part("A hold that ran out, whose checkout Stripe cannot answer for");
  redis.run(["HSET", `nl:stock:${sid}:${pid}`, "cs_test_lapsedHold0001", JSON.stringify({ until: Date.now() - 60_000 })]);
  redis.run(["ZADD", LOW_STOCK_DUE, 0, member]);
  stripeAnswers = false;
  is("nobody is told on a guessed count", await runLowStockChecks(Date.now() + 30_000, lowStockJobDeps), 0);
  is("no email", emails, []);
  is("the count seen stays the one read", (await lowStockOf(store, pid))?.seen, 6);
  is("the product waits for its next check", redis.run(["ZSCORE", LOW_STOCK_DUE, member]) !== null, true);

  part("Stripe answers: the hold expired unpaid, 6 left, nobody told");
  stripeAnswers = true;
  redis.run(["ZADD", LOW_STOCK_DUE, 0, member]);
  is("nothing crossed", await runLowStockChecks(Date.now() + 30_000, lowStockJobDeps), 0);
  is("still no email", emails, []);
  done();
}

void main();
