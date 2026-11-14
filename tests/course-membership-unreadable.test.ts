/**
 * A course sold as a membership, whose membership Stripe sent in a shape that does not read, is "could not check",
 * never "your membership has ended" (CX-123 rule 24; lib/learn.ts paidAtStripe, lib/course-door.ts).
 *
 * paidAtStripe read every checkout's expanded subscription with `!sub || typeof sub !== "object" || !isLiveSub(sub)`
 * and put the course among the ended ones for anything that was not a live membership: a subscription missing, left
 * as an id, or without a status read the same as one Stripe calls canceled. The course page then told a paying member
 * their membership had ended, offered the way to join again, and (forgetsOnDevice) wiped their places in the videos
 * from their device, all on a reply nobody could read; the answer was kept ten minutes too. Now such a reply leaves
 * Stripe's answer not whole: the course is "unknown", said as not checked, places kept, nothing cached.
 *
 * Controls: active opens, canceled is ended. Synthetic only: an in-memory Redis and a stand-in for Stripe.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { courseAccess, mintPass, passCookieName } from "@/lib/learn";
import { forgetsOnDevice } from "@/lib/course-door";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_course_membership_unreadable";

const OWNER = "club@example.com";
const ACCOUNT = "acct_1TestMemberRead";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
const sessions: Record<string, Row[]> = {};

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const email = url.searchParams.get("customer_details[email]") ?? "";
    return answer({ object: "list", data: sessions[email] ?? [], has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const member = (id: string, product: string, subscription: unknown): Row => ({
  id,
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer_details: { email: "x@example.com" },
  metadata: { store: "memberclub", product },
  payment_intent: null,
  subscription,
});
const sub = (id: string, status: string) => ({ id, object: "subscription", status, latest_invoice: { id: `in_${id.slice(4)}`, next_payment_attempt: null } });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "memberclub", "Member Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_MemberClub01", subscriptionId: "sub_MemberClub01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Sketch Club", "", "15", { interval: "month" } as Parameters<typeof addProduct>[4]);
  if (!made.ok) throw new Error("no product");
  await setProductCourse(OWNER, made.product.id, { id: "d".repeat(32), lessons: 3 });
  const store = (await storeForEmail(OWNER))!;
  const product = made.product.id;
  const course = (await readListing(store, product))!;
  const access = async (email: string) => {
    const pass = await mintPass(store, email, "all");
    return courseAccess(store, course, { get: (name: string) => (name === passCookieName(store) ? { value: pass } : undefined) });
  };

  part("Controls: a running membership opens, a canceled one has ended");
  sessions["ana@example.com"] = [member("cs_test_ana0member01", product, sub("sub_AnaMember001", "active"))];
  is("active: open", (await access("ana@example.com")).state, "open");
  sessions["ben@example.com"] = [member("cs_test_ben0member01", product, sub("sub_BenMember001", "canceled"))];
  const ben = await access("ben@example.com");
  is("canceled: ended", ben.state, "ended");
  is("canceled: the device forgets the places", forgetsOnDevice(ben), true);

  for (const [email, what, shape] of [
    ["cyd@example.com", "no subscription sent", null],
    ["dee@example.com", "the subscription left as an id", "sub_DeeMember001"],
    ["eli@example.com", "a subscription without a status", { id: "sub_EliMember001", object: "subscription" }],
    ["fay@example.com", "a status that is not text", { id: "sub_FayMember001", object: "subscription", status: 7 }],
  ] as const) {
    part(`A membership that does not read (${what}): unknown, never ended`);
    sessions[email] = [member(`cs_test_${email.slice(0, 3)}member01`, product, shape)];
    const got = await access(email);
    is(`${what}: said as not checked`, got.state, "unknown");
    is(`${what}: the places stay on the device`, forgetsOnDevice(got), false);
    sessions[email] = [member(`cs_test_${email.slice(0, 3)}member02`, product, sub(`sub_${email.slice(0, 3)}Again01`, "active"))];
    is(`${what}: nothing was kept, Stripe read whole next time opens it`, (await access(email)).state, "open");
  }

  done();
}

void main();
