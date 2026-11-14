/**
 * A purchase for several people that was given back in full before it was first confirmed hands out no place
 * (lib/group-buy.ts settleGroup; money, as #4408 does for gifts and pre-orders).
 *
 * The defect this file was written around: settleGroup marked the purchase paid, and wrote the payment's index
 * nl:grp:pi:<pi>, without reading the payment. The five-minute sweep takes refunds back before it confirms the day's
 * checkouts (lib/checkout-sweep.ts), and Stripe keeps a refunded checkout `paid`. So when a buyer paid for five
 * places, never reached the thanks page, and the creator refunded them in full within the same five minutes:
 *
 *   1. revokeRefundedGroups read the refund, found no purchase for its payment (no index yet), and marked it read;
 *   2. settleGroup then marked the purchase paid and emailed the link that hands out its places;
 *   3. no later run took them back: the refund was already read.
 *
 * The five places were handed out on money given back. Now settleGroup reads the payment first, with its latest charge
 * (it must be this payment's own: rule 30). Given back (refunded in full, or lost to a dispute) it is written down as
 * revoked and nothing is sent; a read that fails throws, so nothing is written and the next run reads it again.
 *
 * Checked: the refund read first, then the settle: not settled, no place handed out; a payment read that
 * fails or answers for another payment settles nothing; a payment not given back settles as before (control).
 * Stripe and the email service are stand-ins; whether the receipt itself reaches the email service is not checked here.
 */
import { openGroup, revokeRefundedGroups, settleGroup, startGroup } from "@/lib/group-buy";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_group_refunded_before_settle_only";
process.env.RESEND_API_KEY = "re_test_group_refunded_before_settle_only";

const ACCOUNT = "acct_1TestGroupRef01";
const NOW = Math.floor(Date.now() / 1000);
let refunds: unknown[] = [];
/** What GET /payment_intents/<pi> answers, by payment; a missing one answers 500. */
const payments: Record<string, unknown> = {};
let paymentReads = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com" || url.hostname.includes("amazonaws")) return answer({ id: "email_1" });
  if (url.pathname === "/v1/refunds") return answer({ object: "list", data: refunds, has_more: false });
  const intent = /^\/v1\/payment_intents\/(pi_[A-Za-z0-9]+)$/.exec(url.pathname);
  if (intent) {
    paymentReads += 1;
    return intent[1] in payments ? answer(payments[intent[1]]) : answer({ error: { type: "api_error", message: "TEST ONLY down" } }, 500);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const sid = "g".repeat(32);
const store = { statsId: sid, stripeAccountId: ACCOUNT, handle: "group-ref", previousHandles: [], language: "en", currency: "usd", name: "Group Ref", email: "creator@example.com", catalog: { items: [] } } as unknown as Store;
const product = { id: "prod1", title: "Guide", priceCents: 1000, options: [], file: { name: "f" }, link: null, course: null, bundle: null, recurring: null, call: null, pwyw: null, keys: null, stock: null, podcast: null } as unknown as Listing;
const charge = (refunded: boolean) => ({ id: "ch_GroupRef000001", object: "charge", amount: 5000, amount_refunded: refunded ? 5000 : 0, refunded, disputed: false });
const paymentOf = (pi: string, refunded: boolean) => ({ id: pi, object: "payment_intent", status: "succeeded", latest_charge: charge(refunded) });
const sessionFor = (group: string, pi: string) => ({ id: `cs_test_${pi.slice(3).padEnd(24, "0")}`, created: NOW - 120, amount_total: 5000, currency: "usd", payment_intent: pi, status: "complete", payment_status: "paid", metadata: { store: "group-ref", product: "prod1", group }, customer_details: { email: "buyer@example.com" } });

/** A purchase for five, started; then the sweep's refund pass runs; then the same run settles the paid checkout. */
async function run(pi: string): Promise<{ settled: string; open: boolean }> {
  const started = await startGroup(store, product, "5");
  if (!started.ok) throw new Error(`not started: ${JSON.stringify(started)}`);
  const id = started.group.id;
  const errors = console.error;
  console.error = () => {};
  let settled: string;
  try {
    await revokeRefundedGroups(store, Date.now() + 60_000, async () => {});
    try {
      settled = await settleGroup({ store, session: sessionFor(id, pi), product, base: "https://x.test/@group-ref", from: "store@x.test" });
    } catch {
      settled = "threw";
    }
    // Later runs, as the five-minute job makes them.
    await revokeRefundedGroups(store, Date.now() + 60_000, async () => {});
  } finally {
    console.error = errors;
  }
  return { settled, open: Boolean(await openGroup(store, id)) };
}

async function main(): Promise<void> {
  redis.clear();
  // A store that sold a purchase for several before, as any store past its first does.
  await redis.pipeline([["SET", `nl:grp:${sid}:any`, "1"]]);

  part("Refunded in full before it was first confirmed: no place handed out");
  const given = "pi_GroupRefGiven001";
  refunds = [{ id: "re_GroupRefGiven1", object: "refund", status: "succeeded", created: NOW - 60, payment_intent: given, charge: charge(true) }];
  payments[given] = paymentOf(given, true);
  const back = await run(given);
  is("not settled, and the purchase hands out no place", [back.settled === "settled", back.open], [false, false]);

  part("A payment read that fails, or answers for another payment, settles nothing");
  refunds = [];
  const unread = "pi_GroupRefUnread01";
  delete payments[unread];
  const failed = await run(unread);
  is("the read fails: not settled, nothing open", [failed.settled === "settled", failed.open], [false, false]);
  const other = "pi_GroupRefOther001";
  payments[other] = paymentOf("pi_SomeoneElse0001", false);
  const foreign = await run(other);
  is("another payment's answer: not settled, nothing open", [foreign.settled === "settled", foreign.open], [false, false]);

  part("Control: a payment that stands settles as before");
  const kept = "pi_GroupRefKept0001";
  payments[kept] = paymentOf(kept, false);
  const settled = await run(kept);
  is("settled, its places open", [settled.settled, settled.open], ["settled", true]);
  is("the payment was read before it was settled", paymentReads > 0, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
