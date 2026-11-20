/**
 * Outage drill (Claude 7, 13 November 2026; synthetic only): the email provider is down (Resend answers
 * 503) for five consecutive runs of the mail cron (every 5 minutes, so about
 * 25 minutes). A product-update email must wait in its queue and go out once
 * the provider is back; it must never be abandoned because the provider was
 * down.
 */
import { advanceUpdate, readUpdateJob, startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const REGION = "us-east-1";
let providerDown = true;
const delivered: string[] = [];
let sessions: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.hostname === `email.${REGION}.amazonaws.com`) {
    // Amazon SES down: every question about the account answers 503, so nothing is handed over.
    if (providerDown) return json({ message: "Service Unavailable" }, 503);
    if (url.pathname === "/v2/email/account") {
      return json({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 10, SentLast24Hours: 0 } });
    }
    if (url.pathname === "/v2/email/outbound-emails") {
      const body = JSON.parse(String(init?.body)) as { Destination: { ToAddresses: string[] } };
      delivered.push(body.Destination.ToAddresses[0]);
      return json({ MessageId: `m-${delivered.length}` });
    }
    return json({}, 404);
  }
  if (url.hostname === `sts.${REGION}.amazonaws.com`) {
    const credentials = { AccessKeyId: "ASIAEXAMPLEDRILL0001", SecretAccessKey: "drill-secret-0000000000000000000000000000", SessionToken: "drill-token", Expiration: Math.floor(Date.now() / 1000) + 3_600 };
    return json({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: credentials } } });
  }
  if (url.hostname === "api.resend.com") return json({ message: "not used here" }, 503);
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

  part("No sender for five cron runs, then Amazon SES, then back");
  for (let run = 1; run <= 5; run += 1) await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  const during = await readUpdateJob(started.job.id);
  is("after five failed runs the update still waits (not failed)", during?.status === "failed" ? `failed: ${during.note}` : "waiting", "waiting");
  providerDown = false;
  process.env.AWS_SES_REGION = REGION;
  process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen";
  process.env.AWS_SES_TOPIC_ARN = `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`;
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-drill";
  process.env.VERCEL_OIDC_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";
  // Amazon's account state is kept for a while (lib/ses.ts); the drill moves past it rather than waiting.
  for (const key of redis.keys()) if (key.startsWith("nl:ses:")) await redis.pipeline([["DEL", key]]);
  await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  is("once the provider is back, the email goes out", delivered, ["ana@example.com"]);
  is("and the update is finished, once", (await readUpdateJob(started.job.id))?.status, "sent");

  part("The other list senders end only on a refusal, never after a count of outages");
  const { readFileSync } = await import("node:fs");
  for (const file of ["lib/product-updates.ts", "lib/community-mail.ts", "lib/community-event-mail.ts", "lib/broadcasts.ts"]) {
    is(`${file} has no cap that turns an outage into a failure`, /failures\s*>=\s*\d/.test(readFileSync(file, "utf8")), false);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
