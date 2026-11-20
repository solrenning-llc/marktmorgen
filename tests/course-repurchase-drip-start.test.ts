/**
 * A course bought again after a full refund opens its drip from the purchase that stands, not the refunded one
 * (C7 courses hunt).
 *
 * Before: the thanks page writes the course down once (lib/learn.ts recordEnrollment, HSETNX), and a refund through
 * Stripe never takes it off. Bought again, courseLedger took that first, refunded start over Stripe's standing
 * purchase, so every module with fewer drip days than the time since the refunded purchase opened at once, against
 * the creator's schedule and the rule the code states ("bought again after a refund: the purchase that stands is
 * what counts"). Synthetic: a stand-in for the creator's Stripe account, the in-memory Redis.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { paidCourses, recordEnrollment } from "@/lib/learn";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_repurchase_drip_only";

const OWNER = "drip-teacher@example.com";
const ACCOUNT = "acct_1TestDripAgain1";
const NOW = Math.floor(Date.now() / 1000);
const FIRST = NOW - 60 * 86_400;
const AGAIN = NOW - 3_600;

const sessions: Record<string, Record<string, unknown>[]> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const charge = (amount: number, back: number) => ({ object: "charge", amount, amount_refunded: back, refunded: back >= amount });
const paid = (id: string, product: string, created: number, back: number) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created,
  customer: "cus_TestDripAgain1",
  metadata: { store: "dripschool", product },
  payment_intent: { id: `pi_${id.slice(8)}`, latest_charge: charge(4900, back) },
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "dripschool", "Drip School", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Slow Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  await setProductCourse(OWNER, id, { id: "c".repeat(32), lessons: 4 });
  const store = (await storeForEmail(OWNER))!;

  part("Bought once, the thanks page writes it down");
  sessions["fay@example.com"] = [paid("cs_test_fay000000001", id, FIRST, 0)];
  await recordEnrollment(store, "fay@example.com", id, FIRST);
  is("it opens from that purchase", (await paidCourses(store, "fay@example.com")).get(id), FIRST);

  part("Refunded in full, then bought again two months later");
  sessions["fay@example.com"] = [paid("cs_test_fay000000002", id, AGAIN, 0), paid("cs_test_fay000000001", id, FIRST, 4900)];
  // The ten-minute copy of Stripe's answer gone by, as it is after a refund and a new purchase days apart.
  advance(11 * 60 * 1000);
  is("it opens again, from the purchase that stands", (await paidCourses(store, "fay@example.com")).get(id), AGAIN);

  part("Bought twice, the second refunded: the first, which stands, still counts");
  sessions["gus@example.com"] = [paid("cs_test_gus000000002", id, AGAIN, 4900), paid("cs_test_gus000000001", id, FIRST, 0)];
  await recordEnrollment(store, "gus@example.com", id, FIRST);
  is("from the first purchase", (await paidCourses(store, "gus@example.com")).get(id), FIRST);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
