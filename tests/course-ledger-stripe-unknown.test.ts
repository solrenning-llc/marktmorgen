/**
 * A refunded course stays shut when Stripe's answer is unknown (CX-123 rules 24 and 30). lib/learn.ts courseLedger
 * opens a one-off course written down on the thanks page "unless Stripe now says it was refunded in full", and the
 * refunds came from paidAtStripe. That read was loose: Stripe failing, a list in another shape (read as no
 * checkouts) or a list cut short (has_more ignored: only the newest hundred checkouts were read) left the refunds
 * empty, so a course refunded in full, or lost to a dispute, opened again to its buyer on the thanks page's record.
 * Every sibling door shuts on the same unknown: the community and the private podcast (lib/community-access.ts,
 * "nobody is let in on a guess"), the download by link (lib/buyer-orders.ts, findPurchase throws) and the download by
 * order (lib/store-checkout.ts, readOrder answers "error").
 *
 * Now the checkouts are read in Stripe's exact list shape (lib/stripe-list.ts) and to their end, a few pages at most;
 * anything less is unknown, and a course whose opening depends on Stripe's answer is not opened on it (nothing is
 * kept, so the next page asks again). What does not depend on Stripe stays open: a course brought over from another
 * platform. Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidCourses, recordEnrollment } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_course_ledger_unknown";

const OWNER = "teacher@example.com";
const ACCOUNT = "acct_1TestLedgerUnk1";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
/** Checkouts by the address they were paid from, newest first. */
const sessions: Record<string, Row[]> = {};
/** How Stripe answers the list for an address: as it is, failing, in another shape, or a hundred a page. */
const mode: Record<string, "ok" | "fail" | "shape" | "paged"> = {};
const PAGE = 100;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const email = url.searchParams.get("customer_details[email]") ?? "";
    const rows = sessions[email] ?? [];
    const how = mode[email] ?? "ok";
    if (how === "fail") return answer({ error: { type: "api_error", message: "Stripe is having a moment" } }, 500);
    if (how === "shape") return answer({ object: "list", data: { rows }, has_more: false });
    const after = url.searchParams.get("starting_after");
    const from = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
    return answer({ object: "list", data: rows.slice(from, from + PAGE), has_more: from + PAGE < rows.length });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** A paid checkout of one product, refunded in full or not. */
const paid = (id: string, product: string, refunded: boolean, created = NOW - 86_400): Row => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created,
  customer_details: { email: "x@example.com" },
  metadata: { store: "ledgerunk", product },
  payment_intent: {
    id: `pi_${id.slice(8)}`,
    object: "payment_intent",
    latest_charge: { id: `ch_${id.slice(8)}`, object: "charge", amount: 4900, amount_refunded: refunded ? 4900 : 0, refunded, disputed: false },
  },
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "ledgerunk", "Ledger Unknown", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LedgerOwn01", subscriptionId: "sub_LedgerOwn01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Watercolor Basics", "", "49", null);
  const other = await addProduct(OWNER, "Brush Guide", "", "19", null);
  if (!made.ok || !other.ok) throw new Error("no products");
  const course = made.product.id;
  await setProductCourse(OWNER, course, { id: "b".repeat(32), lessons: 4 });
  const store = (await storeForEmail(OWNER))!;
  const open = async (email: string) => [...(await paidCourses(store, email)).keys()];
  /** A buyer whose course was written down on the thanks page and then refunded in full. */
  const refundedBuyer = async (email: string, how: (typeof mode)[string], before: Row[] = []) => {
    sessions[email] = [...before, paid(`cs_test_${email.slice(0, 5)}0refund01`, course, true)];
    mode[email] = how;
    await recordEnrollment(store, email, course, NOW - 86_400);
  };

  part("Stripe read whole: the refund shuts the course written down on the thanks page");
  await refundedBuyer("aaron@example.com", "ok");
  is("refunded in full: shut", await open("aaron@example.com"), []);
  sessions["bella@example.com"] = [paid("cs_test_bella0paid01", course, false)];
  await recordEnrollment(store, "bella@example.com", course, NOW - 86_400);
  is("paid and kept: open", await open("bella@example.com"), [course]);

  part("Stripe's answer unknown: a refunded course is not opened on a guess");
  await refundedBuyer("carla@example.com", "fail");
  is("Stripe failing: still shut", await open("carla@example.com"), []);
  await refundedBuyer("dylan@example.com", "shape");
  is("a list in another shape: still shut", await open("dylan@example.com"), []);
  const newer = Array.from({ length: PAGE }, (_, i) => paid(`cs_test_elena${String(i).padStart(6, "0")}`, other.product.id, false, NOW - 3_600 + i));
  await refundedBuyer("elena@example.com", "paged", newer);
  is("the refund on the second page of checkouts: read, and shut", await open("elena@example.com"), []);

  part("And nothing unknown is kept: the next page asks again");
  mode["carla@example.com"] = "ok";
  sessions["carla@example.com"] = [paid("cs_test_carla0paid02", course, false, NOW - 600), ...sessions["carla@example.com"]];
  is("bought again, Stripe back: open", await open("carla@example.com"), [course]);

  done();
}

void main();
