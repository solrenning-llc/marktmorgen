/**
 * A course bought, refunded in full and bought again starts its drip clock at
 * the purchase that stands, never at the refunded one (lib/learn.ts
 * courseLedger; found by the courses hunt of 12 November 2026).
 *
 * The thanks page writes a one-off purchase down once (HSETNX), with when it
 * began. Stripe's answer clears "refunded" for a course bought again, so the
 * date written down for the refunded purchase used to win: a buyer who
 * refunded a 30-day drip course sixty days ago and bought it again yesterday
 * found every module open at once. Checked here, against a stand-in for the
 * creator's Stripe account:
 *
 *   - refunded, then bought again: the clock starts at the new purchase;
 *   - bought twice, nothing refunded: the first purchase written down still counts;
 *   - bought once: the date written down still counts, as before;
 *   - refunded and not bought again: shut, as before.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidCourses, recordEnrollment } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_rebuy_drip_only";

const OWNER = "maker@example.com";
const ACCOUNT = "acct_1TestRebuyDrip1";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const sessions: Record<string, Record<string, unknown>[]> = {};

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && !url.searchParams.get("payment_intent")) return list(sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? []);
  return list([]);
}) as typeof fetch;

/** A paid checkout for `product`, created `created`, its charge refunded in full or not. */
const paid = (id: string, email: string, product: string, created: number, refunded: boolean) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created,
  customer: "cus_TestRebuy0001",
  customer_details: { email },
  amount_total: 4900,
  metadata: { store: "rebuydrip", product },
  payment_intent: {
    id: `pi_${id.slice(8)}`,
    object: "payment_intent",
    latest_charge: { object: "charge", id: `ch_${id.slice(8)}`, amount: 4900, amount_refunded: refunded ? 4900 : 0, refunded, disputed: false },
  },
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "rebuydrip", "Rebuy Drip", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Slow Bread", "", "49", null);
  if (!made.ok) throw new Error(`no product: ${made.reason}`);
  const course = made.product.id;
  await setProductCourse(OWNER, course, { id: "d".repeat(32), lessons: 4 });
  const store = (await storeForEmail(OWNER))!;
  const start = async (email: string) => (await paidCourses(store, email)).get(course);

  part("Refunded in full, then bought again");
  sessions["back@example.com"] = [paid("cs_test_back00000002", "back@example.com", course, NOW - DAY, false), paid("cs_test_back00000001", "back@example.com", course, NOW - 60 * DAY, true)];
  await recordEnrollment(store, "back@example.com", course, NOW - 60 * DAY);
  is("the drip clock starts at the purchase that stands, not the refunded one", await start("back@example.com"), NOW - DAY);

  part("What already held, still holds");
  sessions["twice@example.com"] = [paid("cs_test_twice0000002", "twice@example.com", course, NOW - DAY, false), paid("cs_test_twice0000001", "twice@example.com", course, NOW - 60 * DAY, false)];
  await recordEnrollment(store, "twice@example.com", course, NOW - 60 * DAY);
  is("bought twice, nothing refunded: the first purchase counts", await start("twice@example.com"), NOW - 60 * DAY);
  sessions["once@example.com"] = [paid("cs_test_once00000001", "once@example.com", course, NOW - 10 * DAY, false)];
  await recordEnrollment(store, "once@example.com", course, NOW - 10 * DAY + 30);
  is("bought once: the date the thanks page wrote down", await start("once@example.com"), NOW - 10 * DAY + 30);
  sessions["gone@example.com"] = [paid("cs_test_gone00000001", "gone@example.com", course, NOW - 10 * DAY, true)];
  await recordEnrollment(store, "gone@example.com", course, NOW - 10 * DAY);
  is("refunded and not bought again: shut", await start("gone@example.com"), undefined);

  done();
}

void main();
