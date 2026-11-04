/**
 * The demo store is a store.
 *
 * "Live demo store" was a page written by hand: it shared no code with a
 * creator's store, so what a visitor tried there was not what a creator's
 * buyers get. It is now made by lib/demo-seed.ts with the functions the
 * studio's own routes call, and drawn, sold and handed over by the pages and
 * the checkout every store runs on. What is checked here, by running it:
 *
 *   - made once, it is a store that can sell: its address, its product with
 *     two prices, a file behind each in the store's own folder, its picture
 *     and photo, its long description;
 *   - asked again it reads one mark and writes nothing; after a deployment
 *     that changes the code it is brought in line without fetching anything
 *     it already has; a photograph that could not be fetched is named, left
 *     alone for a while and then tried again;
 *   - its checkout is the real one, signed with the demo's own test key on
 *     the demo's own account — also on the day our own key is a live one —
 *     and carries the store's name, which a refusal never costs the checkout;
 *   - the few ways it is not like other stores (lib/house-store.ts): nobody
 *     can sign in as its owner, it takes no reviews, it writes to no buyer,
 *     and its pages say it is a demo;
 *   - nothing of the hand-written demo is left, /demo leads to the store,
 *     and every form that opens a payment page leaves the frame the home
 *     page shows the store in.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { offersCart } from "@/lib/cart-checkout";
import { readThanksNote } from "@/lib/thanks-note-store";
import { planFor } from "@/lib/product-extras";
import { DEMO_CALL, DEMO_EXTRAS, DEMO_PRODUCT, DEMO_STORE, type SeedDeps, ensureDemoStore, imageSize, seedFingerprint } from "@/lib/demo-seed";
import { DEMO_CONNECTED_ACCOUNT } from "@/lib/demo-account";
import { getDemoFile } from "@/lib/demo-file";
import { HOUSE_HANDLE, HOUSE_OWNER, isHouseStore, takesReviews } from "@/lib/house-store";
import { addProduct, claimHandle, setProductLink, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeForHandle } from "@/lib/store";
import { productIds, readListings, readProduct } from "@/lib/catalog";
import { canSell, canSellProduct, createCheckout } from "@/lib/store-checkout";
import { keyFor } from "@/lib/stripe-account";
import { sellsInTestMode } from "@/lib/stripe-connect";
import { ownsPath } from "@/lib/product-file";
import { imagePaths, imageSrcSet, imageUrl, ownsImagePath, parseProductImage } from "@/lib/product-image";
import { imageFolder } from "@/lib/store";
import { readAbout } from "@/lib/product-about";
import { readPhoto } from "@/lib/store-photo";
import { canConfirm } from "@/lib/purchase-email";
import { provePurchase } from "@/lib/review-proof";
import { sendSignInLink } from "@/lib/auth";
import { MAX_BIO_LENGTH } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DEMO_KEY = "sk_test_demo_only_a_stand_in";
const OUR_TEST_KEY = "sk_test_platform_only_a_stand_in";
const OUR_LIVE_KEY = "sk_live_platform_only_a_stand_in";

/** A WebP's first thirty bytes, saying how big it is: all that is ever read of it here. */
function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x52, 0x49, 0x46, 0x46, 56, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0]);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
  return bytes;
}

// ---- Stand-ins for everything outside ----------------------------------------

const puts: { pathname: string; bytes: number; type: string }[] = [];
const removed: string[] = [];
const fetched: string[] = [];
let photoHostDown = false;
const deps: SeedDeps = {
  putFile: async (pathname, bytes, type) => {
    puts.push({ pathname, bytes: bytes.byteLength, type });
  },
  removeFile: async (pathname) => {
    removed.push(pathname);
  },
  fetchBytes: async (url) => {
    fetched.push(url);
    if (photoHostDown) throw new Error("fetch_502");
    if (url.includes(DEMO_STORE.photo.id)) return webp(480, 480);
    return url.includes("w=800") ? webp(800, 450) : webp(1200, 675);
  },
};

type Call = { key: string; account: string; method: string; path: string; body: URLSearchParams };
const stripe: Call[] = [];
const emails: unknown[] = [];
let refuseName = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const headers = new Headers(init?.headers);
  const call: Call = {
    key: (headers.get("authorization") ?? "").replace(/^Bearer /, ""),
    account: headers.get("stripe-account") ?? "",
    method: init?.method ?? "GET",
    path: url.pathname.replace(/^\/v1/, ""),
    body: new URLSearchParams(String(init?.body ?? "")),
  };
  stripe.push(call);
  if (call.path === "/checkout/sessions" && call.method === "POST") {
    if (refuseName && call.body.has("branding_settings[display_name]")) {
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Received unknown parameter: branding_settings" } }), { status: 400 });
    }
    return new Response(JSON.stringify({ id: `cs_test_${"d".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/demo" }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${call.method} ${call.path}` } }), { status: 404 });
}) as typeof fetch;

// ---- Reading the source, for the parts that are markup ------------------------

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(process.cwd(), dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(process.cwd(), path)).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

async function theProduct() {
  const store = (await storeForEmail(HOUSE_OWNER))!;
  const listing = (await readListings(store, productIds(store))).find((p) => p.title === DEMO_PRODUCT.title)!;
  return { store, listing };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = OUR_TEST_KEY;
  process.env.STRIPE_DEMO_SECRET_KEY = DEMO_KEY;
  process.env.RESEND_API_KEY = "re_test_demo_only";

  part("Made once, it is a store that can sell");
  is("there is no store before", await storeForHandle(HOUSE_HANDLE), null);
  const first = await ensureDemoStore(deps);
  is("it is made, with nothing missing", [first.ok, first.pending, first.ran], [true, [], true]);
  let { store, listing } = await theProduct();
  is("at the address stores have", (await storeForHandle(HOUSE_HANDLE))?.email, HOUSE_OWNER);
  is("named, and saying in its own description that it is a demo", [store.name, /fictional/.test(store.bio) && /demo store/.test(store.bio)], ["Harbor Kitchen", true]);
  is("its description fits what a store may say", store.bio.length <= MAX_BIO_LENGTH && store.bio === DEMO_STORE.bio, true);
  is("it is the house's", isHouseStore(store), true);
  is("on the demo's own account, on Studio so it shows the AI features, with no subscription written down", [store.stripeAccountId, store.stripeChargesEnabled, store.subscriptionActive, store.tier, store.subscriptionId], [DEMO_CONNECTED_ACCOUNT, true, true, "pro", null]);
  is("it can sell", canSell(store), true);
  is("the planner, with the two prices, the two other products and the call after it", [productIds(store).length, listing.options.map((o) => [o.label, o.priceCents])], [4, [["1 week", 2700], ["5 weeks", 3900]]]);
  const rest = (await readListings(store, productIds(store))).filter((p) => p.id !== listing.id);
  const others = rest.filter((p) => !p.call);
  const call = rest.find((p) => p.call) ?? null;
  const folderOf = await storeFolder(HOUSE_OWNER);
  is(
    "each of the others is for sale at its price, with its own real PDF, its picture and its long description",
    others.map((p) => [p.title, p.priceCents, p.file?.name, p.file ? ownsPath(p.file.pathname, folderOf, p.id) : false, Boolean(p.image?.small), p.about, canSellProduct(store, p)]),
    DEMO_EXTRAS.map((e) => [e.title, Number(e.price) * 100, e.file, true, true, true, true]),
  );
  is("its own questions, each true of the demo", store.faq.map((item) => item.q), DEMO_STORE.faq.map((item) => item.q));
  const note = listing.note ? await readThanksNote(store.statsId, listing.id) : null;
  is("Jenny's note after paying: words and one button back to us, no video", [Boolean(note?.body), note?.video ?? null, note?.button?.label], [true, null, "Open a store like this one"]);
  is("both prices can be paid in 3 monthly payments, each its own", listing.options.map((o) => planFor(listing, o.id)?.amountCents), [900, 1300]);
  is("buy more, save more is on, so a visitor sees it under Add to cart", [store.cartDeal, offersCart(store)], [{ on: true, min: 2, percent: 10 }, true]);
  is("the demo's one link is in the spotlight", store.links.map((l) => [l.title, l.spotlight]), [[DEMO_STORE.link.title, true]]);
  is("which can be bought", canSellProduct(store, listing), true);

  const folder = await storeFolder(HOUSE_OWNER);
  is(
    "each price has its own file, in the store's own folder, exactly as long as the file is",
    listing.options.map((o) => [o.file?.name, o.file ? ownsPath(o.file.pathname, folder, o.id) : false, o.file?.bytes, o.file?.contentType]),
    DEMO_PRODUCT.options.map((want) => [want.file, true, getDemoFile(want.file).byteLength, "application/pdf"]),
  );
  is("and each of those files was put in the file store", listing.options.every((o) => puts.some((p) => p.pathname === o.file?.pathname && p.type === "application/pdf")), true);
  is(
    "its picture is in the store's own picture folder, measured from the file itself, across the card",
    [listing.image ? ownsImagePath(listing.image.path, await imageFolder(HOUSE_OWNER)) : false, listing.image?.width, listing.image?.height, listing.image?.alt, listing.display],
    [true, 1200, 675, DEMO_PRODUCT.image.alt, "preview"],
  );
  is("the store has its photo, kept where every store's is", (await readPhoto(store.photoId ?? ""))?.type, "image/webp");
  is("the product's page has its long description", [listing.about, await readAbout(store.statsId, listing.id)], [true, DEMO_PRODUCT.about]);
  is("and one link", store.links.map((l) => [l.title, l.url]), [[DEMO_STORE.link.title, DEMO_STORE.link.url]]);
  is(
    "beside it, the smaller copy a phone is handed, in the same folder",
    [listing.image?.small ? ownsImagePath(listing.image.small.path, await imageFolder(HOUSE_OWNER)) : false, listing.image?.small?.width, listing.image?.small?.path !== listing.image?.path],
    [true, 800, true],
  );
  is(
    "and the page offers the browser both, with the width of each",
    listing.image ? imageSrcSet(listing.image) : "",
    listing.image ? `${imageUrl(listing.image.small!)} 800w, ${imageUrl(listing.image)} 1200w` : "none",
  );
  is("four files and the two sizes of four pictures were put; the photo and the eight sizes fetched", [puts.length, fetched.length], [12, 9]);

  is(
    "the call is for sale at its price, with its picture, its long description and no file to hand over",
    [call?.title, call?.priceCents, call?.file ?? null, Boolean(call?.image?.small), call?.about, call ? canSellProduct(store, call) : false],
    [DEMO_CALL.title, Number(DEMO_CALL.price) * 100, null, true, true, true],
  );
  is(
    "its hours, its length and the service its meetings are made on",
    [call?.call?.kind, call?.call?.minutes, call?.call?.tz, call?.call?.seats, call?.call?.meet, call?.call?.weekly.map((day) => day.length)],
    ["weekly", 30, DEMO_CALL.setup.tz, 1, "zoom", [0, 1, 1, 1, 1, 1, 0]],
  );

  part("Asked again, it does only what is missing");
  const [putsBefore, fetchedBefore] = [puts.length, fetched.length];
  const again = await ensureDemoStore(deps);
  is("everything in place is one read of the mark", [again.ok, again.pending, again.ran], [true, [], false]);
  is("and nothing is put or fetched", [puts.length, fetched.length], [putsBefore, fetchedBefore]);

  // Another deployment: the mark carries the fingerprint of other code.
  const mark = JSON.parse((await redis.pipeline([["GET", "nl:house:seed"]]))[0] as string) as Record<string, unknown>;
  is("the mark carries this code's fingerprint", mark.v, seedFingerprint());
  await redis.pipeline([["SET", "nl:house:seed", JSON.stringify({ ...mark, v: "another-deployment" })]]);
  const after = await ensureDemoStore(deps);
  is("after a deployment that changed the code it is gone through again", [after.ok, after.pending, after.ran], [true, [], true]);
  is("without putting or fetching what is already there", [puts.length, fetched.length], [putsBefore, fetchedBefore]);
  is("and without a second product, option or link", [productIds((await theProduct()).store).length, (await theProduct()).listing.options.length, (await theProduct()).store.links.length], [4, 2, 1]);

  // The store's photo is gone and the place it is fetched from is down.
  ({ store } = await theProduct());
  await redis.pipeline([["SET", "nl:house:seed", JSON.stringify({ ...mark, v: "another-deployment", photo: "" })]]);
  photoHostDown = true;
  const failed = await ensureDemoStore(deps);
  is("a photograph that cannot be fetched is named, and the store is still there", [failed.ok, failed.pending], [true, ["photo:fetch_502"]]);
  const tries = fetched.length;
  const soon = await ensureDemoStore(deps);
  is("it is not tried again on the next visit", [soon.ran, soon.pending, fetched.length], [false, ["photo:fetch_502"], tries]);
  photoHostDown = false;
  const stale = JSON.parse((await redis.pipeline([["GET", "nl:house:seed"]]))[0] as string) as Record<string, unknown>;
  await redis.pipeline([["SET", "nl:house:seed", JSON.stringify({ ...stale, at: (stale.at as number) - 3600 })]]);
  const healed = await ensureDemoStore(deps);
  is("later it is, and then nothing is missing", [healed.ran, healed.pending, fetched.length], [true, [], tries + 1]);

  part("A picture's size is read from the picture");
  is("an extended WebP", imageSize(webp(1200, 675)), { width: 1200, height: 675 });
  const lossy = new Uint8Array(40);
  lossy.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0xe0, 0x01, 0x68, 0x01]);
  is("a plain WebP", imageSize(lossy), { width: 480, height: 360 });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0xa3, 0x04, 0xb0, 3, 0, 0, 0, 0, 0, 0]);
  is("a JPEG", imageSize(jpeg), { width: 1200, height: 675 });
  is("anything else is not measured", imageSize(new Uint8Array(40)), null);

  part("A picture and its smaller copy");
  const big = { path: `images/${"a".repeat(24)}/${"1".repeat(32)}.webp`, width: 1600, height: 900, alt: "", bytes: 300_000 };
  const copy = { path: `images/${"a".repeat(24)}/${"2".repeat(32)}.webp`, width: 800, bytes: 90_000 };
  is("kept together", parseProductImage({ ...big, small: copy })?.small, copy);
  is("a picture from before copies were made has none, and is shown from its one file", [parseProductImage(big)?.small, imageSrcSet({ ...big, small: null })], [null, undefined]);
  is("a copy as wide as the picture is not one", parseProductImage({ ...big, small: { ...copy, width: 1600 } })?.small, null);
  is("nor is one that is the picture itself", parseProductImage({ ...big, small: { ...copy, path: big.path } })?.small, null);
  is("nor one from another store's folder", parseProductImage({ ...big, small: { ...copy, path: `images/${"b".repeat(24)}/${"2".repeat(32)}.webp` } })?.small, null);
  is("both files are deleted together", imagePaths({ ...big, small: copy }), [big.path, copy.path]);
  const card = withoutComments(read("components/store-product.tsx"));
  is("the store page's card hands the browser both", /srcSet=\{servedSrcSet\(image\)\}/.test(card) && /sizes=\{image\.small \?/.test(card), true);
  is("and tells it to fetch the first product's picture first", /fetchPriority=\{first \? "high" : undefined\}/.test(card), true);
  is("the product's own page hands it both too", /srcSet=\{servedSrcSet\(product\.image\)\}/.test(withoutComments(read("app/[handle]/p/[product]/page.tsx"))), true);
  const editor = withoutComments(read("components/product-image-editor.tsx"));
  is("the studio makes the copy when a picture is added, and sends it with the picture", /await shrink\(file, SMALL_LONG_SIDE\)/.test(editor) && /\.\.\.\(small \? \{ small \} : \{\}\)/.test(editor), true);
  const attach = withoutComments(read("app/api/store/image/route.ts"));
  is("what is attached is checked as the picture is, and deleted with it", /smallWidth < width/.test(attach) && /copyKind === copy\.contentType/.test(attach) && /del\(imagePaths\(result\.removed\)\)/.test(attach), true);

  part("Its checkout is the real one, on the demo's own account and key");
  is("the demo's account is asked with the demo's key", keyFor(DEMO_CONNECTED_ACCOUNT), DEMO_KEY);
  is("a creator's account with ours", keyFor("acct_1Creator00001"), OUR_TEST_KEY);
  ({ store, listing } = await theProduct());
  const product = (await readProduct(store, listing.id))!;
  const five = product.options.find((o) => o.label === "5 weeks")!;
  stripe.length = 0;
  const opened = await createCheckout(store, product, "https://marktmorgen.com", five.id, { digitalConsent: TEST_CONSENT });
  const sent = stripe[0];
  is("one request, and it opens", [stripe.length, opened.url], [1, "https://checkout.stripe.com/c/pay/demo"]);
  is("signed with the demo's key, on the demo's account", [sent.key, sent.account], [DEMO_KEY, DEMO_CONNECTED_ACCOUNT]);
  is("for the price of the option picked, read from the store", [sent.body.get("line_items[0][price_data][unit_amount]"), sent.body.get("metadata[option]"), sent.body.get("metadata[store]")], ["3900", five.id, HOUSE_HANDLE]);
  is("coming back to the store's own thanks page", sent.body.get("success_url"), `https://marktmorgen.com/@${HOUSE_HANDLE}/thanks?session_id={CHECKOUT_SESSION_ID}`);
  is("and named as the store is, not as its test account is", sent.body.get("branding_settings[display_name]"), "Harbor Kitchen");

  stripe.length = 0;
  refuseName = true;
  const unnamed = await createCheckout(store, product, "https://marktmorgen.com", five.id, { digitalConsent: TEST_CONSENT });
  refuseName = false;
  is("a refused name never costs the checkout: it opens without", [stripe.length, stripe[1]?.body.has("branding_settings[display_name]"), unnamed.url], [2, false, "https://checkout.stripe.com/c/pay/demo"]);

  // The day our own key is a live one.
  process.env.STRIPE_SECRET_KEY = OUR_LIVE_KEY;
  stripe.length = 0;
  await createCheckout(store, product, "https://marktmorgen.com", five.id, { digitalConsent: TEST_CONSENT });
  is("with a live key of ours, the demo still asks with its test key", [stripe[0].key, stripe[0].account], [DEMO_KEY, DEMO_CONNECTED_ACCOUNT]);
  is("and still says it sells in test mode", sellsInTestMode(store), true);
  is("which a creator's store then does not", sellsInTestMode({ stripeAccountId: "acct_1Creator00001" }), false);
  process.env.STRIPE_DEMO_SECRET_KEY = "sk_live_never_for_the_demo";
  is("a live key is never taken for the demo's account", keyFor(DEMO_CONNECTED_ACCOUNT), null);
  process.env.STRIPE_DEMO_SECRET_KEY = DEMO_KEY;
  process.env.STRIPE_SECRET_KEY = OUR_TEST_KEY;

  // A creator's store beside it is named by its own Stripe account, as before.
  await claimHandle("owner@example.com", "sourdough", "Sourdough", "");
  await setStripeAccount("owner@example.com", "acct_1Creator00001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Starter Guide", "", "19");
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/guide");
  const theirs = (await storeForEmail("owner@example.com"))!;
  stripe.length = 0;
  await createCheckout(theirs, (await readProduct(theirs, made.product.id))!, "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT });
  is("a creator's checkout is asked with our key and carries no name of ours", [stripe[0].key, stripe[0].account, stripe[0].body.has("branding_settings[display_name]")], [OUR_TEST_KEY, "acct_1Creator00001", false]);

  part("The ways it is not like other stores");
  emails.length = 0;
  const keys = async () => ((await redis.pipeline([["SCAN", "0", "MATCH", "*", "COUNT", 100000]]))[0] as [string, string[]])[1].length;
  const keysBefore = await keys();
  is("no sign-in link is made for its owner", await sendSignInLink(HOUSE_OWNER, "https://marktmorgen.com"), false);
  is("nothing is written and nothing is sent", [await keys(), emails.length], [keysBefore, 0]);
  is("it takes no reviews, and a creator's store does", [takesReviews(store), takesReviews(theirs)], [false, true]);
  stripe.length = 0;
  is("an order of its is proof of nothing to review", (await provePurchase(store, `cs_test_${"d".repeat(24)}`)).state, "no");
  is("and Stripe is not even asked", stripe.length, 0);
  is("it writes to no buyer", canConfirm(store), false);
  const plans = withoutComments(read("lib/billing-sync.ts"));
  is("the daily check of plans asks only about a store that names a subscription", /if \(!store\.subscriptionActive \|\| !store\.subscriptionId \|\|/.test(plans), true);
  const studio = withoutComments(read("app/studio/page.tsx"));
  is("and so does the studio", /store\?\.subscriptionId && isBillingConfigured\(\)\s*\?\s*await readSubscription/.test(studio), true);

  part("Its pages are the pages every store has, and say that it is a demo");
  const layout = withoutComments(read("app/[handle]/layout.tsx"));
  is("the strip is on every page of the demo store, and of no other", /store && isHouseStore\(store\) \? <DemoStrip \/> : null/.test(layout), true);
  const notes = read("components/demo-notes.tsx");
  is("it says no real money moves, and which card to type", /no real money moves/.test(notes) && /\{TEST_CARD\}/.test(notes), true);
  const page = withoutComments(read("app/[handle]/page.tsx"));
  is("the store page asks the store whether it sells in test mode", /const rehearsal = selling && sellsInTestMode\(store\);/.test(page), true);
  is("and the product page does too", /const rehearsal = selling && sellsInTestMode\(store\);/.test(withoutComments(read("app/[handle]/p/[product]/page.tsx"))), true);

  part("Nothing of the hand-written demo is left");
  is("no page of its own, no thanks page, no routes", ["app/demo/thanks", "app/demo/recover", "app/api/demo"].map((p) => existsSync(join(process.cwd(), p))), [false, false, false]);
  const demo = withoutComments(read("app/demo/page.tsx"));
  is("/demo makes sure the store is there and sends the visitor to it", /await ensureDemoStore\(\)/.test(demo) && /if \(seed\.ok\) redirect\(`\/@\$\{HOUSE_HANDLE\}`\);/.test(demo), true);
  is("and draws no product or buy button of its own", /<form|<button|priceCents|\$\d/.test(demo), false);
  is("the home page links to the store itself, and no longer squeezes it into a frame", [/<a href="\/demo"/.test(read("app/page.tsx") + read("components/home-claim.tsx")), /<iframe/.test(read("app/page.tsx") + read("components/home-claim.tsx") + read("components/home-parts.tsx"))], [true, false]);
  const everything = [...sources("app"), ...sources("components"), ...sources("lib")];
  is(
    "nothing anywhere posts to the old demo routes",
    everything.filter((file) => /\/api\/demo\//.test(withoutComments(read(file)))),
    [],
  );

  part("Every form that opens a payment page leaves the frame it is in");
  const OPENS = /action=(?:"\/api\/store\/(?:checkout|package|tip|paypal\/checkout)"|\{[^}]*"\/api\/store\/book"[^}]*\})/;
  const forms = [...sources("app"), ...sources("components")].flatMap((file) =>
    [...withoutComments(read(file)).matchAll(/<form\b[^>]*>/g)].map((m) => ({ file, tag: m[0] })).filter((f) => OPENS.test(f.tag)),
  );
  // The card pasted into other sites (lib/embed-rules.ts) opens a new tab
  // instead: some page builders hold pasted code in a frame that may not
  // move the page, and every one of them lets it open a tab.
  const EMBED = "app/embed/[handle]/[product]/page.tsx";
  const leaves = (file: string, tag: string) => /target="_top"/.test(tag) || (file.endsWith(EMBED) && /target="_blank"/.test(tag));
  is("there are such forms to check", forms.length >= 9, true);
  is("each of them has target=\"_top\", or a new tab on the pasted card", forms.filter((f) => !leaves(f.file, f.tag)).map((f) => f.file), []);
  const marked = [...sources("app"), ...sources("components")].flatMap((file) =>
    [...withoutComments(read(file)).matchAll(/<form\b[^>]*data-checkout[^>]*>/g)].filter((m) => !leaves(file, m[0])).map(() => file),
  );
  is("and so has every form marked as opening a checkout", marked, []);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
