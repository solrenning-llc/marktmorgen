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
 *
 * After the privacy pre-review: the choice is read again right before every
 * step and every checkout start, and another tab's change of the choice moves
 * this page (a "Turn off" in tab B stopped nothing in tab A); the yes covers
 * only the platforms the banner named; Google is given the page without its
 * query; a page restored from the back/forward cache reads the cart again;
 * the banner names only the platforms these steps go to.
 */
import { readFileSync } from "node:fs";
import { NO_PIXELS } from "@/lib/pixels";
import {
  CART_CHANGED_EVENT,
  CART_KEY_PREFIX,
  STEP_EVENT_NAMES,
  STEPS_MARK_VERSION,
  addedToCart,
  cartIdsOf,
  pageLocationOf,
  stepCalls,
  stepsAllowed,
  stepsMarkKey,
  stepsMarkValue,
  stepsWords,
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
is(
  "Google is given the page without its query or fragment",
  stepCalls({ ...NO_PIXELS, google: all.google }, { type: "view", productId: "p1" }, "https://shop.test/s/p/p1"),
  [["google", ["event", "view_item", { items: [{ item_id: "p1" }], page_location: "https://shop.test/s/p/p1" }]]],
);
is("a page without a known place: no page_location", stepCalls({ ...NO_PIXELS, google: all.google }, { type: "view", productId: "p1" })[0][1], ["event", "view_item", { items: [{ item_id: "p1" }] }]);
is("the page's place: no query (?code=, ?site=, ?return=), no fragment", pageLocationOf("https://shop.test/s/p/p1?code=123456&site=a&return=%2Fx#top"), "https://shop.test/s/p/p1");
is("only a web page's place", [pageLocationOf("javascript:alert(1)"), pageLocationOf("not a url"), pageLocationOf("")], [undefined, undefined, undefined]);
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

part("Only with the visitor's own yes to these words, for the platforms they named");
const mark = stepsMarkValue(all);
is("the mark keeps the platforms the banner named", mark, `${STEPS_MARK_VERSION}:meta,google,reddit`);
is("no platform these steps go to: no mark", stepsMarkValue({ ...NO_PIXELS, tiktok: all.tiktok, pinterest: all.pinterest, x: "o1abc" }), null);
is("pressed Allow on these words: told, to those platforms", stepsAllowed("on", "yes", mark), ["meta", "google", "reddit"]);
is("a platform added after the yes: not told until a new Allow", stepsAllowed("on", "yes", stepsMarkValue({ ...NO_PIXELS, meta: all.meta })), ["meta"]);
is("a yes from before these words: not told", stepsAllowed("on", "yes", null), []);
is("an old or odd mark: not told", [stepsAllowed("on", "yes", "0"), stepsAllowed("on", "yes", "1"), stepsAllowed("on", "yes", "0:meta"), stepsAllowed("on", "yes", `${STEPS_MARK_VERSION}:`)], [[], [], [], []]);
is("an unknown name in the mark is dropped", stepsAllowed("on", "yes", `${STEPS_MARK_VERSION}:meta,tiktok,evil,meta`), ["meta"]);
is("allowed only because the country does not ask first: not told", stepsAllowed("on", null, mark), []);
is("said no: not told", stepsAllowed("off", "no", mark), []);
is("still asking: not told", stepsAllowed("ask", null, mark), []);
is("not read yet: not told", stepsAllowed("unknown", "yes", mark), []);
is("the mark is kept per store", stepsMarkKey("shop-a") !== stepsMarkKey("shop-b"), true);

part("The banner names only the platforms these steps go to");
is("Meta, Google and Reddit", stepsWords(all, "Shop"), "Shop also tells Meta, Google and Reddit which products you open and add to your cart.");
is("Google alone", stepsWords({ ...NO_PIXELS, google: all.google, tiktok: all.tiktok }, "Shop"), "Shop also tells Google which products you open and add to your cart.");
is("TikTok, Pinterest and X only: not said", stepsWords({ ...NO_PIXELS, tiktok: all.tiktok, pinterest: all.pinterest, x: "o1abc" }, "Shop"), "");

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
const flat = pixels.replace(/\s+/g, " ");
is("the choice is read again from storage right before a step", flat.includes("const stepsNow = () => stepsAllowed(pixelChoiceState(readChoice(handle), askFirst, gpcOn()), readChoice(handle), readMark(handle));"), true);
const sends = pixels.match(/sendStep\(w, /g) ?? [];
is("every step sent is checked at that moment", sends.length >= 2 && (pixels.match(/sendStep\(w, pixels, [^\n]*, stepsNow\(\)\)/g) ?? []).length === sends.length, true);
is("only to the platforms the yes named", /function sendStep\(w: PixelWindow, pixels: Pixels, step: Step, allowed: StepKind\[\]\)/.test(pixels) && pixels.includes("if (!allowed.includes(kind)) continue;"), true);
is("a checkout start is checked at that moment too", /const onSubmit = \(e: SubmitEvent\) => \{\s*if \(!stillOn\(\)\) return;/.test(pixels), true);
is("still on: the choice read again", flat.includes("const stillOn = () => pixelChoiceState(readChoice(handle), askFirst, gpcOn()) === \"on\";"), true);
is("another tab's choice moves this page", /if \(e\.key === null \|\| e\.key === consentKey\(handle\) \|\| e\.key === stepsMarkKey\(handle\)\) setState\(pixelChoiceState\(readChoice\(handle\), askFirst, gpcOn\(\)\)\)/.test(pixels) && pixels.includes('window.addEventListener("storage", onChoice)'), true);
is("the cart is read on its own change event, never on another tab's", pixels.includes("window.addEventListener(CART_CHANGED_EVENT, onCart)"), true);
is("another tab only moves what was there", /addEventListener\("storage", onOtherTab\)/.test(pixels) && !/onOtherTab[\s\S]{0,200}sendStep/.test(pixels.slice(pixels.indexOf("const onOtherTab"))), true);
is("a page back from the back/forward cache reads the cart again", /const onShow = \(e: PageTransitionEvent\) => \{\s*if \(e\.persisted\) before = readCart\(handle\);/.test(pixels) && pixels.includes('window.addEventListener("pageshow", onShow)'), true);
is("Google is given the page without its query", pixels.includes("pageLocationOf(location.href)"), true);
is("Allow keeps the mark with the platforms named; No and Turn off remove it", (pixels.match(/stepsMarkValue\(pixels\)/g) ?? []).length === 1 && (pixels.match(/writeMark\(handle, null\)/g) ?? []).length >= 3, true);
is("the banner says these steps with stepsWords", pixels.includes("stepsWords(pixels, storeName)") && !pixels.includes("tells them which products"), true);
is("page views and checkout starts unchanged", ['w.fbq("track", "PageView")', 'w.gtag("config", id)', 'w.fbq("track", "InitiateCheckout")', 'w.gtag("event", "begin_checkout")', 'ttq.track("InitiateCheckout")', 'w.rdt("track", "PageVisit")'].every((call) => pixels.includes(call)), true);
is("no new script and no identifier", !/https?:\/\//.test(steps) && !["email", "phone", "externalId", "value:", "currency"].some((word) => steps.includes(word)), true);
const tracking = readFileSync("components/store-tracking.tsx", "utf8");
is("a product's page is told as a view of that product", tracking.includes("viewed={product || undefined}"), true);

part("The privacy policy says it");
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
const ads = privacy.slice(privacy.indexOf('<p id="ads">'), privacy.indexOf('<p id="ads-server">'));
is("which products were opened and put in the cart, to Meta, Google and Reddit", /Meta, Google and Reddit are also told which products a visitor opens and puts in the cart/.test(ads.replace(/\s+/g, " ")), true);
is("only after Allow on those words", /only after the visitor pressed Allow/.test(ads.replace(/\s+/g, " ")), true);
is("never says nothing about the visitor goes", /nothing about the visitor/.test(ads.replace(/\s+/g, " ")), false);
is("says what is not sent", /no name, email, amount or anything the visitor typed/.test(ads.replace(/\s+/g, " ")), true);

done();
