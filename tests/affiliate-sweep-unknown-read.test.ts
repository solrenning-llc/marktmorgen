/**
 * An unknown bond or lead read never settles a swept checkout with no credit (Claude 6 on #4413, MEDIUM, money, rule
 * 24; Claude 4 agreeing).
 *
 * The sweep (lib/checkout-sweep.ts) marks a checkout settled for the day once noteSession returns. noteSession read
 * the buyer's bond and lead loosely: a bond reply in another shape read as "no bond", and a lead read that failed was
 * caught as "no lead". Either way noteSession returned with no credit, the sweep marked the session, and no later run
 * that day passed it on again: a bonded or lead buyer who never came back to the thanks page earned their affiliate
 * nothing, for good. An unknown read must throw, so the sweep leaves the order for the next run (failOrder) and does
 * not mark it; the next run, reading normally, credits it once.
 *
 * Real sweep on the in-memory Redis; Stripe's list stubbed; synthetic only.
 */
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { readBook } from "@/lib/affiliates";
import { rememberBuyer } from "@/lib/affiliate-bond";
import { recordLead } from "@/lib/affiliate-leads";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

let sessions: unknown[] = [];
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

const OWNER = "sweep-unknown@example.com";
const ANA = "aaaaaaaaaaa1";
const NOW = Math.floor(Date.now() / 1000);
const LEADS = { kind: "signup", cents: 500, hold: 30, daily: 10, budget: 50_000 };

const checkout = (id: string, email: string, product: string) => ({
  id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
  created: NOW - 60, amount_total: 5_000, amount_subtotal: 5_000, currency: "usd", total_details: { amount_tax: 0 },
  payment_intent: `pi_${id}`, customer_details: { email },
  metadata: { store: "sweepunknown", product, title: "Bread Course" },
  discounts: [],
});

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_conditions_only_a_stand_in";

  await claimHandle(OWNER, "sweepunknown", "Harbor Bakery", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSwpUnkn01", true);
  await setSubscription(OWNER, { customerId: "cus_SwpUnkn01", subscriptionId: "sub_SwpUnkn01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Bakery", address: "1 Main St, Portland, OR 97201" });
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, lifetime: true, lead: LEADS, contacts: true }));
  const course = await addProduct(OWNER, "Bread Course", "Twelve loaves.", "50", null);
  if (!course.ok) throw new Error("no product");
  await setProductLink(OWNER, course.product.id, "https://example.com/bread");
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
  ]);
  await rememberBuyer(store, "lee@example.com", ANA, store.affiliates.rule);
  is("control: Jo's lead is Ana's, confirmed before the checkout", await recordLead(store, { aff: ANA, kind: "signup", email: "jo@example.com", at: NOW - 3_600 }), "recorded");

  const real = redis.pipeline.bind(redis);
  const line = async (ref: string) => (await readBook(store)).lines.find((l) => l.ref === ref);
  /** One read of `key` answered `answer` (or thrown), every other command as usual. */
  const spoilOnce = (key: string, answer: "garbled" | "throw") => {
    let spent = false;
    redis.pipeline = (async (batch: (string | number)[][]) => {
      if (!spent && batch.some((c) => c[0] === "HGET" && String(c[1]) === key)) {
        spent = true;
        if (answer === "throw") throw new Error("the read was lost (test)");
        return batch.map(() => undefined);
      }
      return real(batch);
    }) as typeof redis.pipeline;
  };

  part("A bonded buyer whose bond read comes back in another shape");
  const BOND = "cs_test_sweepunknBond00001";
  sessions = [checkout(BOND, "lee@example.com", course.product.id)];
  spoilOnce(`nl:aff:${statsId}:bond`, "garbled");
  const first = await sweepCheckouts(Date.now() + 20_000);
  redis.pipeline = real as typeof redis.pipeline;
  is("the unknown read leaves the order for the next run, not settled", [first.failed > 0, (await line(BOND))?.aff ?? null], [true, null]);
  await sweepCheckouts(Date.now() + 20_000);
  is("the next run credits Ana, as the buyer's bond", [(await line(BOND))?.aff ?? null, (await line(BOND))?.how ?? null], [ANA, "buyer"]);

  part("A lead buyer whose lead read fails");
  const LEAD = "cs_test_sweepunknLead00001";
  sessions = [checkout(LEAD, "jo@example.com", course.product.id)];
  spoilOnce(`nl:aff:${statsId}:leads`, "throw");
  const again = await sweepCheckouts(Date.now() + 20_000);
  redis.pipeline = real as typeof redis.pipeline;
  is("the failed read leaves the order for the next run, not settled", [again.failed > 0, (await line(LEAD))?.aff ?? null], [true, null]);
  await sweepCheckouts(Date.now() + 20_000);
  is("the next run credits Ana, as the buyer's contact", [(await line(LEAD))?.aff ?? null, (await line(LEAD))?.how ?? null], [ANA, "contact"]);

  part("Controls: what reads normally still settles at once");
  const PLAIN = "cs_test_sweepunknPlain0001";
  sessions = [checkout(PLAIN, "nobody@example.com", course.product.id)];
  const plain = await sweepCheckouts(Date.now() + 20_000);
  is("a buyer with no bond and no lead: nothing failed, nothing credited", [plain.failed, (await line(PLAIN))?.aff ?? null], [0, null]);
  done();
}

void main();
