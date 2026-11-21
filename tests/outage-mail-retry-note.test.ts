/**
 * Outage drill (Claude 7, 13 November 2026; synthetic only): what the studio says while no sender takes a list
 * email's batch (Amazon SES not there, Resend without its proven review: every batch answers "retry"). The batch was
 * not refused, and the service may never have asked anybody to slow down: the note says it was not taken just now and
 * is tried again by itself, the same words in each of the four list senders (lib/mail.ts, SENDER_RETRY_NOTE).
 */
import { advanceUpdate, readUpdateJob, startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { SENDER_RETRY_NOTE } from "@/lib/mail";
import { readFileSync } from "node:fs";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
let sessions: Record<string, unknown>[] = [];
// Stripe's checkouts for the update's recipients; no email service is reached (Amazon SES is not configured, and
// Resend, without its proven review, is not a route).
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ message: "not used here" }), { status: 503 });
  const path = url.pathname.replace(/^\/v1/, "");
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }));
  if (path === "/checkout/sessions") return list(sessions);
  return list([]);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_probe_only_a_stand_in";
  // While it is down, no sender can take it: Amazon SES is not there and Resend, without its proven review, is not
  // a route (lib/resend-fallback-transport.ts), so every batch answers "retry".
  process.env.RESEND_API_KEY = "re_test_drill_only_a_stand_in";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Jenny at Harbor", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(OWNER, "Weekly Meal Planner", "", "27", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  await setProductLink(OWNER, id, "https://example.com/planner");
  sessions = [{
    id: "cs_1", object: "checkout.session", status: "complete", payment_status: "paid",
    created: Math.floor(Date.now() / 1000) - 86_400, amount_total: 2700, currency: "usd",
    customer_details: { email: "ana@example.com" }, metadata: { store: "harbor", product: id },
  }];
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, id))!;
  const started = await startUpdate(store, product, "New chapter.");
  if (!started.ok) throw new Error(`not started: ${started.reason}`);

  part("No sender takes the batch");
  await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  const waiting = await readUpdateJob(started.job.id);
  is("the update is not sent and not refused", [waiting?.status, waiting?.done], ["sending", 0]);
  is("the studio is not told the service asked to slow down", /asked us to slow down/.test(waiting?.note ?? ""), false);
  is("it is told the batch was not taken just now and is tried again", waiting?.note, SENDER_RETRY_NOTE);

  part("The other list senders say the same");
  for (const file of ["lib/product-updates.ts", "lib/community-mail.ts", "lib/community-event-mail.ts", "lib/broadcasts.ts"]) {
    const source = readFileSync(file, "utf8");
    is(`${file} never says the email service asked us to slow down`, /email service asked us to slow down/.test(source), false);
    is(`${file} says SENDER_RETRY_NOTE`, source.includes("SENDER_RETRY_NOTE"), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
