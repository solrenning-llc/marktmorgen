/**
 * Pre-review proofs for claude5/paypal-removed-owed (synthetic only).
 * P1: an SES send whose acknowledgement is lost (uncertain) is taken as "not sent"; the claim is let go and the email
 *     is tried again inside the 3-day window. Once SES's one-day once-only marker runs out (its EX 86_400, here DEL),
 *     the creator gets a second email asking to refund the same payment.
 * P2: a repeat purchase (the address already holds the product through another grant) of a removed product is never
 *     marked owed: "sem entrega feita" holds for this order, yet nothing is owed and nobody is told.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { owePayPalRefund, refundOwed } from "@/lib/paypal-owed";
import { ownKey, type Paid } from "@/lib/paypal-sales";
import { importedKey } from "@/lib/imported-purchases";
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const REGION = "us-east-1";
const OWNER = "kiln@example.com";
const amazon: { to: string; subject: string }[] = [];
let lose = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.hostname === `email.${REGION}.amazonaws.com`) {
    if (url.pathname === "/v2/email/account") return json({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 100, SentLast24Hours: 0 } });
    if (url.pathname === "/v2/email/outbound-emails") {
      const body = JSON.parse(String(init?.body)) as { Destination: { ToAddresses: string[] }; Content: { Simple: { Subject: { Data: string } } } };
      amazon.push({ to: body.Destination.ToAddresses[0], subject: body.Content.Simple.Subject.Data });
      if (lose) throw new TypeError("synthetic: SES accepted it, the answer was lost");
      return json({ MessageId: `m-${amazon.length}` });
    }
    return json({}, 404);
  }
  if (url.hostname === `sts.${REGION}.amazonaws.com`) {
    const credentials = { AccessKeyId: "ASIAEXAMPLELENT1", SecretAccessKey: "lent-for-an-hour-and-never-stored-0000000", SessionToken: "session-token-1", Expiration: Math.floor(Date.now() / 1000) + 3_600 };
    return json({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: credentials } } });
  }
  if (url.hostname === "api.resend.com") return json({ name: "unexpected" }, 500);
  return json({}, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_floor_only_a_stand_in";
  process.env.AWS_SES_REGION = REGION;
  process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen";
  process.env.AWS_SES_TOPIC_ARN = `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`;
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-baseline";
  process.env.VERCEL_OIDC_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_kiln00002", subscriptionId: "sub_kiln00002", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const at = Math.floor(Date.now() / 1000);
  const paid = (order: string, email: string): Paid => ({ store: store.statsId!, order, capture: `CAP${order}`, email, product: "prod_gone_1", cents: 2900, currency: "USD", at, handle: "kilnworks" }) as Paid;

  part("P1: an uncertain SES send is retried after its one-day marker runs out: a second email to the creator");
  {
    const p = paid("7R190127TN3647301", "b1@example.com");
    lose = true;
    const first = await owePayPalRefund(store, p, at);
    lose = false;
    // Changed after the RED commit (rule 23): the proof expected "later" here, the branch's answer then (retried in 6
    // hours). The fix takes a false from sendEmail as unsure and never sends it again: the order is owed at once.
    is("first try: SES took it (answer lost), the order is owed and its email unsure", [first, amazon.filter((m) => m.to === OWNER).length, await refundOwed(store.statsId!, p.order)], ["owed", 1, "unsure"]);
    // The once-only marker of lib/email.ts lives 86_400 s; the window is 3 days. Its expiry, stood in for by DEL:
    const once = `nl:ses:once:${createHash("sha256").update(`nimbus-paypal-owed:${p.order}`).digest("hex").slice(0, 40)}`;
    is("the SES once-only marker exists after the uncertain send", redis.run(["GET", once]), "1");
    redis.run(["DEL", once]);
    const again = await owePayPalRefund(store, p, at + 25 * 3600);
    is("asked again 25 h later, once the marker ran out: the email is not sent again", [again, amazon.filter((m) => m.to === OWNER).length], ["owed", 1]);
  }

  part("P2: a repeat purchase of a removed product, this order never handed over");
  {
    const p = paid("7R190127TN3647302", "b2@example.com");
    // An earlier grant (another order, a gift or an import) holds the product; settle put this order behind it.
    await redis.pipeline([["HSET", importedKey(store.statsId!, p.email), p.product, JSON.stringify({ at: at - 86_400, job: "paypal:7R190127TN3647399", items: null })], ["SADD", ownKey(store.statsId!, p.email, p.product), p.order]]);
    const r = await owePayPalRefund(store, p, at);
    is("this order's own delivery never ran and the product is gone: owed (decision 2 'sem entrega feita')", [r, await refundOwed(store.statsId!, p.order)], ["owed", "told"]);
  }
  done();
}

void main();
