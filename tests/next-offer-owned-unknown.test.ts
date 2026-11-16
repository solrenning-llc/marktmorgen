/**
 * What a buyer already owns from a store (lib/next-offer.ts, ownedHere), read
 * from the creator's Stripe account in its exact shape (CX-123 rule 24, with
 * lib/stripe-list.ts). AGENTS.md: the next product is never "anything the
 * address bought here before ... unknown means nothing is shown".
 *
 * Only a list read to its end (`has_more` false) with every row readable says
 * "owns nothing more". A checkout-session or payment-intent list in any other
 * shape — no `data`, no `has_more`, `has_more` not true or false, `{}`, or a
 * row without its id, with metadata that is not an object of strings, or with
 * any other field the decision reads (a session's `status`, `payment_status`
 * and `customer`, an intent's `status`) missing or not one of Stripe's values
 * at the pinned API version — is unknown (Claude 2's review of #3265):
 *
 *   - ownedHere answers null, never an empty set;
 *   - the page after paying (nextOfferFor) shows nothing and keeps nothing,
 *     so the confirmation email (nextOfferForEmail) carries nothing either,
 *     no model is asked, and the order's lock is released so a later opening
 *     with readable lists can still choose.
 *
 * Controls: the documented lists still count both purchases as owned; a
 * confirmed empty list still says "owns nothing" and the paired product is
 * offered. Stripe and the model are played by a stand-in for `fetch`;
 * synthetic data only.
 */
import { addProduct, claimHandle, ensureStatsId, setAssistantPlan, setNextOffer, setProductLink, setProductPairs, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { nextOfferFor, nextOfferForEmail, ownedHere } from "@/lib/next-offer";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_next_offer_owned_only";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";

const OWNER = "owned.unknown@example.com";
const BUYER = "buyer.owned@example.com";

type Answer = (page: { bought: Record<string, unknown>; upsell: Record<string, unknown> }) => unknown;
const documentedSessions: Answer = ({ bought }) => ({ object: "list", data: [bought], has_more: false });
const documentedIntents: Answer = ({ upsell }) => ({ object: "list", data: [upsell], has_more: false });
let sessionsAnswer: Answer = documentedSessions;
let intentsAnswer: Answer = documentedIntents;
let groceryId = "";
let batchId = "";
let modelCalls = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.anthropic.com") {
    modelCalls += 1;
    return answer({ content: [{ type: "text", text: "{\"pick\":0,\"reason\":\"\"}" }], usage: { input_tokens: 10, output_tokens: 5 } });
  }
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected ${url}`);
  const path = url.pathname.replace(/^\/v1/, "");
  const rows = {
    bought: { id: "cs_test_ownedearlier01", object: "checkout.session", status: "complete", payment_status: "paid", customer: "cus_OwnedBuyer01", metadata: { store: "ownedshop", product: groceryId } },
    upsell: { id: "pi_OwnedUpsell001", object: "payment_intent", status: "succeeded", metadata: { kind: "upsell", store: "ownedshop", product: batchId } },
  };
  if (path === "/checkout/sessions") return answer(sessionsAnswer(rows));
  if (path === "/payment_intents") return answer(intentsAnswer(rows));
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const keptKey = (session: string) => `nl:assist:next:${session}`;
const lockKey = (session: string) => `nl:assist:nextlock:${session}`;
const rawOf = async (key: string) => (await redis.pipeline([["GET", key]]))[0];

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  await claimHandle(OWNER, "ownedshop", "Owned Shop", "Synthetic store.");
  await setSubscription(OWNER, { customerId: "cus_OwnedShop001", subscriptionId: "sub_OwnedPlan01", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
  await setStripeAccount(OWNER, "acct_fixtureOW", true);
  await ensureStatsId(OWNER);
  const make = async (title: string, summary: string, price: string) => {
    const made = await addProduct(OWNER, title, summary, price, null);
    if (!made.ok) throw new Error(title);
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const planner = await make("Meal Planner", "A week of dinners, planned.", "27");
  groceryId = await make("Grocery Lists", "Printable lists for every week.", "9");
  batchId = await make("Batch Course", "Cook on Sunday.", "49");
  await setNextOffer(OWNER, { on: true, email: true });
  await setAssistantPlan(OWNER, { subscriptionId: "sub_OwnedAsst01", active: true, period: paidPeriod(now), cancelsAtEnd: false, disputedAt: "" });
  await setProductPairs(OWNER, planner, [groceryId]);
  const store = (await storeForEmail(OWNER))!;
  const bought = [(await readListing(store, planner))!];
  let n = 0;
  const order = () => `cs_test_ownedorder${String((n += 1)).padStart(6, "0")}`;
  const ask = (session: string) => nextOfferFor({ store, session, email: BUYER, bought, alsoOwned: [], declined: [], now });

  part("Control: the documented lists");
  is("both purchases are read as owned", [...((await ownedHere(store, BUYER)) ?? [])].sort(), [groceryId, batchId].sort());
  is("the owned paired product is not offered", (await ask(order()))?.product.id === groceryId, false);

  part("Control: a confirmed empty list still says the address owns nothing");
  sessionsAnswer = () => ({ object: "list", data: [], has_more: false });
  const none = await ownedHere(store, BUYER);
  is("an empty set, not unknown", [none === null, none?.size], [false, 0]);
  is("the paired product is offered", (await ask(order()))?.product.id, groceryId);
  sessionsAnswer = documentedSessions;

  part("Control: a guest checkout (customer null, as Stripe gives it) is still read, with no one-click purchases to read");
  sessionsAnswer = ({ bought: row }) => ({ object: "list", data: [{ ...row, customer: null }], has_more: false });
  is("the checkout's product is owned, not unknown", [...((await ownedHere(store, BUYER)) ?? ["unknown"])], [groceryId]);
  sessionsAnswer = ({ bought: row }) => ({ object: "list", data: [{ ...row, metadata: {} }, row], has_more: false });
  is("a row of no store with empty metadata stays readable", [...((await ownedHere(store, BUYER)) ?? [])].sort(), [groceryId, batchId].sort());
  sessionsAnswer = documentedSessions;

  const unknownSessions: [string, Answer][] = [
    ["a list without data", () => ({ object: "list", url: "/v1/checkout/sessions" })],
    ["an empty page without has_more", () => ({ object: "list", data: [] })],
    ["has_more in text", ({ bought: row }) => ({ object: "list", data: [row], has_more: "false" })],
    ["an empty object", () => ({})],
    ["data that is not a list", ({ bought: row }) => ({ object: "list", data: { 0: row }, has_more: false })],
    ["the purchase's row without its id", ({ bought: row }) => ({ object: "list", data: [{ ...row, id: undefined }], has_more: false })],
    ["the purchase's row with metadata in text", ({ bought: row }) => ({ object: "list", data: [{ ...row, metadata: JSON.stringify(row.metadata) }], has_more: false })],
    ["a row that is not an object", ({ bought: row }) => ({ object: "list", data: [row, "cs_test_ownedgarbled01"], has_more: false })],
    ["more pages than are read", ({ bought: row }) => ({ object: "list", data: [row], has_more: true })],
    // Claude 2's review of #3265: legible on id and metadata, garbled on a field the decision reads.
    ["the purchase's row without payment_status", ({ bought: row }) => ({ object: "list", data: [{ ...row, payment_status: undefined }], has_more: false })],
    ["the purchase's row with payment_status null", ({ bought: row }) => ({ object: "list", data: [{ ...row, payment_status: null }], has_more: false })],
    ["the purchase's row with a payment_status Stripe does not give", ({ bought: row }) => ({ object: "list", data: [{ ...row, payment_status: "PAID" }], has_more: false })],
    ["the purchase's row with status as a number", ({ bought: row }) => ({ object: "list", data: [{ ...row, status: 1 }], has_more: false })],
    ["the purchase's row without status", ({ bought: row }) => ({ object: "list", data: [{ ...row, status: undefined }], has_more: false })],
    ["the purchase's row without customer", ({ bought: row }) => ({ object: "list", data: [{ ...row, customer: undefined }], has_more: false })],
    ["the purchase's row with customer as a number", ({ bought: row }) => ({ object: "list", data: [{ ...row, customer: 7 }], has_more: false })],
    ["the purchase's row with customer as an object", ({ bought: row }) => ({ object: "list", data: [{ ...row, customer: { id: "cus_OwnedBuyer01" } }], has_more: false })],
    ["the purchase's row with a customer that is not a customer id", ({ bought: row }) => ({ object: "list", data: [{ ...row, customer: "buyer01" }], has_more: false })],
    ["the purchase's row with metadata.product as a number", ({ bought: row }) => ({ object: "list", data: [{ ...row, metadata: { ...(row.metadata as object), product: 12 } }], has_more: false })],
    ["the purchase's row with metadata.store as a number", ({ bought: row }) => ({ object: "list", data: [{ ...row, metadata: { ...(row.metadata as object), store: 3 } }], has_more: false })],
    ["the purchase's row with metadata.bundle as a list", ({ bought: row }) => ({ object: "list", data: [{ ...row, metadata: { ...(row.metadata as object), bundle: ["x"] } }], has_more: false })],
  ];
  const unknownIntents: [string, Answer][] = [
    ["an empty object", () => ({})],
    ["a list without has_more", ({ upsell }) => ({ object: "list", data: [upsell] })],
    ["the one-click purchase's row without its id", ({ upsell }) => ({ object: "list", data: [{ ...upsell, id: 7 }], has_more: false })],
    ["the one-click purchase's row with metadata as a list", ({ upsell }) => ({ object: "list", data: [{ ...upsell, metadata: ["upsell"] }], has_more: false })],
    ["the one-click purchase's row without status", ({ upsell }) => ({ object: "list", data: [{ ...upsell, status: undefined }], has_more: false })],
    ["the one-click purchase's row with status as a number", ({ upsell }) => ({ object: "list", data: [{ ...upsell, status: 1 }], has_more: false })],
    ["the one-click purchase's row with a status Stripe does not give", ({ upsell }) => ({ object: "list", data: [{ ...upsell, status: "SUCCEEDED" }], has_more: false })],
    ["the one-click purchase's row with metadata null", ({ upsell }) => ({ object: "list", data: [{ ...upsell, metadata: null }], has_more: false })],
    ["the one-click purchase's row with metadata.product as a number", ({ upsell }) => ({ object: "list", data: [{ ...upsell, metadata: { ...(upsell.metadata as object), product: 12 } }], has_more: false })],
    ["the one-click purchase's row with metadata.kind as a number", ({ upsell }) => ({ object: "list", data: [{ ...upsell, metadata: { ...(upsell.metadata as object), kind: 1 } }], has_more: false })],
  ];

  const refuses = async (label: string) => {
    const owned = await ownedHere(store, BUYER);
    is(`${label}: what the address owns is unknown (null)`, owned === null ? null : [...owned].sort(), null);
    const session = order();
    const before = modelCalls;
    is(`${label}: nothing is offered after paying`, (await ask(session).catch(() => "threw")) ?? null, null);
    is(`${label}: no choice is kept for the order`, await rawOf(keptKey(session)), null);
    is(`${label}: the confirmation email carries no next product`, await nextOfferForEmail(store, session, { news: "yes" }).catch(() => null), null);
    is(`${label}: the order's lock is released`, await rawOf(lockKey(session)), null);
    is(`${label}: no model call`, modelCalls - before, 0);
    return session;
  };

  for (const [label, shape] of unknownSessions) {
    part(`Checkout sessions answered with ${label}`);
    sessionsAnswer = shape;
    await refuses(`sessions, ${label}`);
    sessionsAnswer = documentedSessions;
  }
  let retried = "";
  for (const [label, shape] of unknownIntents) {
    part(`Payment intents answered with ${label}`);
    intentsAnswer = shape;
    retried = await refuses(`intents, ${label}`);
    intentsAnswer = documentedIntents;
  }

  part("Control: the same order opened again once the lists are readable");
  const later = await ask(retried);
  is("it never offers a product the address owns (every other one is owned: nothing)", [later === null, later ? [groceryId, batchId].includes(later.product.id) : null], [true, null]);
  is("both purchases are read as owned again", [...((await ownedHere(store, BUYER)) ?? [])].sort(), [groceryId, batchId].sort());
  is("no model call in the whole run", modelCalls, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
