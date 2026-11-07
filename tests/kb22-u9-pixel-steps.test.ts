/**
 * 601 [KB22] U9: the two steps between a page view and a started checkout,
 * told to the creator's own pixels (lib/pixel-steps.ts,
 * components/store-pixels.tsx, components/store-tracking.tsx).
 *
 * Checked: a product's own page is told as a product view, and a product put
 * in the cart as an add to cart, to Meta, Google and Reddit only; each name is
 * on that platform's list of standard events; only the product's id is sent,
 * never an identifier, an amount or a new script; nothing is told unless the
 * visitor pressed "Allow" on the words that name these two steps (a yes
 * given before those words, or a country that does not ask first, is not
 * enough); taking a product out of the cart, putting a cart back from a link
 * and another tab's change tell nothing; the page-view and checkout-start
 * calls already there are unchanged; the privacy policy says it.
 */
import { readFileSync } from "node:fs";
import { NO_PIXELS } from "@/lib/pixels";
import {
  CART_CHANGED_EVENT,
  CART_KEY_PREFIX,
  STEP_EVENT_NAMES,
  STEPS_MARK_VALUE,
  addedToCart,
  cartIdsOf,
  stepCalls,
  stepsAllowed,
  stepsMarkKey,
} from "@/lib/pixel-steps";
import { done, is, part } from "./check";

const all = { ...NO_PIXELS, meta: "123456789012345", google: "G-ABC1234567", tiktok: "C123ABC456DEF789GHI0", pinterest: "2612345678901", reddit: "a2_abc123", redditMatchingOff: true as const };

part("What each platform is told");
is(
  "a product view",
  stepCalls(all, { type: "view", productId: "prod000001" }),
  [
    ["meta", ["track", "ViewContent", { content_ids: ["prod000001"], content_type: "product" }]],
    ["google", ["event", "view_item", { items: [{ item_id: "prod000001" }] }]],
    ["reddit", ["track", "ViewContent", { products: [{ id: "prod000001" }] }]],
  ],
);
is(
  "an add to cart",
  stepCalls(all, { type: "cart", productId: "prod000002" }),
  [
    ["meta", ["track", "AddToCart", { content_ids: ["prod000002"], content_type: "product" }]],
    ["google", ["event", "add_to_cart", { items: [{ item_id: "prod000002", quantity: 1 }] }]],
    ["reddit", ["track", "AddToCart", { itemCount: 1, products: [{ id: "prod000002", quantity: 1 }] }]],
  ],
);
is("only the pixels the creator added", stepCalls({ ...NO_PIXELS, google: "G-ABC1234567" }, { type: "view", productId: "p1" }).map(([kind]) => kind), ["google"]);
is("no pixel: nothing", stepCalls(NO_PIXELS, { type: "cart", productId: "p1" }), []);
is("TikTok, Pinterest and X: not told these steps", stepCalls({ ...NO_PIXELS, tiktok: all.tiktok, pinterest: all.pinterest, x: "o1abc" }, { type: "view", productId: "p1" }), []);
is("an empty or odd product id: nothing", [stepCalls(all, { type: "view", productId: "" }), stepCalls(all, { type: "cart", productId: "a b<" })], [[], []]);

part("Names from each platform's list of standard events");
const metaStandard = ["AddPaymentInfo", "AddToCart", "AddToWishlist", "CompleteRegistration", "Contact", "CustomizeProduct", "Donate", "FindLocation", "InitiateCheckout", "Lead", "Purchase", "Schedule", "Search", "StartTrial", "SubmitApplication", "Subscribe", "ViewContent"];
const googleRecommended = ["add_payment_info", "add_shipping_info", "add_to_cart", "add_to_wishlist", "begin_checkout", "generate_lead", "purchase", "refund", "remove_from_cart", "select_item", "select_promotion", "view_cart", "view_item", "view_item_list", "view_promotion"];
// docs/x-reddit-pixels-official-check-2026-11-02.md, item 2.
const redditStandard = ["PageVisit", "ViewContent", "Search", "AddToCart", "AddToWishlist", "Purchase", "Lead", "SignUp"];
is("Meta", Object.values(STEP_EVENT_NAMES.meta).every((name) => metaStandard.includes(name)), true);
is("Google", Object.values(STEP_EVENT_NAMES.google).every((name) => googleRecommended.includes(name)), true);
is("Reddit", Object.values(STEP_EVENT_NAMES.reddit).every((name) => redditStandard.includes(name)), true);
is("every call uses the table's name", stepCalls(all, { type: "cart", productId: "p1" }).every(([kind, args]) => args[1] === STEP_EVENT_NAMES[kind].cart), true);

part("Only with the visitor's own yes to these words");
const mark = STEPS_MARK_VALUE;
is("pressed Allow on these words: told", stepsAllowed("on", "yes", mark), true);
is("a yes from before these words: not told", stepsAllowed("on", "yes", null), false);
is("an old or odd mark: not told", stepsAllowed("on", "yes", "0"), false);
is("allowed only because the country does not ask first: not told", stepsAllowed("on", null, mark), false);
is("said no: not told", stepsAllowed("off", "no", mark), false);
is("still asking: not told", stepsAllowed("ask", null, mark), false);
is("not read yet: not told", stepsAllowed("unknown", "yes", mark), false);
is("the mark is kept per store", stepsMarkKey("shop-a") !== stepsMarkKey("shop-b"), true);

part("What counts as putting a product in the cart");
is("a new id", addedToCart(["a"], ["a", "b"]), ["b"]);
is("taken out: nothing", addedToCart(["a", "b"], ["a"]), []);
is("the same ids in another order: nothing", addedToCart(["a", "b"], ["b", "a"]), []);
is("an id written twice is one", addedToCart([], ["c", "c"]), ["c"]);
is("a bundle swap: the bundle only", addedToCart(["a", "b"], ["z"]), ["z"]);
is("the cart as the store reads it", cartIdsOf('["a",1,"b"]'), ["a", "b"]);
is("anything else is an empty cart", [cartIdsOf(null), cartIdsOf("{"), cartIdsOf('{"a":1}')], [[], [], []]);
is("never more than the cart holds", cartIdsOf(JSON.stringify(Array.from({ length: 500 }, (_, i) => `p${i}`))).length <= 100, true);

part("The cart's own names, unchanged");
const cart = readFileSync("components/store-cart.tsx", "utf8");
is("the same storage key", cart.includes(`\`${CART_KEY_PREFIX}\${handle}\``), true);
is("the same change event", cart.includes(`const CHANGED = "${CART_CHANGED_EVENT}";`), true);

const pixels = readFileSync("components/store-pixels.tsx", "utf8");
const steps = readFileSync("lib/pixel-steps.ts", "utf8");
part("The page");
is("the steps start only behind the check", /if \(stepsAllowed\(state, readChoice\(handle\), readMark\(handle\)\)\)/.test(pixels), true);
is("the cart is read on its own change event, never on another tab's", pixels.includes("window.addEventListener(CART_CHANGED_EVENT, onCart)"), true);
is("another tab only moves what was there", /addEventListener\("storage", onOtherTab\)/.test(pixels) && !/onOtherTab[\s\S]{0,200}sendStep/.test(pixels.slice(pixels.indexOf("const onOtherTab"))), true);
is("Allow keeps the mark; No and Turn off remove it", (pixels.match(/writeMark\(handle, true\)/g) ?? []).length === 1 && (pixels.match(/writeMark\(handle, false\)/g) ?? []).length >= 3, true);
is("the banner names the two steps", pixels.includes("which products you open and put in your cart"), true);
is("page views and checkout starts unchanged", ['w.fbq("track", "PageView")', 'w.gtag("config", id)', 'w.fbq("track", "InitiateCheckout")', 'w.gtag("event", "begin_checkout")', 'ttq.track("InitiateCheckout")', 'w.rdt("track", "PageVisit")'].every((call) => pixels.includes(call)), true);
is("no new script and no identifier", !/https?:\/\//.test(steps) && !["email", "phone", "externalId", "value:", "currency"].some((word) => steps.includes(word)), true);
const tracking = readFileSync("components/store-tracking.tsx", "utf8");
is("a product's page is told as a view of that product", tracking.includes("viewed={product || undefined}"), true);

part("The privacy policy says it");
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
const ads = privacy.slice(privacy.indexOf('<p id="ads">'), privacy.indexOf('<p id="ads-server">'));
is("which products were opened and put in the cart, to Meta, Google and Reddit", /Meta, Google and Reddit are also told which products a visitor opens and puts in the cart/.test(ads.replace(/\s+/g, " ")), true);
is("only after Allow on those words", /only after the visitor pressed Allow/.test(ads.replace(/\s+/g, " ")), true);

done();
