/**
 * A purchase email whose send is not known (rule 30, a sibling of 283 [HG2]
 * unit 1's sendEmailOutcome): lib/purchase-email.ts resendPurchase and
 * confirmOffer, and the studio's "Send the purchase email again"
 * (app/api/store/resend/route.ts).
 *
 * sendEmail answers false also when the sender's answer is not known (a
 * timeout, a 5xx, a network error after the request may have reached it).
 * Found 9 November 2026: the creator then read "The email service did not
 * take it just now. Try again", pressed again, and the buyer got a second
 * copy; and an offer taken after paying whose confirmation was not known
 * stayed out of the month's orders (lib/orders.ts). Checked:
 *
 *   - resend, the sender answers 500: "uncertain", never "failed"; the
 *     route answers error "uncertain" (the studio says sending could not be
 *     confirmed and to check with the buyer before trying again);
 *   - resend, a thrown request (network error): the same;
 *   - resend, a 422 (a certain refusal): "failed" as before (control);
 *   - resend, a plain yes: "sent" (control);
 *   - offer, the sender answers 500: counted once in the month's orders, its
 *     mark kept, so it is never sent again; answered "uncertain";
 *   - offer, a 422: not counted, its mark let go (control: unchanged);
 *   - offer, a plain yes: sent and counted once (control).
 *
 * Stripe and the sender are played by a stand-in for `fetch`; synthetic
 * records only, no real email is sent.
 */
import { NextRequest } from "next/server";
import { POST as resendRoute } from "@/app/api/store/resend/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmOffer, resendPurchase } from "@/lib/purchase-email";
import { storeOrdersThisMonth } from "@/lib/orders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

/** Every recipient the sender was asked for, taken or not. */
const asked: string[] = [];
/** How the sender answers the next requests, when not plainly yes. */
let senderAnswer: (() => Response) | null = null;
/** Checkouts as the creator's Stripe account would answer for them, by id. */
const onStripe = new Map<string, unknown>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const to = [(JSON.parse(String(init?.body)) as { to: string | string[] }).to].flat()[0] ?? "";
    asked.push(to);
    if (senderAnswer) return senderAnswer();
    return new Response(JSON.stringify({ id: `email_${asked.length}` }));
  }
  const kept = onStripe.get(url.pathname.replace(/^\/v1\/checkout\/sessions\//, ""));
  if (kept) return new Response(JSON.stringify(kept));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const SERVER_ERROR = () => new Response("{}", { status: 500 });
const REFUSED = () => new Response(JSON.stringify({ message: "not a valid address" }), { status: 422 });
const THROWN = () => { throw new TypeError("network error"); };

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_uncertain_purchase_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const OWNER = "owner-uncertain@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestUnsure0001", true);
  await setSubscription(OWNER, { customerId: "cus_Unsure00001", subscriptionId: "sub_Unsure00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const BUYER = "buyer@example.com";

  const sale = (id: string) => ({
    id,
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created: 1_900_000_000,
    amount_total: 4900,
    currency: "usd",
    payment_intent: { id: `pi_${id.slice(-12)}`, latest_charge: { refunded: false, amount_refunded: 0 } },
    metadata: { store: "harbor", product: product.id },
    customer_details: { email: BUYER },
  });
  const asking = async (id: string, answer: (() => Response) | null) => {
    onStripe.set(id, sale(id));
    senderAnswer = answer;
    const before = asked.length;
    const outcome = await resendPurchase(store, id);
    senderAnswer = null;
    return { outcome, requests: asked.length - before };
  };

  part("Sent again from the studio, the sender's answer not known");
  const first = await asking(`cs_test_${"a".repeat(24)}`, SERVER_ERROR);
  is("a 500 is not a refusal: uncertain, the request made", [first.outcome, first.requests > 0], ["uncertain", true]);
  const thrown = await asking(`cs_test_${"b".repeat(24)}`, THROWN);
  is("a thrown request is not a refusal either", [thrown.outcome, thrown.requests > 0], ["uncertain", true]);

  part("A certain refusal and a plain yes keep their answers (controls)");
  is("a 422: failed, as before", (await asking(`cs_test_${"c".repeat(24)}`, REFUSED)).outcome, "failed");
  is("a plain yes: sent", (await asking(`cs_test_${"d".repeat(24)}`, null)).outcome, "sent");

  part("The studio's button through its route");
  const session = await openSession(OWNER);
  const press = async (reference: string, answer: (() => Response) | null) => {
    onStripe.set(reference, sale(reference));
    senderAnswer = answer;
    const response = await resendRoute(
      new NextRequest(`https://marktmorgen.com/api/store/resend?store=${store.sid}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" },
        body: JSON.stringify({ reference }),
      }),
    );
    senderAnswer = null;
    return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string } };
  };
  const unsure = await press(`cs_test_${"e".repeat(24)}`, SERVER_ERROR);
  is("not known: the route says uncertain, never failed (the studio then says to check before trying again)", [unsure.status, unsure.body], [502, { ok: false, error: "uncertain" }]);
  const refused = await press(`cs_test_${"f".repeat(24)}`, REFUSED);
  is("a certain refusal: failed, as before (control)", [refused.status, refused.body], [502, { ok: false, error: "failed" }]);

  part("An offer taken after paying, its confirmation not known");
  const offer = (n: string) => ({ reference: `pi_Offer${n.repeat(12)}`, parent: `cs_test_${n.repeat(24)}`, product, email: BUYER, amountCents: 1900, currency: "usd" });
  const orders0 = await storeOrdersThisMonth(store);
  senderAnswer = SERVER_ERROR;
  let before = asked.length;
  const unknown = await confirmOffer(store, offer("g"));
  is("answered uncertain, the request made", [unknown, asked.length - before > 0], ["uncertain", true]);
  is("counted once in the month's orders: it was paid, and its email may have gone", await storeOrdersThisMonth(store), orders0 + 1);
  senderAnswer = null;
  before = asked.length;
  is("its mark kept: never sent again", [await confirmOffer(store, offer("g")), asked.length - before], ["already", 0]);
  is("and counted only once", await storeOrdersThisMonth(store), orders0 + 1);

  part("An offer: a certain refusal and a plain yes (controls)");
  senderAnswer = REFUSED;
  is("a 422: failed, not counted (unchanged)", [await confirmOffer(store, offer("h")), await storeOrdersThisMonth(store)], ["failed", orders0 + 1]);
  senderAnswer = null;
  is("its mark let go: tried again, sent and counted", [await confirmOffer(store, offer("h")), await storeOrdersThisMonth(store)], ["sent", orders0 + 2]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
