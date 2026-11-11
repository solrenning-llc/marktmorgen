/**
 * A gift and a purchase for several people, through the door every paid
 * checkout goes through (lib/purchase-email.ts confirmPurchase).
 *
 * Found on 7 October 2026, while building purchases for several people: a
 * paid gift was never handed over. The confirmation looked for the gift's
 * product in the list of what the checkout hands to whoever paid — which for
 * a gift is nothing, by design — found none, and stopped. The buyer was
 * charged and told "we are emailing them now"; nobody was emailed. The tests
 * of gifts called the delivery itself and never this door. What is checked:
 *
 *   - a paid gift, confirmed: the recipient has it and both emails went;
 *   - a paid purchase for several, confirmed: its link works and the buyer's
 *     receipt went;
 *   - either one confirmed again does nothing more;
 *   - the creator can send the buyer of several places their link again;
 *   - an unpaid one is left alone.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { startGift } from "@/lib/gifts";
import { openGroup, startGroup } from "@/lib/group-buy";
import { canConfirm, confirmPurchase, resendPurchase } from "@/lib/purchase-email";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const emails: { to: string[]; subject: string; text: string }[] = [];
/** Checkouts as the creator's Stripe account would answer for them, by id. */
const onStripe = new Map<string, unknown>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const kept = onStripe.get(url.pathname.replace(/^\/v1\/checkout\/sessions\//, ""));
  if (kept) return new Response(JSON.stringify(kept));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url.pathname}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_others_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_others_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  is("this store's buyers can be confirmed", canConfirm(store), true);

  const paid = (id: string, metadata: Record<string, string>, over: Record<string, unknown> = {}) =>
    ({
      id,
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      created: Math.floor(Date.now() / 1000) - 60,
      amount_total: 4900,
      currency: "usd",
      payment_intent: `pi_${id.slice(-12)}`,
      metadata: { store: "harbor", product: product.id, ...metadata },
      customer_details: { email: "buyer@example.com" },
      ...over,
    }) as never;

  part("A gift");
  const gift = await startGift(store, product, { to: "friend@example.com", from: "Ana", message: "" });
  if (!gift.ok) throw new Error("no gift");
  const giftSession = "cs_test_" + "g".repeat(24);
  is("unpaid: left alone", await confirmPurchase(store, giftSession, paid(giftSession, { gift: gift.gift.id }, { payment_status: "unpaid" })), "skip");
  is("paid: handed over", await confirmPurchase(store, giftSession, paid(giftSession, { gift: gift.gift.id })), "sent");
  is("it is the recipient's", (await importedFor((await storeForEmail("owner@example.com"))!, "friend@example.com")).map((p) => p.productId), [product.id]);
  is("one email each: the recipient and the buyer", emails.map((e) => e.to[0]).sort(), ["buyer@example.com", "friend@example.com"]);
  is("again: nothing more", [await confirmPurchase(store, giftSession, paid(giftSession, { gift: gift.gift.id })), emails.length], ["already", 2]);

  part("A purchase for several people");
  const group = await startGroup(store, product, "4");
  if (!group.ok) throw new Error("no purchase for several");
  const groupSession = "cs_test_" + "h".repeat(24);
  const meta = { group: group.group.id, people: "4" };
  is("unpaid: its link opens nothing", [await confirmPurchase(store, groupSession, paid(groupSession, meta, { payment_status: "unpaid" })), await openGroup(store, group.group.id)], ["skip", null]);
  is("paid: its link works", [await confirmPurchase(store, groupSession, paid(groupSession, meta, { amount_total: 19_600 })), (await openGroup(store, group.group.id))?.people], ["sent", 4]);
  is("the buyer's receipt went", emails.at(-1)?.subject, "Your 4 places: Sourdough Course");
  is("again: nothing more", [await confirmPurchase(store, groupSession, paid(groupSession, meta)), emails.length], ["already", 3]);

  part("Sent again from the studio");
  onStripe.set(groupSession, paid(groupSession, meta, { amount_total: 19_600, payment_intent: { id: "pi_Group000009", latest_charge: { refunded: false } } }));
  is("the buyer gets the link again", [await resendPurchase(store, groupSession), emails.length], ["sent", 4]);
  is("said to be a copy, with the same link", Boolean(emails.at(-1)?.text.startsWith("Harbor Kitchen asked us to send you this again.") && emails.at(-1)?.text.includes(`/group/${group.group.id}`)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
