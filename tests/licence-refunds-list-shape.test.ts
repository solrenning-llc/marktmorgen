/**
 * CX-123 rules 24 and 30, lists from Stripe (the sibling of lot 2's review pass, lib/review-proof.ts): the
 * five-minute job that revokes the license key of a refunded sale (lib/licence-keys.ts, revokeRefunded) read its
 * refunds page, the checkout that names a refund's payment, and a payment plan's invoice payment loosely: a list in
 * another shape was read as an empty one. So
 *
 *   - a refunds page in another shape after a readable one was taken for the last page, and the job moved its
 *     anchor past the refunds it never read: their keys stayed valid for good;
 *   - a checkout list in another shape for a refunded payment was read as "no checkout", the refund was marked read
 *     with no sale found, and its key stayed valid for good.
 *
 * Now each list is read in its exact shape (lib/stripe-list.ts, refundRowKnown in lib/refunds.ts): a page in another
 * shape keeps the anchor, and a refund whose sale cannot be told is not marked read, so a later healthy run revokes
 * the key. Against a stand-in for Stripe; every key function is the real one.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_licence_refunds_shape";

const OWNER = "keys@example.com";
const ACCOUNT = "acct_1TestKeyShape01";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
/** Refunds as Stripe lists them, newest first, in pages of `PAGE`. */
let refunds: Row[] = [];
const PAGE = 2;
/** The page index (0-based) Stripe answers in another shape, or -1. */
let brokenRefundPage = -1;
/** Checkouts by the payment they were paid with. */
const sessionsByPayment: Record<string, Row[]> = {};
/** The payments whose checkout list Stripe answers in another shape. */
const brokenSessions = new Set<string>();

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[], more = false) => answer({ object: "list", data, has_more: more });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/refunds") {
    const since = Number(url.searchParams.get("created[gte]") ?? 0);
    const rows = refunds.filter((r) => (r.created as number) >= since);
    const after = url.searchParams.get("starting_after");
    const from = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
    const index = Math.floor(from / PAGE);
    if (index === brokenRefundPage) return answer({ object: "list", data: "not a list", has_more: false });
    return list(rows.slice(from, from + PAGE), from + PAGE < rows.length);
  }
  if (path === "/checkout/sessions") {
    const pi = url.searchParams.get("payment_intent") ?? "";
    if (brokenSessions.has(pi)) return answer({ object: "list", data: null });
    return list(sessionsByPayment[pi] ?? []);
  }
  if (/^\/payment_intents\/pi_/.test(path)) return answer({ id: path.split("/").pop(), object: "payment_intent", metadata: {} });
  if (path === "/events") return list([]);
  return list([]);
}) as typeof fetch;

/** A full refund as GET /refunds?expand[]=data.charge lists it. */
const refund = (id: string, intent: string, created: number): Row => ({
  id,
  object: "refund",
  status: "succeeded",
  created,
  payment_intent: intent,
  charge: { id: `ch_${intent.slice(3)}`, object: "charge", amount: 2900, amount_refunded: 2900, refunded: true },
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "keyshape", "Key Shape", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_KeyOwner01", subscriptionId: "sub_KeyOwner01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Palette App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/palette-app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "PAL", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  const keyOf = async (sale: string) => {
    const given = await keyForSale(store, app, sale, "buyer@example.com");
    if (given?.state !== "issued") throw new Error("no key");
    return given.key;
  };
  const sale = (n: number) => `cs_test_keyshape${String(n).padStart(8, "0")}`;
  const intent = (n: number) => `pi_TestKeyShape${String(n).padStart(4, "0")}`;
  const sold = (n: number) => {
    sessionsByPayment[intent(n)] = [{ id: sale(n), object: "checkout.session", metadata: { store: "keyshape", product: app.id } }];
  };
  const run = () => revokeRefunded(store, Date.now() + 10_000);

  part("A refunds page in another shape is not the last page");
  // Newest first: two recent refunds on the first page, an older one on the second.
  const keys = await Promise.all([1, 2, 3].map((n) => keyOf(sale(n))));
  [1, 2, 3].forEach(sold);
  refunds = [refund("re_TestShape0001", intent(1), NOW - 60), refund("re_TestShape0002", intent(2), NOW - 120), refund("re_TestShape0003", intent(3), NOW - 7_200)];
  brokenRefundPage = 1;
  is("the first run revokes what it could read", await run(), 2);
  is("and the older refund's key is not revoked yet", await checkKey(store, app, keys[2]), "valid");
  brokenRefundPage = -1;
  await run();
  is("a later healthy run reads it again and revokes it", await checkKey(store, app, keys[2]), "revoked");

  part("A checkout list in another shape is not \"no checkout\"");
  const key = await keyOf(sale(4));
  sold(4);
  refunds = [refund("re_TestShape0004", intent(4), NOW - 30), ...refunds];
  brokenSessions.add(intent(4));
  await run();
  is("the run that could not tell the sale revokes nothing", await checkKey(store, app, key), "valid");
  brokenSessions.delete(intent(4));
  await run();
  is("a later healthy run revokes it", await checkKey(store, app, key), "revoked");

  done();
}

void main();
