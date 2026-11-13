/**
 * A product update (lib/product-updates.ts, advanceUpdate) whose batch loses one SES answer (Claude 7 on #4361):
 * held as "retry" until the "may have gone" marks ran out, the job either failed after five tries ("Nothing more was
 * sent", which was not true) or, two days on, sent the batch to everybody in it a second time. Now the call that lost
 * the answer is retried once, the next one finishes the batch, and the job ends sent, each buyer handed over once.
 * Synthetic only: the Redis stub, the SES mail fixture and a stand-in Stripe list.
 */
import { advanceUpdate, readUpdateJob, startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const buyers = ["ann@example.test", "ben@example.test", "cal@example.test"];
let productId = "";
const mail = installSesMailFixture({
  fallback: async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    const data = url.pathname === "/v1/checkout/sessions" ? buyers.map((email, i) => ({
      id: `cs_update_lost_${i}`, object: "checkout.session", status: "complete", payment_status: "paid",
      created: Math.floor(Date.now() / 1000) - 86_400, amount_total: 2700, currency: "usd",
      customer_details: { email }, metadata: { store: "updatelost", product: productId },
    })) : [];
    return Response.json({ object: "list", data, has_more: false });
  },
});
const to = (address: string) => mail.sesAttempts.filter((m) => m.to.includes(address)).length;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  delete process.env.RESEND_API_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  const owner = "update-lost@example.test";
  await claimHandle(owner, "updatelost", "Update Lost", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_UpdateLost", subscriptionId: "sub_UpdateLost", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Update Lost", address: "1 Example St, Example City" });
  const made = await addProduct(owner, "Update evidence", "", "27", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/update");
  const shop = (await storeForEmail(owner))!;
  const started = await startUpdate(shop, (await readListing(shop, productId))!, "A verified update");
  if (!started.ok) throw new Error(JSON.stringify(started));
  const id = started.job.id;

  part("One SES answer lost in the update's batch");
  mail.setSesOutcome(["ok", "lost", "ok"]);
  const first = await advanceUpdate(id, storeForHandle, Date.now() + 20_000);
  is("the job is still sending, never failed", first?.status, "sending");
  mail.setSesOutcome("ok");

  part("The worker tries again: the job ends sent, each buyer handed over once");
  let job = first;
  for (let run = 0; run < 6 && job?.status === "sending"; run += 1) {
    redis.advance(5 * 60_000);
    job = await advanceUpdate(id, storeForHandle, Date.now() + 20_000);
  }
  is("the job is sent", job?.status, "sent");
  is("each buyer was handed over once, the one whose answer was lost too", buyers.map(to), [1, 1, 1]);
  is("and the job says all three", (await readUpdateJob(id))?.sent, 3);

  part("Two days on, nothing goes again");
  redis.advance(2 * 86_400_000 + 60_000);
  await advanceUpdate(id, storeForHandle, Date.now() + 20_000);
  is("still once each", buyers.map(to), [1, 1, 1]);
  done();
}

void main();
