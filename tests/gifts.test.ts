/**
 * Gifts: the buyer pays, somebody else owns it.
 *
 * Measured before it was built (30 September 2026): Gumroad lets a buyer give
 * a product; Stan's help center has no way to buy for someone else. What is
 * checked:
 *
 *   - what can be given, and what cannot;
 *   - the checkout is one plain payment marked as a gift;
 *   - the buyer's own checkout opens nothing (deliveredIds);
 *   - once paid, the recipient has it on their own address, with a course
 *     dated from the payment, and one email; the buyer gets a receipt; twice
 *     is still once;
 *   - the recipient's list of purchases says who it was from;
 *   - a full refund takes it back;
 *   - a product with price options is given at the one the buyer picked: its
 *     price is charged, and its link is what the recipient opens.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { canGift, givableOptions } from "@/lib/gift-rules";
import { deliverGift, readGift, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { deliveredIds } from "@/lib/bundle-rules";
import { importedFor } from "@/lib/imported-purchases";
import { purchasesFor } from "@/lib/buyer-orders";
import { createCheckout } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[]; subject: string; text: string };
const emails: Sent[] = [];
const checkouts: URLSearchParams[] = [];
let refunds: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"g".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/refunds") return answer({ object: "list", data: refunds, has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const base = (over: Partial<Listing>): Listing =>
  ({ id: "x", priceCents: 2900, recurring: null, call: null, pwyw: null, keys: null, options: [], file: null, link: "https://example.com", course: null, bundle: null, ...over }) as Listing;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gifts_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_gifts_only";

  part("What can be given");
  is("a paid download", canGift(base({})), true);
  is("not something free", canGift(base({ priceCents: 0 })), false);
  is("not a membership", canGift(base({ recurring: { interval: "month" } as Listing["recurring"] })), false);
  is("not a call", canGift(base({ call: {} as Listing["call"] })), false);
  is("not with price options that hand nothing over", canGift(base({ options: [{ id: "a", priceCents: 900, file: null, link: null }] as Listing["options"] })), false);
  const withOptions = base({ link: null, options: [{ id: "a", priceCents: 900, file: null, link: "https://example.com/a" }, { id: "b", priceCents: 0, file: null, link: "https://example.com/b" }, { id: "c", priceCents: 500, file: null, link: null }] as Listing["options"] });
  is("with price options, at one that is paid and hands something over", [canGift(withOptions), givableOptions(withOptions).map((o) => o.id)], [true, ["a"]]);
  is("a course at several prices: every paid one", givableOptions(base({ link: null, course: {} as Listing["course"], options: [{ id: "a", priceCents: 900, file: null, link: null }] as Listing["options"] })).length, 1);
  is("not with license keys", canGift(base({ keys: {} as Listing["keys"] })), false);
  is("not something that hands over nothing", canGift(base({ link: null })), false);

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/course");
  let store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;

  part("Who it is for");
  const bad = await startGift(store, product, { to: "nope", from: "Ana", message: "" });
  is("an address that is not one", bad.ok ? "started" : bad.reason, "email");
  const started = await startGift(store, product, { to: "Friend@Example.com", from: "  Ana  ", message: "Happy birthday!\n\n\n\nEnjoy." });
  if (!started.ok) throw new Error("no gift");
  is("kept, the address as one", [started.gift.to, started.gift.from, started.gift.message], ["friend@example.com", "Ana", "Happy birthday!\n\nEnjoy."]);

  part("Its checkout");
  await createCheckout(store, (await readProduct(store, product.id))!, "https://marktmorgen.com", "", { gift: started.gift.id, bumps: ["yes"], plan: true, upsellKey: "f".repeat(40), digitalConsent: TEST_CONSENT });
  const sent = checkouts[0];
  is("marked as a gift", [sent.get("metadata[gift]"), sent.get("payment_intent_data[metadata][gift]")], [started.gift.id, started.gift.id]);
  is("one payment, nothing added, no offer after", [sent.get("mode"), sent.get("line_items[1][quantity]"), sent.get("metadata[upsell_key]"), sent.get("customer_creation")], ["payment", null, null, null]);

  part("The buyer's own checkout");
  const meta = { store: "harbor", product: product.id, gift: started.gift.id };
  is("opens nothing for whoever paid", deliveredIds(meta), []);
  is("an ordinary one still does", deliveredIds({ store: "harbor", product: product.id }), [product.id]);

  part("Once paid");
  const started2: string[] = [];
  const session = {
    id: "cs_test_" + "g".repeat(24),
    created: 1_900_000_000,
    amount_total: 4900,
    currency: "usd",
    payment_intent: "pi_Gift0000001",
    metadata: meta,
    customer_details: { email: "buyer@example.com" },
  };
  const deliver = () =>
    deliverGift({
      store,
      session,
      product,
      base: "https://marktmorgen.com/@harbor",
      from: '"Harbor Kitchen" <hello@marktmorgen.com>',
      recordStart: async (email, id, start) => void started2.push(`${email}|${id}|${start}`),
      ordersLink: async (email) => `https://marktmorgen.com/@harbor/orders?token=${"a".repeat(64)}&for=${email}`,
    });
  is("given", await deliver(), "given");
  is("twice is once", await deliver(), "already");
  store = (await storeForEmail("owner@example.com"))!;
  is("it is the recipient's", (await importedFor(store, "friend@example.com")).map((p) => [p.productId, p.job]), [[product.id, `gift:${started.gift.id}`]]);
  is("a course would be dated from the payment", started2, [`friend@example.com|${product.id}|1900000000`]);
  const toFriend = emails.find((e) => e.to[0] === "friend@example.com");
  is("the recipient's one email: who, the message, the way in", Boolean(toFriend?.subject === "Ana sent you a gift: Sourdough Course" && toFriend.text.includes("Happy birthday!") && toFriend.text.includes("/orders?token=")), true);
  const receipt = emails.find((e) => e.to[0] === "buyer@example.com");
  is("the buyer's receipt says who it went to and what was paid", Boolean(receipt?.text.includes("For: friend@example.com") && receipt.text.includes("$49")), true);
  is("two emails in all", emails.length, 2);
  const listed = await purchasesFor({ ...store, stripeAccountId: null }, "friend@example.com");
  is("on the recipient's list, as a gift from Ana", listed.map((p) => [p.title, p.giftFrom]), [["Sourdough Course", "Ana"]]);
  is("remembered, with its payment", (await readGift(started.gift.id))?.pi, "pi_Gift0000001");

  part("A refund");
  const dropped: string[] = [];
  // Rule 23 (decision 18, lib/refunds.ts refundRowState): the refund carries its amount and its charge its amount, as
  // Stripe sends them, so a refund of the whole charge reads as given back by itself.
  refunds = [{ id: "re_1", created: Math.floor(Date.now() / 1000), status: "succeeded", amount: 2500, payment_intent: "pi_Gift0000001", charge: { refunded: true, amount: 2500 } }];
  // The course first, then the purchase (Codex G on #2781; rule 30): a course removal that fails keeps the purchase,
  // so the next run takes both away again.
  await revokeRefundedGifts(store, Date.now() + 10_000, async () => { throw new Error("the ledger did not answer"); }).catch(() => 0);
  is("a course removal that fails keeps the purchase for the next run", (await importedFor(store, "friend@example.com")).length, 1);
  is("a full refund takes it back", await revokeRefundedGifts(store, Date.now() + 10_000, async (email, id) => void dropped.push(`${email}|${id}`)), 1);
  is("from the recipient's purchases", (await importedFor(store, "friend@example.com")).length, 0);
  is("and their course", dropped, [`friend@example.com|${product.id}`]);
  is("read once", await revokeRefundedGifts(store, Date.now() + 10_000, async () => {}), 0);

  part("At one of several prices");
  const pack = await addProduct("owner@example.com", "Meal Planner", "", "27", null);
  if (!pack.ok) throw new Error("no second product");
  const one = await addOption("owner@example.com", pack.product.id, "1 week", "27");
  const five = await addOption("owner@example.com", pack.product.id, "5 weeks", "39");
  if (!one.ok || !five.ok) throw new Error("no options");
  store = (await storeForEmail("owner@example.com"))!;
  let planner = (await readProduct(store, pack.product.id))!;
  const [first, second] = planner.options;
  await setProductLink("owner@example.com", first.id, "https://example.com/one-week");
  await setProductLink("owner@example.com", second.id, "https://example.com/five-weeks");
  store = (await storeForEmail("owner@example.com"))!;
  planner = (await readProduct(store, pack.product.id))!;
  const none = await startGift(store, planner, { to: "pal@example.com", from: "Ana", message: "" });
  is("no option named: refused, never guessed", none.ok ? "started" : none.reason, "option");
  const picked = await startGift(store, planner, { to: "pal@example.com", from: "Ana", message: "" }, second.id);
  if (!picked.ok) throw new Error("no gift at an option");
  is("the option is kept with the gift", picked.gift.o, second.id);
  await createCheckout(store, planner, "https://marktmorgen.com", second.id, { gift: picked.gift.id, digitalConsent: TEST_CONSENT });
  const optioned = checkouts.at(-1)!;
  is("its price is what is charged", [optioned.get("line_items[0][price_data][unit_amount]"), optioned.get("metadata[option]"), optioned.get("metadata[gift]")], ["3900", second.id, picked.gift.id]);
  emails.length = 0;
  await deliverGift({
    store,
    session: { ...session, id: "cs_test_" + "o".repeat(24), payment_intent: "pi_Gift0000002", amount_total: 3900, metadata: { store: "harbor", product: planner.id, option: second.id, gift: picked.gift.id } },
    product: planner,
    base: "https://marktmorgen.com/@harbor",
    from: '"Harbor Kitchen" <hello@marktmorgen.com>',
    recordStart: async () => {},
    ordersLink: async () => null,
  });
  is("both emails name it", emails.map((e) => e.subject).sort(), ["Ana sent you a gift: Meal Planner (5 weeks)", "Your gift is on its way: Meal Planner (5 weeks)"]);
  const theirs = await purchasesFor({ ...store, stripeAccountId: null }, "pal@example.com");
  is("the recipient opens that option, and no other", theirs.map((p) => [p.title, p.option, p.main?.link]), [["Meal Planner", "5 weeks", "https://example.com/five-weeks"]]);

  done();
}

void main();
