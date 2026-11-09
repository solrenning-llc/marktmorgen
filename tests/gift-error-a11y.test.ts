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
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { GiftBox, GroupBox } from "@/components/store-product";
import { wordsIn } from "@/lib/buyer-words";
import { GIFT_RETURN_NOTICES, GIFT_TYPED_FIELDS, GIFT_TYPED_KEEP_MS, giftProblemField, giftTypedKey, packGiftTyped, sweepGiftTyped, unpackGiftTyped } from "@/lib/gift-typed";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { withConsent } from "./digital-consent-fixture";
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

/** A source file's text, or "" when it does not exist (yet). */
function readOr(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Stripe's API as the checkout route meets it: refusing to open a checkout while `stripeDown` is set. */
let stripeDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "POST") {
    if (stripeDown) return new Response(JSON.stringify({ error: { message: "Stand-in: Stripe is down." } }), { status: 500 });
    return new Response(JSON.stringify({ id: `cs_test_${"g".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/gift" }));
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

/** The tab's sessionStorage, as far as the sweep uses it; `refuse` makes every call throw, as a blocked storage does. */
function tabStorage(entries: Record<string, string>, refuse = false) {
  const map = new Map(Object.entries(entries));
  const guard = () => {
    if (refuse) throw new Error("SecurityError: storage blocked");
  };
  return {
    map,
    get length() {
      guard();
      return map.size;
    },
    key: (i: number) => (guard(), [...map.keys()][i] ?? null),
    getItem: (k: string) => (guard(), map.get(k) ?? null),
    removeItem: (k: string) => {
      guard();
      map.delete(k);
    },
  };
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
  is("the reason's words say what to fix", email.includes(words.email.replace(/'/g, "&#x27;")), true);
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

  part("A crafted ?gift= or ?group= reason never breaks the product page (audit of #3155, MEDIUM, already on main)");
  for (const crafted of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    let threw = "";
    let html = "";
    try {
      html = draw(listing, crafted);
    } catch (error) {
      threw = String(error).slice(0, 80);
    }
    is(`?gift=${crafted} draws the gift form`, threw, "");
    is(`?gift=${crafted} draws no reason at all, so no empty alert`, [tagWithId(html, errorId), /role="alert"/.test(html)], ["", false]);
    let groupThrew = "";
    let group = "";
    try {
      group = renderToStaticMarkup(createElement(GroupBox, { store, product: listing, problem: crafted }));
    } catch (error) {
      groupThrew = String(error).slice(0, 80);
    }
    is(`?group=${crafted} draws the group form, with no alert`, [groupThrew, /role="alert"/.test(group)], ["", false]);
  }

  part("One announcement at a time: role=\"alert\" or aria-describedby, never both");
  is("a reason tied to the recipient's field is read with the field, not announced as an alert too", /role="alert"/.test(draw(listing, "email")), false);
  is("a reason tied to the option list: the same", /role="alert"/.test(draw(withOptions, "option")), false);
  is("a reason no field can fix is the alert, and no field points to it", [attr(tagWithId(unavailable, errorId), "role"), unavailable.includes(`aria-describedby="${errorId}"`)], ["alert", false]);
  const keeperSource = readFileSync("components/gift-typed-keeper.tsx", "utf8");
  is("the focus moves only while nothing else holds it (the page itself, <body>)", /document\.activeElement\s*(===|!==)\s*document\.body/.test(keeperSource), true);

  part("3.3.7: a gift refused after it was written down goes back to the gift form with the reason, not to the store's front page");
  is("the reasons a refused checkout can give the gift form", [...GIFT_RETURN_NOTICES], ["busy", "paused", "error"]);
  for (const notice of GIFT_RETURN_NOTICES) {
    const html = draw(listing, notice);
    const text = `${wordsIn("en").notices[notice].title}. ${wordsIn("en").notices[notice].body}`;
    is(`?gift=${notice}: the store's own words for it, drawn in the gift form`, html.includes(text.replace(/'/g, "&#x27;")), true);
    is(`?gift=${notice}: the form is open, as an alert that can take the focus`, [/<details[^>]*\bopen=""/.test(html), attr(tagWithId(html, errorId), "role"), attr(tagWithId(html, errorId), "tabindex")], [true, "alert", "-1"]);
  }
  is("every store language has those words", (["en", "es", "fr", "de", "it", "nl", "pt"] as const).every((lang) => GIFT_RETURN_NOTICES.every((n) => Boolean(wordsIn(lang).notices[n]?.title && wordsIn(lang).notices[n]?.body))), true);
  const post = (body: FormData) => new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body, headers: { host: "marktmorgen.com" } });
  const giftForm = () => {
    const f = new FormData();
    f.set("handle", store.handle);
    f.set("product", listing.id);
    f.set("gift_to", "friend@example.com");
    f.set("gift_from", "Ana");
    return withConsent(f);
  };
  stripeDown = true;
  const down = await checkoutRoute(post(giftForm()));
  stripeDown = false;
  is("Stripe would not open the gift's checkout: back to the gift form, said there", [down.status, down.headers.get("location")], [303, `https://marktmorgen.com/@${store.handle}/p/${listing.id}?gift=error#gift`]);
  const up = await checkoutRoute(post(giftForm()));
  is("with Stripe up, the same form goes on to Stripe", up.headers.get("location"), "https://checkout.stripe.com/c/pay/gift");
  const plain = new FormData();
  plain.set("handle", store.handle);
  plain.set("product", listing.id);
  stripeDown = true;
  const plainDown = await checkoutRoute(post(withConsent(plain)));
  stripeDown = false;
  is("a purchase of one's own still goes to the store's front page, as before", plainDown.headers.get("location"), `https://marktmorgen.com/@${store.handle}?status=error`);
  is("a busy unit or paused orders send a gift back to its form too", [/gift && held\.reason === "busy"/.test(route), /OrdersPausedError\)[^\n]*\n?[^\n]*giftBack\(/.test(route)], [true, true]);

  part("Privacy: what the tab keeps is cleared once the order goes through, and an old one is removed, not only ignored");
  const fresh = packGiftTyped(typed, now);
  const old = packGiftTyped(typed, now - GIFT_TYPED_KEEP_MS - 1);
  const ahead = packGiftTyped(typed, now + 60_000);
  const tab = tabStorage({ "mm:gift-typed:gifterr:a": fresh, "mm:gift-typed:gifterr:b": old, "mm:gift-typed:other:c": ahead, "mm:gift-typed:other:d": "{", "mm:theme": "dark" });
  is("on any store page: the old, the future and the unreadable are removed", sweepGiftTyped(tab, now), 3);
  is("the fresh one and everything that is not a gift form stay", [...tab.map.keys()].sort(), ["mm:gift-typed:gifterr:a", "mm:theme"]);
  const paid = tabStorage({ "mm:gift-typed:gifterr:a": fresh, "mm:gift-typed:other:c": fresh, "mm:theme": "dark" });
  is("back from paying: every gift form is removed, fresh or not", [sweepGiftTyped(paid, now, true), [...paid.map.keys()]], [2, ["mm:theme"]]);
  let sweepThrew = "";
  try {
    sweepGiftTyped(tabStorage({ "mm:gift-typed:x:y": old }, true), now, true);
  } catch (error) {
    sweepThrew = String(error);
  }
  is("a blocked storage never breaks the page", sweepThrew, "");
  const sweeper = readOr("components/gift-typed-sweeper.tsx");
  is("the sweeper is a client component that runs again on each page of the store", [sweeper.startsWith('"use client";'), /usePathname\(\)/.test(sweeper), /sweepGiftTyped\(/.test(sweeper)], [true, true, true]);
  is("every store page sweeps the old ones (the store's layout)", /<GiftTypedSweeper\s*\/>/.test(readFileSync("app/[handle]/layout.tsx", "utf8")), true);
  is("the thank-you page clears them all, whichever way it is drawn", /<GiftTypedSweeper all\s*\/>/.test(readOr("app/[handle]/thanks/layout.tsx")), true);
  is("the store's front page, where the checkout's way back lands, clears them all", /<GiftTypedSweeper all\s*\/>/.test(readFileSync("app/[handle]/page.tsx", "utf8")), true);
  is("the privacy policy promises only what is done", [privacy.includes("kept only in this browser tab, never sent to us, never used after 30 minutes, and cleared when the order goes through"), /when you\s+close the\s+tab/.test(privacy.slice(privacy.indexOf('id="gift-typed"'), privacy.indexOf('id="gift-typed"') + 900))], [true, false]);
  is("lib/gift-typed.ts no longer says it is gone when the tab closes", /gone when the tab closes/.test(readFileSync("lib/gift-typed.ts", "utf8")), false);

  part("AX274 Part A: the case with scripts off is recorded with its alternative");
  const programme = readFileSync("docs/accessibility-programme.md", "utf8");
  const section = programme.slice(programme.indexOf("## Gift form sent back with scripts off"));
  is("docs/accessibility-programme.md records it", programme.includes("## Gift form sent back with scripts off"), true);
  is("with 3.3.7, the case, the alternative offered and what was not checked", [section.includes("3.3.7"), /\*\*The case:\*\*/.test(section), /\*\*The alternative we offer:\*\*/.test(section), /\*\*Not checked:\*\*/.test(section)], [true, true, true, true]);

  done();
}

void main();
