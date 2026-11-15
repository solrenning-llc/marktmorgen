/**
 * #4781, the coordinator's review: a product update's Redis commands for each email, measured on the code as it runs,
 * every script's own commands counted (the in-memory Redis runs each through run()). A run whose one batch holds one
 * recipient pays the batch alone: it must stay at or under UPDATE_EMAIL_COMMANDS, which the line
 * product-update-commands (tests/plan-cost-registry.ts) prices on every monthly email. Each further recipient of a
 * batch costs less. Synthetic store; Stripe and the email service are stand-ins.
 */
import { advanceUpdate, startUpdate } from "@/lib/product-updates";
import { UPDATE_EMAIL_COMMANDS } from "@/lib/product-updates-rules";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function measure(n: number): Promise<{ commands: number; sent: number }> {
  redis.clear();
  const owner = "update-owner@example.test";
  let productId = "";
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body));
      return Response.json({ data: batch.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) });
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    const data = url.pathname === "/v1/checkout/sessions" ? Array.from({ length: n }, (_, i) => ({
      id: `cs_update_${i}`, object: "checkout.session", status: "complete", payment_status: "paid",
      created: Math.floor(Date.now() / 1000) - 86400, amount_total: 2700, currency: "usd",
      customer_details: { email: `buyer${i}@example.test` }, metadata: { store: "vupdatecount", product: productId },
    })) : [];
    return Response.json({ object: "list", data, has_more: false });
  }) as typeof fetch;
  await claimHandle(owner, "vupdatecount", "V Update Count", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_UpdateCount", subscriptionId: "sub_UpdateCount", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "V Update Count", address: "1 Example St, Example City" });
  const made = await addProduct(owner, "Update count", "", "27", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/update");
  const shop = (await storeForEmail(owner))!;
  const product = (await readListing(shop, productId))!;
  const started = await startUpdate(shop, product, "A verified update");
  if (!started.ok) throw new Error(JSON.stringify(started));
  const run = redis.run.bind(redis);
  let commands = 0;
  redis.run = ((c: (string | number)[]) => { commands += 1; return run(c); }) as typeof redis.run;
  try {
    const job = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 60_000);
    return { commands, sent: job?.sent ?? 0 };
  } finally {
    redis.run = run;
  }
}

async function main(): Promise<void> {
  part("One email in a batch of its own: the dearest way, at or under UPDATE_EMAIL_COMMANDS");
  const one = await measure(1);
  console.log(`  one recipient: ${one.commands} commands`);
  is("sent", one.sent, 1);
  is(`at most ${UPDATE_EMAIL_COMMANDS} commands`, one.commands <= UPDATE_EMAIL_COMMANDS, true);
  part("Each further recipient of a batch costs less than one alone");
  const fifty = await measure(50);
  console.log(`  fifty recipients: ${fifty.commands} commands, ${(fifty.commands / 50).toFixed(2)} each`);
  is("all sent", fifty.sent, 50);
  is("each under the price of one alone", fifty.commands / 50 <= UPDATE_EMAIL_COMMANDS, true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
