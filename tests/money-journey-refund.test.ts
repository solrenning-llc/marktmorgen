/**
 * One sale followed from paid to refunded through every door it opens, with the
 * same checkout and the same charge (gap 1 and 6 of the money-journey test
 * inventory, 12 November 2026: the refund tests built a fresh refunded payment
 * for each door, so nothing showed that the very sale a buyer was handed is the
 * one taken back everywhere once Stripe refunds it).
 *
 * Against a stand-in for the creator's Stripe account, a buyer pays for a
 * course and for an app with a license key. While paid, the download link
 * (lib/store-checkout.ts readOrder), the course (lib/learn.ts paidCourses), the
 * community (lib/community-access.ts paidForAny), the list of purchases
 * (lib/buyer-orders.ts purchasesFor) and the key (lib/licence-keys.ts) are all
 * open. The same charges are then refunded in full on Stripe: each door closes,
 * once the few minutes a door keeps its answer have passed (forgetPaid,
 * forgetTicket stand for that), and the five-minute job (revokeRefunded)
 * revokes the key. A partial refund of another buyer's same purchase closes
 * nothing. Synthetic Stripe and in-memory Redis only; nothing real is reached.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { forgetPaid, paidCourses, recordEnrollment } from "@/lib/learn";
import { forgetTicket, paidForAny } from "@/lib/community-access";
import { purchasesFor } from "@/lib/buyer-orders";
import { readOrder } from "@/lib/store-checkout";
import { checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_money_journey_only";

const OWNER = "journey-maker@example.com";
const HANDLE = "journeypaint";
const ACCOUNT = "acct_1TestJourney01";
const NOW = Math.floor(Date.now() / 1000);
const AMOUNT = 4900;

/** The creator's Stripe account: checkouts, their charges (changed in place when refunded) and its refunds. */
const charges = new Map<string, { id: string; amount: number; amount_refunded: number; refunded: boolean }>();
const checkouts = new Map<string, Record<string, unknown>>();
const refunds: Record<string, unknown>[] = [];

const sessionOf = (id: string, product: string, email: string) => {
  const chargeId = `ch_${id.slice(8)}`;
  charges.set(chargeId, { id: chargeId, amount: AMOUNT, amount_refunded: 0, refunded: false });
  checkouts.set(id, {
    id,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: NOW - 86_400,
    customer: `cus_${id.slice(8, 22)}`,
    customer_details: { email },
    amount_total: AMOUNT,
    metadata: { store: HANDLE, product },
    payment_intent: `pi_${id.slice(8)}`,
  });
};

/** A checkout as Stripe answers it now, its payment and charge expanded, read from the charge as it stands. */
const expanded = (id: string) => {
  const session = checkouts.get(id)!;
  const pi = String(session.payment_intent);
  return { ...session, payment_intent: { id: pi, object: "payment_intent", latest_charge: { object: "charge", disputed: false, ...charges.get(`ch_${pi.slice(3)}`)! } } };
};

/** Stripe refunding a charge, in full or in part: the charge changes and a refund is listed. */
function refund(session: string, cents: number) {
  const pi = String(checkouts.get(session)!.payment_intent);
  const charge = charges.get(`ch_${pi.slice(3)}`)!;
  charge.amount_refunded += cents;
  charge.refunded = charge.amount_refunded >= charge.amount;
  refunds.unshift({ id: `re_${pi.slice(3)}${refunds.length}`, object: "refund", status: "succeeded", amount: cents, created: NOW - 60, payment_intent: pi, charge: { object: "charge", disputed: false, ...charge } });
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const pi = url.searchParams.get("payment_intent");
    if (pi) return list([...checkouts.keys()].filter((id) => checkouts.get(id)!.payment_intent === pi).map(expanded));
    const email = url.searchParams.get("customer_details[email]") ?? "";
    return list([...checkouts.keys()].filter((id) => (checkouts.get(id)!.customer_details as { email: string }).email === email).map(expanded));
  }
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) return checkouts.has(one[1]) ? answer(expanded(one[1])) : answer({ error: { message: "no such" } }, 404);
  const read = /^\/charges\/(ch_[A-Za-z0-9_]+)$/.exec(path);
  if (read) return charges.has(read[1]) ? answer({ object: "charge", disputed: false, ...charges.get(read[1])! }) : answer({ error: { message: "no such" } }, 404);
  if (path === "/refunds") return list(refunds);
  return list([]);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Journey Paint", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_JourneyOwner1", subscriptionId: "sub_JourneyOwner1", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Watercolor Basics", "", "49", null);
  const tool = await addProduct(OWNER, "Palette App", "", "49", null);
  if (!made.ok || !tool.ok) throw new Error("no products");
  const course = made.product.id;
  await setProductCourse(OWNER, course, { id: "b".repeat(32), lessons: 4 });
  await setProductLink(OWNER, tool.product.id, "https://example.com/palette-app");
  await setProductKeys(OWNER, tool.product.id, { source: "generated", prefix: "PAL", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, tool.product.id))!;
  const BUYER = "ruth@example.com";
  const ids = new Set([course]);
  const doors = async (email: string, sale: string) => ({
    download: (await readOrder(store, sale)).state,
    course: [...(await paidCourses(store, email)).keys()],
    community: await paidForAny(store, email, ids),
    purchases: (await purchasesFor(store, email)).map((p) => p.reference).sort(),
  });
  const again = async (email: string) => {
    await forgetPaid(store, email);
    await forgetTicket(store, email);
  };

  part("A buyer pays: every door the sale opens is open");
  sessionOf("cs_test_journeycourse01", course, BUYER);
  sessionOf("cs_test_journeyapp00001", tool.product.id, BUYER);
  await recordEnrollment(store, BUYER, course, NOW - 86_400);
  const given = await keyForSale(store, app, "cs_test_journeyapp00001", BUYER);
  if (given?.state !== "issued") throw new Error("no key");
  is("the download, the course, the community and both purchases", await doors(BUYER, "cs_test_journeycourse01"), {
    download: "paid",
    course: [course],
    community: true,
    purchases: ["cs_test_journeyapp00001", "cs_test_journeycourse01"],
  });
  is("and the key works", await checkKey(store, app, given.key), "valid");

  part("Stripe refunds the same two charges in full: every door closes");
  refund("cs_test_journeycourse01", AMOUNT);
  refund("cs_test_journeyapp00001", AMOUNT);
  await again(BUYER);
  is("the download link, the course, the community and the list of purchases", await doors(BUYER, "cs_test_journeycourse01"), {
    download: "refunded",
    course: [],
    community: false,
    purchases: [],
  });
  is("the app's own link closes too", (await readOrder(store, "cs_test_journeyapp00001")).state, "refunded");
  is("the five-minute job revokes the key of that sale", await revokeRefunded(store, Date.now() + 10_000), 1);
  is("which no longer works", await checkKey(store, app, given.key), "revoked");
  is("and is read once", await revokeRefunded(store, Date.now() + 10_000), 0);

  part("A partial refund of the same purchase closes nothing");
  const SAM = "sam@example.com";
  sessionOf("cs_test_journeypartial1", course, SAM);
  await recordEnrollment(store, SAM, course, NOW - 86_400);
  refund("cs_test_journeypartial1", 1000);
  await again(SAM);
  is("everything stays open", await doors(SAM, "cs_test_journeypartial1"), {
    download: "paid",
    course: [course],
    community: true,
    purchases: ["cs_test_journeypartial1"],
  });

  done();
}

void main();
