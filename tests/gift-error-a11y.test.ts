/**
 * The gift form on a product page when the server sends the buyer back with
 * a reason (`?gift=<reason>#gift`, app/api/store/checkout/route.ts): WCAG
 * 3.3.1 (the error is tied to the field in error), 4.1.2 (that field says it
 * is invalid), 3.3.7 (nothing typed is asked for again) and 3.3.3 (the words
 * say how to fix it). Audit 21 (Claude 6, 9 November 2026, MEDIUM D) found the
 * recipient's field with no aria-invalid and no aria-describedby and every
 * field back empty. Rendering and source checks only; no browser, no assistive
 * technology, no real store.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { GiftBox } from "@/components/store-product";
import { wordsIn } from "@/lib/buyer-words";
import { GIFT_TYPED_FIELDS, GIFT_TYPED_KEEP_MS, giftProblemField, giftTypedKey, packGiftTyped, unpackGiftTyped } from "@/lib/gift-typed";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** The opening tag of the element whose id is given, or "" when there is none. */
function tagWithId(html: string, id: string): string {
  return html.match(new RegExp(`<(?:input|select|textarea|p)\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? "";
}

function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gift_error_a11y";
  process.env.RESEND_API_KEY = "re_test_gift_error_a11y";
  const OWNER = "gift-error-a11y@example.com";
  await claimHandle(OWNER, "gifterr", "Quiet Oven Gifts", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGiftErr001", true);
  await setSubscription(OWNER, { customerId: "cus_gifterr001", subscriptionId: "sub_gifterr001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Starter Loaf Guide", "Your first loaf.", "19", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/paid");
  const store = (await storeForEmail(OWNER)) as Store;
  const listing = await readListing(store, made.product.id);
  if (!listing) throw new Error("no listing");
  const withOptions = {
    ...listing,
    options: [
      { id: "opt_small_gift", label: "Small", priceCents: 1900, file: null, link: "https://example.com/small", details: [] },
      { id: "opt_large_gift", label: "Large", priceCents: 2900, file: null, link: "https://example.com/large", details: [] },
    ],
  } as unknown as Listing;
  const draw = (product: Listing, problem: string) => renderToStaticMarkup(createElement(GiftBox, { store, product, problem }));
  const toId = `gift-to-${listing.id}`;
  const errorId = `gift-error-${listing.id}`;
  const words = wordsIn("en").giftProblems;

  part("3.3.1 and 4.1.2: a refused recipient address is marked and tied to the reason, with scripts off");
  const email = draw(listing, "email");
  const emailInput = tagWithId(email, toId);
  is("the reason is drawn under its own id", tagWithId(email, errorId) !== "", true);
  is("the reason's words say what to fix", email.includes(words.email), true);
  is("the recipient's field says it is invalid", attr(emailInput, "aria-invalid"), "true");
  is("and points to the reason", (attr(emailInput, "aria-describedby") ?? "").split(" ").includes(errorId), true);
  const ok = draw(listing, "");
  is("with no reason, the field is not marked invalid", attr(tagWithId(ok, toId), "aria-invalid"), null);
  is("and points to nothing", attr(tagWithId(ok, toId), "aria-describedby"), null);
  const unavailable = draw(listing, "unavailable");
  is("a reason no field can fix marks no field", attr(tagWithId(unavailable, toId), "aria-invalid"), null);
  is("and the reason can take the focus, so it is read", attr(tagWithId(unavailable, errorId), "tabindex"), "-1");

  part("3.3.1 and 4.1.2: a refused choice of option is marked and tied to the reason");
  const option = draw(withOptions, "option");
  const select = option.match(/<select\b[^>]*name="option"[^>]*>/)?.[0] ?? "";
  is("the option list says it is invalid", attr(select, "aria-invalid"), "true");
  is("and points to the reason", (attr(select, "aria-describedby") ?? "").split(" ").includes(errorId), true);
  is("the recipient's field is not marked then", attr(tagWithId(option, toId), "aria-invalid"), null);
  is("with no reason, the option list is not marked", attr(draw(withOptions, "").match(/<select\b[^>]*name="option"[^>]*>/)?.[0] ?? "", "aria-invalid"), null);

  part("Which field a reason belongs to, and which takes the focus");
  is("email: the recipient's address", giftProblemField("email"), "gift_to");
  is("option: the option list", giftProblemField("option"), "option");
  is("consent: the consent box focuses itself, so no field here", giftProblemField("consent"), null);
  is("unavailable and product: no field", [giftProblemField("unavailable"), giftProblemField("product")], [null, null]);
  is("an unknown reason: no field", giftProblemField("<script>"), null);

  part("3.3.7: what was typed comes back after the server's refusal, in this browser tab only");
  const now = Date.UTC(2026, 10, 9, 5, 0, 0);
  is("the fields kept are the gift's own four", [...GIFT_TYPED_FIELDS], ["option", "gift_to", "gift_from", "gift_message"]);
  is("one key per store and product", giftTypedKey("gifterr", listing.id), `mm:gift-typed:gifterr:${listing.id}`);
  const typed = { gift_to: "frend@example.con", gift_from: "Ana", gift_message: "Happy baking!", option: "opt_large_gift", handle: "gifterr", consent: "yes" };
  const packed = packGiftTyped(typed, now);
  is("only the four fields are kept, nothing else of the form", Object.keys(JSON.parse(packed).v).sort(), ["gift_from", "gift_message", "gift_to", "option"]);
  is("read back unchanged a minute later", unpackGiftTyped(packed, now + 60_000), { option: "opt_large_gift", gift_to: "frend@example.con", gift_from: "Ana", gift_message: "Happy baking!" });
  is("never after the keeping time", unpackGiftTyped(packed, now + GIFT_TYPED_KEEP_MS + 1), null);
  is("the keeping time is at most 30 minutes", GIFT_TYPED_KEEP_MS <= 30 * 60_000, true);
  is("never from a time in the future", unpackGiftTyped(packed, now - 60_000), null);
  is("nothing from nothing", unpackGiftTyped(null, now), null);
  is("nothing from words that are not ours", [unpackGiftTyped("{", now), unpackGiftTyped("[]", now), unpackGiftTyped(JSON.stringify({ at: now, v: { gift_to: 5 } }), now)], [null, null, null]);
  const long = unpackGiftTyped(packGiftTyped({ gift_to: "a".repeat(400), gift_from: "b".repeat(400), gift_message: "c".repeat(3_000), option: "d".repeat(400) }, now), now);
  is("each value capped at what the form itself takes", [long?.gift_to.length, long?.gift_from.length, long?.gift_message.length, long?.option.length], [254, 60, 500, 64]);

  part("The form keeps and restores through its keeper, and the route returns to the form");
  const source = readFileSync("components/store-product.tsx", "utf8");
  is("the gift form draws the keeper with its reason", /<GiftTypedKeeper\b[^>]*problem=\{problem\}/.test(source), true);
  const keeper = readFileSync("components/gift-typed-keeper.tsx", "utf8");
  is("the keeper is a client component", keeper.startsWith('"use client";'), true);
  is("it reads and writes the tab's own storage only, inside try", /try\s*\{[^}]*sessionStorage/.test(keeper) && !/localStorage|document\.cookie|fetch\(/.test(keeper), true);
  is("it fills only a field that is still empty", /\.value\s*===\s*""/.test(keeper), true);
  is("it moves the focus to the field in error", /\.focus\(\)/.test(keeper), true);
  const route = readFileSync("app/api/store/checkout/route.ts", "utf8");
  is("a gift that could not be written down goes back to the gift form, not to the store's front page", /if \(!started\) return away\(`\/@\$\{store\.handle\}\/p\/\$\{product\.id\}\?gift=unavailable#gift`\)/.test(route), true);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8");
  is("the privacy policy says what the tab keeps, and for how long", /id="gift-typed"/.test(privacy) && privacy.includes("mm:gift-typed:"), true);

  done();
}

void main();
