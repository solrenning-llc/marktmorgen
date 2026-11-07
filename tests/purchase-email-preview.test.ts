/**
 * The example of the purchase email in the studio (lib/purchase-email-preview.ts,
 * queue item 380 [TB6], unit 1). What is checked: the example is the email the
 * real sender writes (lib/purchase-email.ts, confirmationFor) for a made-up
 * order of the same product, word for word; it is clearly an example (made-up
 * buyer, order reference, key and address; a marker where the creator's note
 * goes); it is offered only where the regular purchase email is what a buyer
 * gets (not something free, a booked call, a package of calls, or the demo's
 * account); it costs nothing: not one Redis command, no Stripe call, nothing
 * sent; and the panel the studio draws says so in plain words, in the buyer's
 * language where the email is quoted, with no control inside the quote.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import { readListing, type Listing } from "@/lib/catalog";
import { confirmationFor, fromStore } from "@/lib/purchase-email";
import {
  EXAMPLE_ADDRESS,
  EXAMPLE_BUYER,
  EXAMPLE_KEY,
  EXAMPLE_ORDER,
  NOTE_PLACEHOLDER,
  exampleSession,
  purchaseEmailPreview,
} from "@/lib/purchase-email-preview";
import { PurchaseEmailPreview } from "@/components/purchase-email-preview";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "preview-owner@example.com";
const NOW = 1_793_000_000;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "lantern", "Lantern Press", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLantern001", true);
  const made = await addProduct(OWNER, "Bookbinding at Home", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const listing = (await readListing(store, made.product.id))!;

  // Every Redis command from here on is counted: the example must read and write nothing.
  let commands = 0;
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = ((batch: (string | number)[][]) => {
    commands += batch.length;
    return pipeline(batch);
  }) as typeof redis.pipeline;

  part("The email the real sender writes, for a made-up order");
  const plain = purchaseEmailPreview(store, listing, NOW);
  const real = confirmationFor(store, exampleSession(store, listing, NOW) as never, NOW, [], [listing], null, null);
  is("word for word what confirmationFor writes for the same order", [plain?.subject, plain?.text], [real?.subject, real?.text]);
  is("from the store's own name, to the made-up buyer", [plain?.from, plain?.to], [fromStore(store), EXAMPLE_BUYER]);
  is("its subject names the store and the product", plain?.subject, "Your order from Lantern Press: Bookbinding at Home");
  const text = plain?.text ?? "";
  is(
    "the price, the made-up reference and where to open it",
    [text.includes("$39"), text.includes(`Order reference: ${EXAMPLE_ORDER}`), text.includes(`/@lantern/thanks?session_id=${EXAMPLE_ORDER}`)],
    [true, true, true],
  );
  is("the made-up reference is a test-mode one, never a live order's", EXAMPLE_ORDER.startsWith("cs_test_"), true);
  is("the buyer's language for the quote", plain?.lang, "en-US");

  part("Each kind of product as its buyers get it");
  const course = { ...listing, course: { id: "course-1" } } as unknown as Listing;
  is("a course: the link to start it", purchaseEmailPreview(store, course, NOW)?.text.includes("/@lantern/course/"), true);
  const keyed = { ...listing, keys: { mode: "generated" } } as unknown as Listing;
  is("license keys: an example key, said to be the buyer's", purchaseEmailPreview(store, keyed, NOW)?.text.includes(EXAMPLE_KEY), true);
  const shipped = { ...listing, shipping: { countries: ["US"], cents: 500 } } as unknown as Listing;
  const parcel = purchaseEmailPreview(store, shipped, NOW)?.text ?? "";
  is(
    "something shipped: the made-up address and who ships it, not a download link",
    [parcel.includes(EXAMPLE_ADDRESS.line1), parcel.includes("thanks?session_id="), parcel.includes("Lantern Press")],
    [true, false, true],
  );
  const options = { ...listing, options: [{ id: "opt-a", label: "Hardcover", priceCents: 5900 }, { id: "opt-b", label: "Paperback", priceCents: 2900 }] } as unknown as Listing;
  const optioned = purchaseEmailPreview(store, options, NOW)?.text ?? "";
  is("options: the first one, at its own price", [optioned.includes("Bookbinding at Home (Hardcover)"), optioned.includes("$59")], [true, true]);

  part("The creator's note: a marker, never a guess");
  const noted = purchaseEmailPreview(store, { ...listing, note: true }, NOW)?.text ?? "";
  is("a product with a note shows where it goes", [noted.includes(NOTE_PLACEHOLDER.heading), noted.includes(NOTE_PLACEHOLDER.body)], [true, true]);
  is("one without a note shows no marker", text.includes(NOTE_PLACEHOLDER.heading), false);

  part("Only where the regular purchase email is what buyers get");
  is("something free gets no example", purchaseEmailPreview(store, { ...listing, priceCents: 0 }, NOW), null);
  is("a booked call has its own confirmation", purchaseEmailPreview(store, { ...listing, call: { minutes: 30 } } as unknown as Listing, NOW), null);
  is("a package of calls has its own email", purchaseEmailPreview(store, { ...listing, callPackage: { calls: 3 } } as unknown as Listing, NOW), null);
  is("the demo's account confirms nothing by email, so no example either", purchaseEmailPreview({ ...store, stripeAccountId: demoAccount() } as Store, listing, NOW, demoAccount()), null);
  is("an unset demo account never matches a real one", purchaseEmailPreview(store, listing, NOW, "")?.subject, plain?.subject);

  part("It costs nothing");
  is("not one Redis command for all of the above", commands, 0);

  part("The panel in the studio");
  // Regra 23 (review of 7 November 2026): the panel now takes `sending` (isSenderConfigured()); these checks draw it as sending, and no assertion below changed.
  const html = renderToStaticMarkup(createElement(PurchaseEmailPreview, { preview: plain!, productTitle: listing.title, sending: true }));
  is("a named region with its own heading", [/<section[^>]*aria-labelledby="purchase-email-title"/.test(html), html.includes('id="purchase-email-title"')], [true, true]);
  is("says it is an example and that nothing is sent", [html.includes("An example"), html.includes("Nothing is sent")], [true, true]);
  is("the quote is in the buyer's language", /<pre[^>]*lang="en-US"/.test(html), true);
  is("the quote wraps rather than scrolling sideways", /<pre[^>]*whitespace-pre-wrap/.test(html), true);
  is("nothing to press inside the quote: no link, button or form", /<(a|button|form|input)\b/.test(html), false);
  is("the subject and the sender are shown", [html.includes("Your order from Lantern Press: Bookbinding at Home"), html.includes("Lantern Press")], [true, true]);

  part("The panel is honest about the price and about sending (review of 7 November 2026)");
  // A real paid order of a shipped product: Stripe's amount_total carries the shipping (and any tax added on top); the example shows the listed price.
  const paidShipped = confirmationFor(store, { ...exampleSession(store, shipped, NOW), amount_total: 3900 + 500 } as never, NOW, [], [shipped], null, null);
  is("why: the real email shows $44 for a $39 product shipped at $5, the example $39", [paidShipped?.text.includes("$44"), parcel.includes("$39")], [true, true]);
  const sendingHtml = renderToStaticMarkup(createElement(PurchaseEmailPreview, { preview: plain!, productTitle: listing.title, sending: true }));
  const offHtml = renderToStaticMarkup(createElement(PurchaseEmailPreview, { preview: plain!, productTitle: listing.title, sending: false }));
  is("the price is said to be before shipping or any tax added at checkout", sendingHtml.includes("The price is your listed price, before shipping or any tax added at checkout."), true);
  const NOT_SENT = "Email is not set up yet, so buyers do not get this email today.";
  is("while email is not set up, the panel says buyers do not get it today, and only then", [offHtml.includes(NOT_SENT), sendingHtml.includes(NOT_SENT)], [true, false]);
  // Plain words (AX274, 3.1.5): every sentence of the panel's own words, outside the quoted email, is short.
  const ownWords = sendingHtml.replace(/<pre[\s\S]*?<\/pre>/, "\n").replace(/<dl[\s\S]*?<\/dl>/, "\n").replace(/<[^>]+>/g, "\n").replace(/&#x27;|&apos;/g, "'");
  const longest = Math.max(...ownWords.split(/[.!?:]\s|\n/).map((piece) => piece.trim().split(/\s+/).filter(Boolean).length));
  is("no sentence of the panel's own words is longer than 20 words", longest <= 20 ? "short" : `${longest} words`, "short");

  done();
}

/** A connected account id the demo would use, for the check above. */
function demoAccount(): string {
  return "acct_1DemoAcct0001";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
