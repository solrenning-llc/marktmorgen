/**
 * RED for the review of pull request 3889 at head 38159d6c84: this fails there and passes on main 3cdc624a7d.
 * One membership that cannot be read must not change what the same buyer's other purchases open: a course refunded
 * in full stays shut although the thanks page wrote it down (lib/learn.ts), and a live membership's course stays open.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { paidCourses, recordEnrollment } from "@/lib/learn";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_review_3889_course_door";
const NOW = Math.floor(Date.now() / 1000);
const sessions: Record<string, Record<string, unknown>[]> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.pathname.replace(/^\/v1/, "") === "/checkout/sessions") return answer({ object: "list", data: sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const paid = (id: string, product: string, over: Record<string, unknown> = {}) => ({
  id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", created: NOW - 86_400, customer: "cus_TestStudent01",
  customer_details: { email: "zed@example.com" }, amount_total: 4900, metadata: { store: "school", product },
  payment_intent: { id: `pi_${id.slice(8)}`, latest_charge: { object: "charge", amount: 4900, amount_refunded: 0, refunded: false } }, ...over,
});
const member = (id: string, product: string, status: unknown) =>
  paid(id, product, { mode: "subscription", payment_intent: null, subscription: { id: `sub_${id.slice(8)}`, object: "subscription", status, latest_invoice: { id: `in_${id.slice(8)}`, next_payment_attempt: null } } });

test("a membership that cannot be read neither reopens a refunded course nor shuts another live membership's course", async () => {
  redis.clear();
  const OWNER = "teacher@example.com";
  await claimHandle(OWNER, "school", "Night School", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestReview3889", true);
  const make = async (title: string, recurring: Parameters<typeof addProduct>[4], course: string) => {
    const made = await addProduct(OWNER, title, "", "15", recurring);
    if (!made.ok) throw new Error(`no ${title}`);
    await setProductCourse(OWNER, made.product.id, { id: course, lessons: 4 });
    return made.product.id;
  };
  const once = await make("Bookkeeping Basics", null, "a".repeat(32));
  const clubA = await make("Club A", { interval: "month" } as Parameters<typeof addProduct>[4], "b".repeat(32));
  const clubB = await make("Club B", { interval: "month" } as Parameters<typeof addProduct>[4], "c".repeat(32));
  const store = (await storeForEmail(OWNER))!;
  sessions["zed@example.com"] = [
    // Refunded in full, and written down on the thanks page before the refund.
    paid("cs_test_zed000000001", once, { payment_intent: { id: "pi_zed01", latest_charge: { object: "charge", amount: 4900, amount_refunded: 4900, refunded: true } } }),
    member("cs_test_zed000000002", clubB, "active"),
    member("cs_test_zed000000003", clubA, "future_state"),
  ];
  await recordEnrollment(store, "zed@example.com", once, NOW - 86_400);
  const open = [...(await paidCourses(store, "zed@example.com")).keys()];
  assert.equal(open.includes(once), false, "the course refunded in full stays shut");
  assert.equal(open.includes(clubB), true, "the live membership's course stays open");
  assert.equal(open.includes(clubA), false, "the membership that cannot be read opens nothing");
  assert.deepEqual(redis.keys().filter((k) => k.startsWith("nl:learn:paid:")), [], "the answer with a membership not read is not kept");
  // The next good read decides, and is kept.
  sessions["zed@example.com"][2] = member("cs_test_zed000000003", clubA, "active");
  const again = [...(await paidCourses(store, "zed@example.com")).keys()];
  assert.deepEqual([again.includes(once), again.includes(clubB), again.includes(clubA)], [false, true, true], "a good read opens the membership");
  assert.equal(redis.keys().filter((k) => k.startsWith("nl:learn:paid:")).length, 1, "a whole answer is kept");
});
