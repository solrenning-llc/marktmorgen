/**
 * A lost dispute at the doors the first pass left on refunds only, and how
 * each door behaves when the dispute cannot be read (queue 388 [TB14], F38;
 * MM-SA-18; review of PR #2107, added 4 November 2026). Checked against a
 * stand-in for the creator's Stripe account:
 *
 *   - the license key job still revokes on a full refund when the closing
 *     events cannot be read (a restricted key, a rate limit), and keeps its
 *     place so the disputes are read again next run;
 *   - a dispute lost for part of the price keeps access, as a partial refund
 *     does; lost for the whole price (with what was refunded) it closes;
 *   - a dispute that cannot be read keeps the community and the list of
 *     purchases open, as a refund read does, and no dispute is read for an
 *     offer that is not of the product asked about;
 *   - the job that ends a paid call's meeting acts on a lost dispute, not on
 *     a won or partial one;
 *   - a review is no longer from a "verified buyer" once its payment is lost
 *     to a dispute, both when proved and in the job that marks reviews.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { purchaseRefunded } from "@/lib/refunds";
import { paidForAny } from "@/lib/community-access";
import { purchasesFor } from "@/lib/buyer-orders";
import { checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { syncMeetings } from "@/lib/call-meetings";
import { MEET_STORES } from "@/lib/meet-links";
import { markRefundedReviews, provePurchase } from "@/lib/review-proof";
import { readReview, saveReview, visibleReviews } from "@/lib/reviews";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_lost_dispute_doors_only";

const OWNER = "potter@example.com";
const ACCOUNT = "acct_1TestDoors00001";
const NOW = Math.floor(Date.now() / 1000);

const sessions: Record<string, Record<string, unknown>[]> = {};
const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
const oneSession: Record<string, Record<string, unknown>> = {};
const intents: Record<string, Record<string, unknown>[]> = {};
const paymentIntents: Record<string, Record<string, unknown>> = {};
const disputes: Record<string, { status: string; amount?: number }[]> = {};
const charges: Record<string, Record<string, unknown>> = {};
let closings: Record<string, unknown>[] = [];
let refunds: Record<string, unknown>[] = [];
let eventsStatus = 200;
let disputesDown = false;
let disputeReads = 0;
const lookedUp: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const pi = url.searchParams.get("payment_intent");
    if (pi) {
      lookedUp.push(pi);
      return list(sessionsByPayment[pi] ?? []);
    }
    return list(sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? []);
  }
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) return oneSession[one[1]] ? answer(oneSession[one[1]]) : answer({ error: { message: "no such" } }, 404);
  if (path === "/payment_intents") return list(intents[url.searchParams.get("customer") ?? ""] ?? []);
  const pi = /^\/payment_intents\/(pi_[A-Za-z0-9]+)$/.exec(path);
  if (pi) return answer(paymentIntents[pi[1]] ?? {});
  if (path === "/disputes") {
    disputeReads += 1;
    if (disputesDown) return answer({ error: { message: "rate limited" } }, 429);
    return list(disputes[url.searchParams.get("charge") ?? ""] ?? []);
  }
  if (path === "/events") {
    if (eventsStatus !== 200) return answer({ error: { type: "invalid_request_error", message: "This API key does not have the rak_event_read permission" } }, eventsStatus);
    return list(url.searchParams.get("type") === "charge.dispute.closed" ? closings : []);
  }
  const read = /^\/charges\/(ch_[A-Za-z0-9]+)$/.exec(path);
  if (read) return answer(charges[read[1]] ?? { object: "charge", id: read[1], amount: 4900, amount_refunded: 0, disputed: true });
  if (path === "/refunds") return list(refunds);
  return list([]);
}) as typeof fetch;

const charge = (id: string, status: string | null, amount = 4900, lost = amount) => {
  if (status) disputes[id] = [{ status, amount: lost }];
  return { object: "charge", id, amount, amount_refunded: 0, refunded: false, disputed: status !== null };
};
const paid = (id: string, product: string, status: string | null, over: Record<string, unknown> = {}, lost = 4900) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestPotter001",
  customer_details: { email: "buyer@example.com" },
  amount_total: 4900,
  metadata: { store: "kilnworks", product },
  payment_intent: { id: `pi_${id.slice(8)}`, object: "payment_intent", latest_charge: charge(`ch_${id.slice(8)}`, status, 4900, lost) },
  ...over,
});
const closing = (id: string, intent: string, status: string, amount = 4900) => ({
  id,
  object: "event",
  type: "charge.dispute.closed",
  created: NOW - 60,
  data: { object: { id: `du_${id.slice(4)}`, object: "dispute", status, amount, charge: `ch_${intent.slice(3)}`, payment_intent: intent } },
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Glaze Guide", "", "49", null);
  const other = await addProduct(OWNER, "Kiln Log", "", "19", null);
  const tool = await addProduct(OWNER, "Firing App", "", "29", null);
  if (!guide.ok || !other.ok || !tool.ok) throw new Error("no products");
  await setProductLink(OWNER, guide.product.id, "https://example.com/glaze-guide");
  await setProductLink(OWNER, other.product.id, "https://example.com/kiln-log");
  await setProductLink(OWNER, tool.product.id, "https://example.com/firing-app");
  await setProductKeys(OWNER, tool.product.id, { source: "generated", prefix: "FIRE", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;

  part("The license key job, when the closing events cannot be read");
  const app = (await readListing(store, tool.product.id))!;
  const given = await keyForSale(store, app, "cs_test_keyrefund0001", "buyer@example.com");
  if (given?.state !== "issued") throw new Error("no key");
  sessionsByPayment.pi_TestKeyRefund1 = [{ id: "cs_test_keyrefund0001", metadata: { store: "kilnworks", product: tool.product.id } }];
  refunds = [{ id: "re_TestKeyRefund1", object: "refund", created: NOW - 30, status: "succeeded", payment_intent: "pi_TestKeyRefund1", charge: { object: "charge", amount: 2900, amount_refunded: 2900, refunded: true } }];
  eventsStatus = 403;
  const ran = await revokeRefunded(store, Date.now() + 10_000).then((n) => n, () => "stopped");
  is("a full refund still revokes its key", [ran, await checkKey(store, app, given.key)], [1, "revoked"]);
  const [anchor] = await redis.pipeline([["GET", `nl:keys:${store.statsId}:refunds:since`]]);
  is("and the anchor is not moved, so the disputes are read next run", anchor, null);
  eventsStatus = 200;
  refunds = [];

  part("A dispute lost for part of the price");
  is("keeps access, as a partial refund does", await purchaseRefunded(ACCOUNT, paid("cs_test_part00000001", guide.product.id, "lost", {}, 1000)), false);
  is("lost for the whole price: closed", await purchaseRefunded(ACCOUNT, paid("cs_test_whole0000001", guide.product.id, "lost")), true);
  const partKey = await keyForSale(store, app, "cs_test_keypart000001", "buyer@example.com");
  const wholeKey = await keyForSale(store, app, "cs_test_keywhole00001", "buyer@example.com");
  if (partKey?.state !== "issued" || wholeKey?.state !== "issued") throw new Error("no key");
  sessionsByPayment.pi_TestKeyPart01 = [{ id: "cs_test_keypart000001", metadata: { store: "kilnworks", product: tool.product.id } }];
  sessionsByPayment.pi_TestKeyWhole1 = [{ id: "cs_test_keywhole00001", metadata: { store: "kilnworks", product: tool.product.id } }];
  closings = [closing("evt_TestKeyPart01", "pi_TestKeyPart01", "lost", 1000), closing("evt_TestKeyWhole1", "pi_TestKeyWhole1", "lost")];
  await revokeRefunded(store, Date.now() + 10_000);
  is("the key job: part lost keeps its key, whole lost revokes", [await checkKey(store, app, partKey.key), await checkKey(store, app, wholeKey.key)], ["valid", "revoked"]);
  closings = [];

  part("A dispute that cannot be read keeps the door open, as a refund read does");
  const ids = new Set([guide.product.id]);
  sessions["rae@example.com"] = [paid("cs_test_rae000000001", other.product.id, null, { customer: "cus_TestRae00001" })];
  intents.cus_TestRae00001 = [{ id: "pi_raeup1aaaa", object: "payment_intent", status: "succeeded", metadata: { kind: "upsell", store: "kilnworks", product: guide.product.id }, latest_charge: charge("ch_raeup1aaaa", "under_review") }];
  disputesDown = true;
  is("the community lets in", await paidForAny(store, "rae@example.com", ids).then((v) => v, () => "stopped"), true);
  const listed = await purchasesFor(store, "rae@example.com").then((p) => p.map((x) => x.reference), () => "stopped");
  is("the list of purchases still shows the order and the offer", Array.isArray(listed) ? [...listed].sort() : listed, ["cs_test_rae000000001", "pi_raeup1aaaa"]);
  disputesDown = false;
  disputeReads = 0;
  is("no dispute is read for an offer of another product", [await paidForAny(store, "rae@example.com", new Set([tool.product.id])), disputeReads], [false, 0]);

  part("The meeting of a paid call");
  const callsId = "c".repeat(16);
  const callStore: Store = { ...store, callsId };
  await redis.pipeline([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|kilnworks`]]);
  const call = (pi: string) => [{ id: `cs_test_${pi.slice(3)}`, metadata: { kind: "call", store: "kilnworks", product: guide.product.id, start: String(Date.now() + 86_400_000) }, customer_details: { email: "buyer@example.com" } }];
  sessionsByPayment.pi_TestCallLost01 = call("pi_TestCallLost01");
  sessionsByPayment.pi_TestCallWon001 = call("pi_TestCallWon001");
  sessionsByPayment.pi_TestCallPart01 = call("pi_TestCallPart01");
  closings = [closing("evt_TestCallLost01", "pi_TestCallLost01", "lost"), closing("evt_TestCallWon001", "pi_TestCallWon001", "won"), closing("evt_TestCallPart01", "pi_TestCallPart01", "lost", 500)];
  lookedUp.length = 0;
  await syncMeetings(async (handle) => (handle === "kilnworks" ? callStore : null), Date.now() + 10_000, "https://marktmorgen.com");
  is("the job ends the meeting of the call lost, not the won or partial one", lookedUp, ["pi_TestCallLost01"]);
  closings = [];

  part("A review's verified buyer");
  oneSession.cs_test_rev0000000lost = paid("cs_test_rev0000000lost", guide.product.id, "lost");
  oneSession.cs_test_rev00000review = paid("cs_test_rev00000review", guide.product.id, "under_review");
  const proved = async (ref: string) => {
    const proof = await provePurchase(store, ref);
    return proof.state === "ok" ? proof.proof.refunded : proof.state;
  };
  is("proved: lost is refunded, under review is not", [await proved("cs_test_rev0000000lost"), await proved("cs_test_rev00000review")], [true, false]);
  await saveReview(store.statsId!, { productId: guide.product.id, email: "rev@example.com", reference: "cs_test_revjob00000001", pi: "pi_TestRevLost01", rating: 5, text: "Clear glaze notes", name: "Rev" }, ROOM);
  const review = (await visibleReviews(store.statsId!, guide.product.id, 0, 10))[0];
  closings = [closing("evt_TestRevLost01", "pi_TestRevLost01", "lost")];
  is("the job marks a review whose payment was lost", [await markRefundedReviews(store, Date.now() + 10_000), (await readReview(store.statsId!, guide.product.id, review.id))?.refunded], [1, true]);

  done();
}

void main();
