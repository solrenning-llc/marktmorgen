/**
 * A reminder of a whole cart left at its checkout (added 10 October 2026,
 * lib/checkout-recovery.ts and lib/checkout-ask.ts). What is checked:
 *
 *   - a store with reminders on opens a cart's checkout asking Stripe for
 *     consent where it offers to, and its way back leads to a page that
 *     offers one reminder of the cart; a store without keeps the old way;
 *   - a cart left with Stripe's yes gets one email naming everything in it
 *     that can still be bought, at today's prices, with a link that puts the
 *     cart back as it was; never twice for the same cart in a week, never
 *     after one of them was paid for, never with nothing left to sell;
 *   - a cart's reminder asked for on the way back waits in the same queue and
 *     comes out as the same email, saying it was asked for.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCartCheckout } from "@/lib/cart-checkout";
import { cartLink, remindAbandoned } from "@/lib/checkout-recovery";
import { askCartReminder, sendAsked } from "@/lib/checkout-ask";
import { allowanceUsed } from "@/lib/store-allowance";
import { cartAskIds, cartAskKey } from "@/lib/checkout-ask-cart";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const checkouts: URLSearchParams[] = [];
const emails: { to: string; subject: string; text: string }[] = [];
let paidSessions: Record<string, unknown>[] = [];
/** The email service saying no (a 400): it did not take the email. */
let mailDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    if (mailDown) return new Response("not taken", { status: 400 });
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return answer({ id: `email_${emails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"c".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/checkout/sessions" && method === "GET") return answer({ object: "list", data: paidSessions, has_more: false });
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_cart_reminder_stand_in";
  process.env.RESEND_API_KEY = "re_test_cart_reminder_only";

  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const a = await add("Pantry Guide", "12");
  const b = await add("Grocery Lists", "5");
  const load = async () => (await storeForEmail(OWNER))!;
  const both = async () => {
    const store = await load();
    return [(await readProduct(store, a))!, (await readProduct(store, b))!];
  };

  part("The checkout of a cart");
  await createCartCheckout(await load(), await both(), "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  is("without reminders: the way back it always had, and Stripe asked nothing", [checkouts[0].get("cancel_url"), checkouts[0].get("consent_collection[promotions]")], ["https://marktmorgen.com/@harbor", null]);
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Austin, TX 78701", asks: true });
  checkouts.length = 0;
  await createCartCheckout(await load(), await both(), "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  is("with them: Stripe asks for consent, and keeps the address if the buyer leaves", [checkouts[0].get("consent_collection[promotions]"), checkouts[0].get("after_expiration[recovery][enabled]")], ["auto", "true"]);
  is("and the way back offers one reminder of the cart", checkouts[0].get("cancel_url"), `https://marktmorgen.com/@harbor/left?cart=${a},${b}`);

  part("A cart left with Stripe's yes");
  const now = Math.floor(Date.now() / 1000);
  const left = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    object: "checkout.session",
    status: "expired",
    payment_status: "unpaid",
    created: now - 3700,
    expires_at: now - 100,
    consent: { promotions: "opt_in" },
    customer_details: { email: "ana@example.com" },
    metadata: { store: "harbor", product: a, bump: b, cart: "yes" },
    ...over,
  });
  is("not without the yes", await remindAbandoned(await load(), left("cs_test_noyes000000001", { consent: { promotions: "opt_out" } }) as never), "skip");
  is("with it: one email", await remindAbandoned(await load(), left("cs_test_cartleft000001") as never), "sent");
  const mail = emails.at(-1)!;
  is("to the buyer, about their cart", [mail.to, mail.subject], ["ana@example.com", "Your cart at Harbor Kitchen"]);
  is("naming everything in it, at today's prices", [mail.text.includes("You put Pantry Guide and Grocery Lists in your cart at Harbor Kitchen"), mail.text.includes("- Pantry Guide: $12"), mail.text.includes("- Grocery Lists: $5")], [true, true, true]);
  is("with the link that puts the cart back as it was", mail.text.includes(cartLink(await load(), [a, b])), true);
  is("and why it came, the stop link and the creator's address", [mail.text.includes("you agreed, on the checkout page"), mail.text.includes("Stop these reminders"), mail.text.includes("1 Main St, Austin, TX 78701")], [true, true, true]);
  is("never twice for that checkout", await remindAbandoned(await load(), left("cs_test_cartleft000001") as never), "skip");
  is("nor for the same cart, in any order, in a week", await remindAbandoned(await load(), left("cs_test_cartleft000002", { metadata: { store: "harbor", product: b, bump: a, cart: "yes" } }) as never), "skip");
  paidSessions = [{ id: "cs_test_paid0000000001", status: "complete", payment_status: "paid", metadata: { store: "harbor", product: b } }];
  is("nor to somebody who has paid for one of them since", await remindAbandoned(await load(), left("cs_test_cartleft000003", { customer_details: { email: "ben@example.com" } }) as never), "skip");
  paidSessions = [];
  is("nor about products that cannot be sold any more", await remindAbandoned(await load(), left("cs_test_cartleft000004", { customer_details: { email: "cy@example.com" }, metadata: { store: "harbor", product: "nothing01", cart: "yes" } }) as never), "skip");

  part("A cart's reminder, asked for on the way back");
  is("the ask keeps the cart's products where a product's id would be", [cartAskKey([a, b]), cartAskIds(cartAskKey([a, b])), cartAskIds(a)], [`cart:${a},${b}`, [a, b], null]);
  const asked = await askCartReminder({ store: await load(), items: await both(), email: "dee@example.com", ip: "203.0.113.9" });
  is("kept", asked, "asked");
  const before = emails.length;
  const sent = await sendAsked(async () => load(), Date.now() + 10_000);
  is("nothing goes before its hour", [sent.sent, emails.length], [0, before]);
  // An hour later, as the five-minute job finds it.
  const realNow = Date.now;
  Date.now = () => realNow() + 3_700_000;
  const later = await sendAsked(async () => load(), Date.now() + 10_000);
  Date.now = realNow;
  const askedMail = emails.at(-1)!;
  is("then one email about the cart, saying it was asked for", [later.sent, askedMail.to, askedMail.subject, askedMail.text.includes("you asked for it on Harbor Kitchen's store")], [1, "dee@example.com", "Your cart at Harbor Kitchen", true]);

  // Claude 2 on #3214: the email service's answer cannot tell a refusal (a 4xx, an address it will never take, an
  // uncertain SES answer) from a failure that may pass, and each ask takes the store's email room again. So an ask the
  // email service was asked for is never put back.
  part("An asked-for reminder the email service did not take is never tried again");
  is("kept", await askCartReminder({ store: await load(), items: await both(), email: "eve@example.com", ip: "203.0.113.10" }), "asked");
  const toEve = () => emails.filter((m) => m.to === "eve@example.com").length;
  const roomBefore = await allowanceUsed(await load(), "email");
  is("the store's email room is read", roomBefore > 0, true);
  const queued = async () => {
    const [members] = await redis.pipeline([["ZRANGEBYSCORE", "nl:recover:asks", "-inf", "+inf"]]);
    return ((members as string[]) ?? []).filter((m) => m.includes("eve@example.com")).length;
  };
  mailDown = true;
  Date.now = () => realNow() + 3_700_000;
  const refused = await sendAsked(async () => load(), Date.now() + 10_000);
  Date.now = realNow;
  mailDown = false;
  is("not sent, and not put back", [refused.sent, refused.retried, toEve(), await queued()], [0, 0, 0, 0]);
  is("its room taken once, for the one ask", (await allowanceUsed(await load(), "email")) - roomBefore, 1);
  for (let run = 1; run <= 4; run += 1) {
    Date.now = () => realNow() + 3_700_000 + run * 1_200_000;
    await sendAsked(async () => load(), Date.now() + 10_000);
    Date.now = realNow;
  }
  is("no later run sends it or takes more of the store's email room", [toEve(), (await allowanceUsed(await load(), "email")) - roomBefore], [0, 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
