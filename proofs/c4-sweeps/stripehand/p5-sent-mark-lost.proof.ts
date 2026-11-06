/**
 * P5. lib/purchase-email.ts confirmOnce (~:508-525) with lib/email.ts viaAmazon's once-key (~:320-338). The receipt
 * goes out through SES, which claims nimbus-confirm:<session> for 24 hours. If the "sent" mark that follows is lost
 * (the SET times out), the "sending" mark expires in 15 minutes; every later pass claims again, SES refuses the
 * repeat (once-key held), sendEmail answers false, the mark is deleted and the pass says "failed", for the whole
 * 24-hour window. countOrder and settleAdmitted, which run only on "sent", never run: the order is never counted.
 * Real MemoryRedis, real store, SES stand-in; one SET throws.
 */
import { confirmPurchase } from "@/lib/purchase-email";
import { createHash } from "node:crypto";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis, advance } from "@/tests/redis-stub";
import { paidPeriod } from "@/tests/billing-period-fixture";
import { installSesMailFixture } from "@/tests/ses-mail-fixture";

const mail = installSesMailFixture({ fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })) });

async function main() {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_proof_only";
  const OWNER = "sent-mark@example.com";
  await claimHandle(OWNER, "sentmark", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSentMk1", true);
  await setSubscription(OWNER, { customerId: "cus_SentMk1", subscriptionId: "sub_SentMk1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const p = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!p.ok) throw new Error("no product");
  await setProductLink(OWNER, p.product.id, "https://example.com/course");
  const store = (await storeForEmail(OWNER))!;
  const counted = (id: string) => redis.run(["EXISTS", `nl:orders:seen:${createHash("sha256").update(`checkout:${id}`).digest("hex").slice(0, 32)}`]) === 1;
  const receipts = (id: string) => mail.ses.filter((m) => String(m.to).includes(`${id.slice(8, 20)}@`)).length;
  const session = (id: string) => ({
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - 60, amount_total: 4900, currency: "usd",
    customer_details: { email: `${id.slice(8, 20)}@example.com` }, metadata: { store: "sentmark", product: p.product.id },
  });

  const ok = "cs_test_sentmarkctl000001";
  console.log(`control: outcome=${await confirmPurchase(store, ok, session(ok) as never)} ordersCounted=${counted(ok)} receipts=${receipts(ok)}`);

  const id = "cs_test_sentmarklost00001";
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (c: (string | number)[][]) => {
    if (c[0]?.[0] === "SET" && c[0]?.[1] === `nl:confirm:${id}` && c[0]?.[2] === "sent") throw new Error("Redis request timed out");
    return real(c);
  }) as typeof redis.pipeline;
  const first = await confirmPurchase(store, id, session(id) as never).catch((e: Error) => `threw ${e.message}`);
  redis.pipeline = real;
  console.log(`receipt sent, its "sent" mark lost: first=${first} receipts=${receipts(id)} ordersCounted=${counted(id)}`);
  for (let pass = 1; pass <= 3; pass += 1) {
    advance(16 * 60 * 1000);
    const outcome = await confirmPurchase(store, id, session(id) as never).catch((e: Error) => `threw ${e.message}`);
    console.log(`  pass ${pass} (16 min later): outcome=${outcome} receipts=${receipts(id)} ordersCounted=${counted(id)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
