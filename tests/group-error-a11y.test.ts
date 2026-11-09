/**
 * The form to buy for several people on a product page when the server sends
 * the buyer back (`?group=<reason>#group`, app/api/store/checkout/route.ts),
 * the sibling of tests/gift-error-a11y.test.ts (rule 30): a checkout refused
 * after startGroup (a unit someone else holds, paused orders, a payment page
 * Stripe would not open) goes back to the group form with the store's own
 * words for it, not to the store's front page, and what was typed comes back
 * (WCAG 3.3.7). Rendering, source checks and the real checkout route against
 * a Stripe stand-in; no browser, no assistive technology, no real store.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { GroupBox } from "@/components/store-product";
import { wordsIn } from "@/lib/buyer-words";
import { GIFT_RETURN_NOTICES, GIFT_TYPED_KEEP_MS, GROUP_TYPED_FIELDS, giftTypedKey, groupTypedKey, packGroupTyped, sweepGiftTyped, unpackGroupTyped } from "@/lib/gift-typed";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { withConsent } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

function tagWithId(html: string, id: string): string {
  return html.match(new RegExp(`<(?:input|select|textarea|p)\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? "";
}

function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
}

/** Stripe's API as the checkout route meets it: refusing to open a checkout while `stripeDown` is set. */
let stripeDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "POST") {
    if (stripeDown) return new Response(JSON.stringify({ error: { message: "Stand-in: Stripe is down." } }), { status: 500 });
    return new Response(JSON.stringify({ id: `cs_test_${"t".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/group" }));
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

function tabStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_group_error_a11y";
  process.env.RESEND_API_KEY = "re_test_group_error_a11y";
  const OWNER = "group-error-a11y@example.com";
  await claimHandle(OWNER, "grouperr", "Quiet Oven Teams", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGroupErr01", true);
  await setSubscription(OWNER, { customerId: "cus_grouperr001", subscriptionId: "sub_grouperr001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Team Loaf Guide", "Your first loaf, for everyone.", "19", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/paid");
  const store = (await storeForEmail(OWNER)) as Store;
  const listing = await readListing(store, made.product.id);
  if (!listing) throw new Error("no listing");
  const draw = (problem: string) => renderToStaticMarkup(createElement(GroupBox, { store, product: listing, problem }));
  const errorId = `group-error-${listing.id}`;

  part("A refused checkout's notice is drawn in the group form, which opens by itself");
  for (const notice of GIFT_RETURN_NOTICES) {
    const html = draw(notice);
    const text = `${wordsIn("en").notices[notice].title}. ${wordsIn("en").notices[notice].body}`;
    is(`?group=${notice}: the store's own words for it, drawn in the group form`, html.includes(text.replace(/'/g, "&#x27;")), true);
    is(`?group=${notice}: the form is open, as an alert that can take the focus`, [/<details[^>]*\bopen=""/.test(html), attr(tagWithId(html, errorId), "role"), attr(tagWithId(html, errorId), "tabindex")], [true, "alert", "-1"]);
  }
  is("the group's own reasons are still drawn, under the same id", attr(tagWithId(draw("people"), errorId), "role"), "alert");
  is("no reason, no alert", [tagWithId(draw(""), errorId), /role="alert"/.test(draw(""))], ["", false]);
  for (const crafted of ["__proto__", "constructor", "toString"]) {
    is(`?group=${crafted} draws no reason at all`, [tagWithId(draw(crafted), errorId), /role="alert"/.test(draw(crafted))], ["", false]);
  }
  is("every store language has those words", (["en", "es", "fr", "de", "it", "nl", "pt"] as const).every((lang) => GIFT_RETURN_NOTICES.every((n) => Boolean(wordsIn(lang).notices[n]?.title && wordsIn(lang).notices[n]?.body))), true);

  part("3.3.7: what was typed into the group form comes back, in this browser tab only");
  const now = Date.UTC(2026, 10, 9, 6, 0, 0);
  is("the fields kept are the group form's own two", [...GROUP_TYPED_FIELDS], ["option", "people"]);
  is("one key per store and product, apart from the gift form's, under the same prefix", [groupTypedKey("grouperr", listing.id), groupTypedKey("grouperr", listing.id) !== giftTypedKey("grouperr", listing.id)], [`mm:gift-typed:grouperr:${listing.id}:group`, true]);
  const packed = packGroupTyped({ option: "opt_large", people: "12", handle: "grouperr", consent: "yes", gift_to: "x@example.com" }, now);
  is("only the two fields are kept, nothing else of the form", Object.keys(JSON.parse(packed).v).sort(), ["option", "people"]);
  is("read back unchanged a minute later", unpackGroupTyped(packed, now + 60_000), { option: "opt_large", people: "12" });
  is("never after the keeping time", unpackGroupTyped(packed, now + GIFT_TYPED_KEEP_MS + 1), null);
  is("never from a time in the future", unpackGroupTyped(packed, now - 60_000), null);
  is("nothing from words that are not ours", [unpackGroupTyped(null, now), unpackGroupTyped("{", now), unpackGroupTyped(JSON.stringify({ at: now, v: { people: 5 } }), now)], [null, null, null]);
  const long = unpackGroupTyped(packGroupTyped({ option: "o".repeat(400), people: "9".repeat(400) }, now), now);
  is("each value capped at what the route itself reads", [long?.option.length, long?.people.length], [64, 12]);
  const tab = tabStorage({ [groupTypedKey("grouperr", "a")]: packGroupTyped({ people: "3" }, now - GIFT_TYPED_KEEP_MS - 1), [groupTypedKey("grouperr", "b")]: packGroupTyped({ people: "3" }, now), "mm:theme": "dark" });
  is("the sweep removes an old group form too, and keeps a fresh one", [sweepGiftTyped(tab, now), [...tab.map.keys()].sort()], [1, [groupTypedKey("grouperr", "b"), "mm:theme"].sort()]);

  part("The group form keeps and restores through the same keeper");
  const source = readFileSync("components/store-product.tsx", "utf8");
  const groupBox = source.slice(source.indexOf("export function GroupBox"), source.indexOf("export function WaitlistForm"));
  is("the group form draws the keeper, for the group, with its reason", /<GiftTypedKeeper\b[^>]*form="group"[^>]*problem=\{problem\}/.test(groupBox), true);
  is("the reason is read only as the words' own keys (Object.hasOwn)", /Object\.hasOwn\(problems, problem\)/.test(groupBox) && /Object\.hasOwn\(w\.notices, problem\)/.test(groupBox), true);
  const keeper = readFileSync("components/gift-typed-keeper.tsx", "utf8");
  is("the keeper knows the group form's fields and key", /GROUP_TYPED_FIELDS/.test(keeper) && /groupTypedKey\(/.test(keeper), true);
  is("a field with a value of its own (how many people) is filled only while it still holds it", /\.value\s*===\s*field\.defaultValue/.test(keeper), true);

  part("The route: a group refused after startGroup goes back to the group form, not to the store's front page");
  const post = (body: FormData) => new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body, headers: { host: "marktmorgen.com" } });
  const groupForm = () => {
    const f = new FormData();
    f.set("handle", store.handle);
    f.set("product", listing.id);
    f.set("people", "4");
    return withConsent(f);
  };
  stripeDown = true;
  const down = await checkoutRoute(post(groupForm()));
  stripeDown = false;
  is("Stripe would not open the group's checkout: back to the group form, said there", [down.status, down.headers.get("location")], [303, `https://marktmorgen.com/@${store.handle}/p/${listing.id}?group=error#group`]);
  const up = await checkoutRoute(post(groupForm()));
  is("with Stripe up, the same form goes on to Stripe", up.headers.get("location"), "https://checkout.stripe.com/c/pay/group");
  const bad = new FormData();
  bad.set("handle", store.handle);
  bad.set("product", listing.id);
  bad.set("people", "1");
  const refused = await checkoutRoute(post(withConsent(bad)));
  is("a number that cannot be sold still goes back to the form with its own reason, as before", refused.headers.get("location"), `https://marktmorgen.com/@${store.handle}/p/${listing.id}?group=people#group`);
  const route = readFileSync("app/api/store/checkout/route.ts", "utf8");
  is("a group that could not be written down goes back to the group form, read as not available", /if \(!started\) return away\(groupBack\("unavailable"\)\)/.test(route), true);
  is("a busy unit or paused orders send a group back to its form too", [/group && held\.reason === "busy" \? groupBack\("busy"\)/.test(route), /OrdersPausedError\)[^\n]*\n?[^\n]*group \? groupBack\(/.test(route)], [true, true]);
  is("a checkout Stripe would not open, the same", /group \? groupBack\("error"\)/.test(route), true);

  part("Privacy: the policy says the group form is kept the same way");
  const privacy = readFileSync("app/privacy/page.tsx", "utf8");
  const said = privacy.slice(privacy.indexOf('id="gift-typed"'), privacy.indexOf('id="gift-typed"') + 1200);
  is("the privacy policy names the group form and what of it is kept", /several people/.test(said) && /how many/.test(said), true);
  is("lib/person-data.ts says it too", /several people/.test(readFileSync("lib/person-data.ts", "utf8").split("\n").find((l) => l.includes('file: "lib/gift-typed.ts"')) ?? ""), true);

  done();
}

void main();
