/**
 * The "Paid:" line of a buyer's confirmation (lib/purchase-email.ts), as
 * Stripe returned the checkout. Synthetic store, mocked Stripe and email.
 *
 *   - A membership whose discount came off the first charge only says what
 *     was paid today and what each charge after it is; a discount whose
 *     length cannot be read never becomes "the price every month".
 *   - An introductory price with sales tax added on top says what was
 *     charged today and that tax is added.
 *   - An amount, a currency or a discount figure that does not read
 *     (CX-123 rule 24) is never written as a value: no email, no "sent"
 *     mark, no order counted, and the next run tries again.
 *   - Controls: a one-time product, a membership with no discount and an
 *     introductory price with no tax on top read as before.
 */
import { createHash } from "node:crypto";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmPurchase, confirmationFor, confirmationKey } from "@/lib/purchase-email";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const emails: { to: string[]; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const OWNER = "owner@example.com";
const seenKey = (reference: string) => `nl:orders:seen:${createHash("sha256").update(reference).digest("hex").slice(0, 32)}`;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_paid_line_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no membership");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const guide = await addProduct(OWNER, "Sourdough Guide", "", "49", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  const store = (await storeForEmail(OWNER))!;
  const taxed = { ...store, tax: { ...store.tax, enabled: true, included: false } } as typeof store;
  const clubListing = (await readListing(store, club.product.id))!;
  const guideListing = (await readListing(store, guide.product.id))!;
  const now = Math.floor(Date.now() / 1000);
  const base = { object: "checkout.session", status: "complete", payment_status: "paid", currency: "usd", created: now, customer_details: { email: "buyer@example.com" } };
  const paidLine = (s: typeof store, session: unknown, listing = clubListing) =>
    (confirmationFor(s, session as never, now, [], [listing])?.text ?? "").split("\n").find((l) => l.startsWith("Paid:")) ?? "";

  const half = {
    ...base, mode: "subscription", amount_subtotal: 2000, amount_total: 1000,
    total_details: { amount_discount: 1000, amount_shipping: 0, amount_tax: 0 },
  };

  part("A $20 membership with a code that took 50% off: how long it lasts cannot be read from the checkout");
  const code = { ...half, id: "cs_test_paidline0code0001", metadata: { store: "harbor", product: club.product.id, code: "LAUNCH" } };
  is("today's amount, the regular price after it, and that the discount may go on",
    paidLine(store, code), "Paid: $10 today, with your discount. Each charge after this one: $20 a month, less your discount for as long as it lasts.");

  is("with no price before the discount on the checkout, no catalog price is put in its place",
    paidLine(store, { ...code, amount_subtotal: undefined }), "Paid: $10 today, with your discount. Each charge after this one is at the membership's regular price, less your discount for as long as it lasts.");

  part("The store sale (its coupon comes off the first charge only)");
  const sale = { ...half, id: "cs_test_paidline0sale0001", metadata: { store: "harbor", product: club.product.id, sale: "50" } };
  is("today's amount, then the regular price", paidLine(store, sale), "Paid: $10 today, with your discount. Each charge after this one: $20 a month.");
  is("with tax on top, the regular price says so", paidLine(taxed, sale), "Paid: $10 today, with your discount. Each charge after this one: $20 a month plus any sales tax.");

  part("The coupon as Stripe returned it, expanded");
  const once = { ...code, id: "cs_test_paidline0once0001", discounts: [{ coupon: { id: "LAUNCH", duration: "once" }, promotion_code: null }] };
  is("duration once: the regular price after today", paidLine(store, once), "Paid: $10 today, with your discount. Each charge after this one: $20 a month.");
  const forever = { ...code, id: "cs_test_paidline0ever0001", discounts: [{ coupon: { id: "LAUNCH", duration: "forever" }, promotion_code: null }] };
  is("duration forever: every charge has it, as before", paidLine(store, forever), "Paid: $10 a month");

  part("A code typed in Stripe's own box (no metadata, only the amount that came off)");
  const typed = { ...half, id: "cs_test_paidline0type0001", metadata: { store: "harbor", product: club.product.id } };
  is("not the discounted amount every month", /\$10 a month/.test(paidLine(store, typed)), false);
  is("the regular price after today", paidLine(store, typed).includes("Each charge after this one: $20 a month"), true);

  part("A whole first charge off: the next charges are still owed");
  const free = { ...half, id: "cs_test_paidline0free0001", amount_total: 0, total_details: { amount_discount: 2000, amount_shipping: 0, amount_tax: 0 }, metadata: { store: "harbor", product: club.product.id, sale: "100" } };
  is("not 'covered the whole price' for a membership", paidLine(store, free), "Paid: $0 today, with your discount. Each charge after this one: $20 a month.");

  part("Introductory price ($5 for 3 months, then $20) with tax on top: Stripe charged $5.41");
  const intro = {
    ...base, id: "cs_test_paidline0intr0001", mode: "subscription", amount_subtotal: 2000, amount_total: 541,
    total_details: { amount_discount: 1500, amount_shipping: 0, amount_tax: 41 },
    metadata: { store: "harbor", product: club.product.id, intro: "3", intro_cents: "500", regular_cents: "2000" },
  };
  is("what was charged, the schedule and the tax", paidLine(taxed, intro), "Paid: $5.41 today. The price: $5 a month for the first 3 months, then $20 a month, plus any sales tax.");
  is("control: no tax on top reads as before", paidLine(store, { ...intro, amount_total: 500, total_details: { amount_discount: 1500, amount_shipping: 0, amount_tax: 0 } }),
    "Paid: $5 a month for the first 3 months, then $20 a month");

  part("Controls");
  const plain = { ...base, id: "cs_test_paidline0plan0001", mode: "subscription", amount_subtotal: 2000, amount_total: 2000,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 }, metadata: { store: "harbor", product: club.product.id } };
  is("a membership with nothing off", paidLine(store, plain), "Paid: $20 a month");
  is("the same with no total_details at all", paidLine(store, { ...plain, total_details: undefined }), "Paid: $20 a month");
  const oneTime = { ...base, id: "cs_test_paidline0once1001", mode: "payment", amount_total: 4900, metadata: { store: "harbor", product: guide.product.id } };
  is("a one-time product", paidLine(store, oneTime, guideListing), "Paid: $49");
  is("a one-time product with a code", paidLine(store, { ...oneTime, amount_total: 2450, metadata: { ...oneTime.metadata, code: "LAUNCH" } }, guideListing), "Paid: $24.50");

  part("Rule 24: what does not read is never written as a value");
  for (const [label, over] of [
    ["no amount", { amount_total: undefined }],
    ["an amount as text", { amount_total: "4900" }],
    ["a negative amount", { amount_total: -1 }],
    ["a fractional amount", { amount_total: 49.5 }],
    ["no currency", { currency: undefined }],
    ["a currency of another shape", { currency: "USD" }],
  ] as const) {
    is(`${label}: no email to send`, confirmationFor(store, { ...oneTime, ...over } as never, now, [], [guideListing]), null);
  }
  is("a membership whose discount figure does not read: no email to send",
    confirmationFor(store, { ...code, total_details: { amount_discount: "1000" } } as never, now, [], [clubListing]), null);

  part("Rule 24 through the door every paid checkout goes through");
  const sessionId = "cs_test_paidline0door0001";
  const unknown = { ...oneTime, id: sessionId, amount_total: undefined };
  is("an unknown amount: failed, so the run tries again", await confirmPurchase(store, sessionId, unknown as never), "failed");
  is("no email went", emails.length, 0);
  is("no mark kept", redis.run(["GET", confirmationKey(sessionId)]), null);
  is("no order counted", redis.run(["GET", seenKey(`checkout:${sessionId}`)]), null);
  is("read again with its amount: sent", await confirmPurchase(store, sessionId, { ...oneTime, id: sessionId } as never), "sent");
  is("one email, with what was paid", emails.map((e) => e.text.split("\n").find((l) => l.startsWith("Paid:"))), ["Paid: $49"]);
  is("the order counted once", redis.run(["GET", seenKey(`checkout:${sessionId}`)]), "1");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
