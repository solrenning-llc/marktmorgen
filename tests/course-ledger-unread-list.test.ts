/**
 * Who may open a course (lib/learn.ts, paidAtStripe) reads the creator's
 * Stripe list of checkouts in its exact shape (CX-123 rules 24 and 30): a reply
 * that is not a list (no `data` array, no `has_more`) is unknown, never "this
 * address bought nothing". It was read as an empty list and that answer was
 * kept for ten minutes, so one bad reply shut a running membership's course
 * for ten minutes and said "buy it" instead of "ended" or "try again". Now it
 * is not kept, and the next page asks Stripe again.
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { paidCourses } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_ledger_unread_list";

const OWNER = "runner@example.com";
const ACCOUNT = "acct_1TestUnreadLst";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const EMAIL = "member@example.com";

let product = "";
let broken: unknown = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    if (broken !== null) return answer(broken);
    return answer({
      object: "list",
      has_more: false,
      data: url.searchParams.get("customer_details[email]") === EMAIL ? [{
        id: "cs_test_member000001",
        object: "checkout.session",
        mode: "subscription",
        status: "complete",
        payment_status: "paid",
        created: NOW - 10 * DAY,
        customer: "cus_TestMember001",
        customer_details: { email: EMAIL },
        amount_total: 1500,
        metadata: { store: "runclub", product },
        payment_intent: null,
        subscription: { id: "sub_TestMember0001", object: "subscription", status: "active", latest_invoice: null, items: { data: [{ current_period_end: NOW + 20 * DAY }] } },
      }] : [],
    });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "runclub", "Run Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Running Club", "", "15", { interval: "month" } as Parameters<typeof addProduct>[4]);
  if (!made.ok) throw new Error("no product");
  product = made.product.id;
  await setProductCourse(OWNER, product, { id: "c".repeat(32), lessons: 4 });
  is("control: a healthy list opens the course", [...(await paidCourses((await storeForEmail(OWNER))!, EMAIL)).keys()], [product]);

  for (const [label, reply] of [
    ["no data", { object: "list", has_more: false }],
    ["data that is not a list", { object: "list", data: {}, has_more: false }],
    ["an error body", { error: { message: "busy" } }],
  ] as const) {
    part(`Stripe answered ${label}`);
    redis.clear();
    await claimHandle(OWNER, "runclub", "Run Club", "");
    await ensureStatsId(OWNER);
    await setStripeAccount(OWNER, ACCOUNT, true);
    const again = await addProduct(OWNER, "Running Club", "", "15", { interval: "month" } as Parameters<typeof addProduct>[4]);
    if (!again.ok) throw new Error("no product");
    product = again.product.id;
    await setProductCourse(OWNER, product, { id: "c".repeat(32), lessons: 4 });
    const fresh = (await storeForEmail(OWNER))!;
    broken = reply;
    await paidCourses(fresh, EMAIL);
    broken = null;
    is("the next page asks Stripe again: the running membership's course opens", [...(await paidCourses(fresh, EMAIL)).keys()], [product]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
