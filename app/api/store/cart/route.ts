import { type DigitalConsent, DigitalConsentMissing, consentFromForm } from "@/lib/digital-consent";
import { withinStore } from "@/lib/metered-limits";
import { type NextRequest, after } from "next/server";
import { OrdersPausedError } from "@/lib/order-admission";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { readListings, readProduct } from "@/lib/catalog";
import { canSell, canSellProduct } from "@/lib/store-checkout";
import { cartPrice, createCartCheckout } from "@/lib/cart-checkout";
import { codeCookieName, readLinkCode } from "@/lib/code-link";
import { MAX_CART, cartable, dealOff, readCartIds } from "@/lib/cart-rules";
import { bestBundleSwap } from "@/lib/cart-bundle";
import { cartPicks } from "@/lib/store-collections";
import { readSoldCounts } from "@/lib/sold-count";
import { cartWords } from "@/lib/buyer-words/cart";
import type { Store } from "@/lib/store";
import { salePrice } from "@/lib/store-sale";
import { soonState } from "@/lib/preorders";
import { outOfKeys } from "@/lib/licence-keys";
import { readCountry } from "@/lib/fair-price";
import { formatMoney } from "@/lib/money";
import { LANGUAGES } from "@/lib/store-language";
import { cameFrom } from "@/lib/came-from";
import { channelOfRequest } from "@/lib/visit-channel";
import { adsCheckout } from "@/lib/ad-events";
import { affiliateCookieName, attributionFor } from "@/lib/affiliates";
import { viaCookieName } from "@/lib/affiliate-setting";
import { countHit } from "@/lib/visit";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { productSegment } from "@/lib/product-slug";
import { noteCheckoutTrouble } from "@/lib/checkout-trouble";
import { assistReminderShown, keepAssistReminder } from "@/lib/assistant-reminder";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { cartOfferOwner } from "@/lib/cart-offers";
import { UPSELL_COOKIE, newUpsellKey } from "@/lib/upsell";
import { CartShippingRefused } from "@/lib/cart-checkout";
import { cartItemOf, cartShipping, shipsWithOnline } from "@/lib/cart-shipping";
import { SHIP_REGIONS, activeShipping, shipsToWords } from "@/lib/shipping";
import { shippingWords } from "@/lib/buyer-words/shipping";
import { deliversDigitally } from "@/lib/digital-consent";
import { releaseCartStockHolds, stockLeft, withCartStockHolds } from "@/lib/stock";
import { HOLD_SECONDS } from "@/lib/stripe-account";

/** The cart's checkout last opened in this browser, whose held units are handed back when it pays for a cart again (lib/stock.ts). */
const CART_HOLD_COOKIE = "nl_cart_hold";

/**
 * What a cart holds, as the store has it now (`GET ?handle=&ids=a,b`): each
 * product's name, its address, what it is charged in this visitor's country
 * today, and whether it can still go in a cart. Read when the cart is opened,
 * so it never shows a price the checkout would not charge.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const handle = normaliseHandle((params.get("handle") ?? "").slice(0, 40));
  const ids = readCartIds((params.get("ids") ?? "").split(","));
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  if (!(await withinStore("cart-read", `${clientAddress(request)}|${store.handle}`, 120, 600, store))) {
    return Response.json({ ok: false, error: "slow" }, { status: 429 });
  }
  const country = readCountry(request.headers.get("x-vercel-ip-country"));
  const locale = LANGUAGES[store.language].locale;
  const [listings, coming] = await Promise.all([ids.length ? readListings(store, ids) : Promise.resolve([]), soonState(store).catch(() => ({ soon: new Set<string>() }))]);
  // A limited product with none left cannot be paid for: said on its line (lib/stock.ts). A count that cannot be read is
  // not a unit either, but is not said to be sold out: it is not available in a cart right now (undefined).
  const left = new Map(await Promise.all(listings.filter((p) => p.stock !== null).map(async (p) => [p.id, await stockLeft(store, p).catch(() => undefined)] as const)));
  const selling = canSell(store);
  const sw = shippingWords(store.language);
  const items = ids.flatMap((id) => {
    const product = listings.find((p) => p.id === id);
    if (!product) return [];
    const { cents } = cartPrice(store, product, country);
    // A product the creator ships: its own line about when it ships, as its page says it (lib/shipping.ts).
    const shipped = activeShipping(product);
    const ships = shipped ? [shipped.cents > 0 ? sw.cost(formatMoney(shipped.cents, store.currency, locale)) : sw.free, shipped.note].filter(Boolean).join(" · ") : null;
    const soldOut = left.get(id) === 0;
    const unknown = left.has(id) && left.get(id) === undefined;
    return [{ id, title: product.title, href: `/@${store.handle}/p/${productSegment(product)}`, cents, price: formatMoney(cents, store.currency, locale), ok: selling && cartable(product) && !coming.soon.has(id) && !soldOut && !unknown, ships, soldOut }];
  });
  // What ships, as the checkout will ask Stripe for it (lib/cart-shipping.ts), from what can be paid for.
  const shippable = items.filter((item) => item.ok).flatMap((item) => listings.filter((p) => p.id === item.id));
  const sending = cartShipping(shippable.map(cartItemOf), country);
  // A shipped product whose shipping cannot be read cannot go in a cart (unknown fails, never digital).
  // The catalog already drops shipping it cannot read (lib/shipping.ts, parseShipping), so this holds should one ever reach here.
  if (sending.kind === "unreadable") for (const item of items) if (sending.items.some((bad) => bad.id === item.id)) item.ok = false;
  const payable = items.filter((item) => item.ok);
  const before = payable.reduce((sum, item) => sum + item.cents, 0);
  // The store's deal for buying more (lib/cart-rules.ts): taken off each line, as the checkout does.
  const deal = dealOff(store.cartDeal, payable.length);
  const shippingCents = sending.kind === "ships" ? sending.cents : 0;
  const goods = payable.reduce((sum, item) => sum + salePrice(item.cents, deal), 0);
  // What Stripe will charge before any tax: the lines, then the shipping on its own line.
  const total = goods + shippingCents;
  const words = cartWords(store.language);
  const said = (titles: string[], and: string) => (titles.length > 1 ? `${titles.slice(0, -1).join(", ")} ${and} ${titles[titles.length - 1]}` : (titles[0] ?? ""));
  const countryName = (code: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  // Said before the buyer pays: what shipping comes to and where it can go, or
  // which products cannot go with the rest; and whether anything is handed
  // over digitally, which is when the box to start at once is asked for.
  const shipping =
    sending.kind === "ships"
      ? {
          amount: sending.cents > 0 ? formatMoney(sending.cents, store.currency, locale) : null,
          label: sending.cents > 0 ? sw.rate : sw.freeRate,
          where: sw.shipsTo(
            shipsToWords(
              { region: sending.countries.length === SHIP_REGIONS.world.countries.length ? "world" : "custom", countries: sending.countries },
              locale,
              { and: sw.and, more: sw.more, everywhere: sw.everywhere },
            ),
          ),
          notTo: country && !sending.countries.includes(country) ? words.notTo(countryName(country)) : null,
        }
      : null;
  // Shipped and online products together: not paid for yet (lib/cart-shipping.ts, shipsWithOnline).
  const mixed = shipsWithOnline(shippable);
  const apart = mixed
    ? { ids: shippable.map((p) => p.id), why: words.mixed }
    : sending.kind === "apart"
      ? { ids: sending.apart.map((p) => p.id), why: words.apart(said(sending.apart.map((p) => p.title), words.and), sending.apart.length, countryName(sending.to)) }
      : null;
  const digital = shippable.some((product) => deliversDigitally(product));
  const more = store.cartDeal.on && payable.length > 0 && payable.length < store.cartDeal.min ? store.cartDeal.min - payable.length : 0;
  // What could go in it too: first what the creator picked to go with what is
  // in it (lib/store-collections.ts), said as their pick; then what the buyers
  // of what is in it also bought (lib/also-bought.ts), on a store that shows
  // what was bought, said as that count.
  const inCart = payable.flatMap((item) => {
    const listing = listings.find((p) => p.id === item.id);
    return listing ? [{ id: item.id, title: item.title, pairs: listing.pairs ?? [] }] : [];
  });
  const suggest = await suggestions(store, inCart, ids, coming.soon, country, locale).catch(() => []);
  const bundle = bundleSwap(store, payable, ids, coming.soon, country, locale);
  return Response.json(
    {
      ok: true,
      items,
      deal: deal > 0 ? { percent: deal, saved: formatMoney(before - goods, store.currency, locale) } : null,
      next: more > 0 ? { more, percent: store.cartDeal.percent } : null,
      total: formatMoney(total, store.currency, locale),
      shipping,
      apart,
      digital,
      suggest,
      bundle,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/**
 * The creator's own bundle that holds what is in the cart and makes the cart
 * cost less, when there is one (lib/cart-bundle.ts): only the bundles the
 * store's record already carries for its first page, so nothing more is read.
 */
function bundleSwap(
  store: Store,
  payable: { id: string; title: string; cents: number }[],
  ids: string[],
  soon: Set<string>,
  country: string,
  locale: string,
) {
  if (payable.length === 0 || !canSell(store)) return null;
  const offers = store.catalog.head.filter(
    (product) => product.bundle && !ids.includes(product.id) && !soon.has(product.id) && !product.keys && cartable(product) && canSellProduct(store, product),
  );
  if (offers.length === 0) return null;
  const swap = bestBundleSwap(
    payable.map((line) => ({ id: line.id, cents: line.cents })),
    offers.map((product) => ({ id: product.id, cents: cartPrice(store, product, country).cents, items: product.bundle ?? [] })),
    store.cartDeal,
  );
  if (!swap) return null;
  const product = offers.find((p) => p.id === swap.id)!;
  const words = cartWords(store.language);
  const titles = payable.filter((line) => swap.replaces.includes(line.id)).map((line) => line.title);
  const held = titles.length > 1 ? `${titles.slice(0, -1).join(", ")} ${words.and} ${titles.at(-1)}` : titles[0];
  return {
    id: product.id,
    title: product.title,
    href: `/@${store.handle}/p/${productSegment(product)}`,
    price: formatMoney(cartPrice(store, product, country).cents, store.currency, locale),
    holds: words.bundleHolds(held, swap.more),
    save: words.bundleSave(formatMoney(swap.before - swap.after, store.currency, locale)),
    replaces: swap.replaces,
  };
}

/** How many products the cart suggests at most, the creator's picks first. */
const MAX_SUGGEST = 3;

/** One product the open cart offers: the creator's pick, or one counted from real sales. */
type Suggestion = { id: string; title: string; href: string; price: string; why: string; kind: "pick" | "bought"; count: number };

async function suggestions(
  store: Store,
  inCart: { id: string; title: string; pairs: string[] }[],
  ids: string[],
  soon: Set<string>,
  country: string,
  locale: string,
): Promise<Suggestion[]> {
  if (inCart.length === 0 || ids.length >= MAX_CART || !canSell(store)) return [];
  const words = cartWords(store.language);
  const titleOf = new Map(inCart.map((item) => [item.id, item.title]));
  // The creator's picks first, in the order they set them (lib/store-collections.ts).
  const picks = cartPicks(inCart, [...ids, ...soon]).slice(0, MAX_SUGGEST * 3);
  // Then each other product with the most buyers it shares with anything in the cart.
  const counts = await readSoldCounts(store).catch(() => null);
  const best = new Map<string, { count: number; with: string }>();
  for (const item of inCart) {
    for (const [other, count] of counts?.together[item.id] ?? []) {
      if (ids.includes(other) || soon.has(other) || picks.some((pick) => pick.id === other)) continue;
      if ((best.get(other)?.count ?? 0) < count) best.set(other, { count, with: item.title });
    }
  }
  const ranked = [...best.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, MAX_SUGGEST * 3);
  const wanted: { id: string; kind: "pick" | "bought"; why: string; count: number }[] = [
    ...picks.map((pick) => ({ id: pick.id, kind: "pick" as const, why: words.pickWhy(store.name, titleOf.get(pick.with) ?? ""), count: 0 })),
    ...ranked.map(([id, pair]) => ({ id, kind: "bought" as const, why: words.suggestWhy(pair.count, pair.with), count: pair.count })),
  ];
  if (wanted.length === 0) return [];
  const listed = await readListings(store, wanted.map((want) => want.id));
  const out: Suggestion[] = [];
  for (const want of wanted) {
    const product = listed.find((p) => p.id === want.id);
    if (!product || !cartable(product) || !canSellProduct(store, product)) continue;
    if (product.keys && (await outOfKeys(store, product).catch(() => true))) continue;
    out.push({
      id: want.id,
      title: product.title,
      href: `/@${store.handle}/p/${productSegment(product)}`,
      price: formatMoney(cartPrice(store, product, country).cents, store.currency, locale),
      why: want.why,
      kind: want.kind,
      count: want.count,
    });
    if (out.length >= MAX_SUGGEST) break;
  }
  return out;
}

/**
 * Pays for a cart: a plain form with the store's handle and each product's
 * id (`id`, up to four). Nothing it sends sets a price. Every product is read
 * again and must still go in a cart: published, at one price, sold once,
 * nothing to choose, book or answer first, not coming soon, with keys left if
 * it hands one out, and a unit of each limited one held for this checkout.
 * Anything else sends the visitor back to the store with the cart as it was,
 * to look it over.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const away = (path: string) => new Response(null, { status: 303, headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" } });

  let handle = "";
  let ids: string[] = [];
  // The Store assistant's box for one reminder (lib/assistant-reminder.ts): checked, with an address and the sentence's version.
  let remind = false;
  let remindEmail = "";
  let remindVersion = "";
  // The box to start access at once, which loses the right to cancel once it starts (lib/digital-consent.ts).
  let digitalConsent: DigitalConsent | null = null;
  try {
    const form = await (await limited(request, 4_000)).formData();
    digitalConsent = consentFromForm(form);
    const h = form.get("handle");
    handle = typeof h === "string" ? normaliseHandle(h.slice(0, 40)) : "";
    ids = readCartIds(form.getAll("id"));
    remind = form.get("remind") === "yes";
    const typed = form.get("remind_email");
    const version = form.get("remind_v");
    remindEmail = remind && typeof typed === "string" ? normaliseEmail(typed.slice(0, MAX_EMAIL_LENGTH + 1)) : "";
    remindVersion = remind && typeof version === "string" ? version.slice(0, 40) : "";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle || ids.length === 0) return new Response("Bad request", { status: 400 });
  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });
  if (!(await withinLimit("checkout", `${clientAddress(request)}|${store.handle}`, 20, 600))) return away(`/@${store.handle}?status=slow`);
  if (!canSell(store)) return away(`/@${store.handle}`);

  const products = (await Promise.all(ids.map((id) => readProduct(store, id).catch(() => null)))).filter((p) => p !== null);
  // Which products are still coming soon: a reading that cannot be had is never "none" (review of #2846):
  // back to the cart to try again, nothing charged.
  const coming = await soonState(store).catch(() => null);
  if (!coming) return away(`/@${store.handle}?cart=error#cart`);
  const fit = products.length === ids.length && products.every((p) => cartable(p) && p.fields.length === 0 && !coming.soon.has(p.id));
  if (!fit) return away(`/@${store.handle}?cart=changed#cart`);
  for (const product of products) {
    // A key count that cannot be read never sells (SG2, finding 12): back to the cart to try again, nothing charged.
    const out = await outOfKeys(store, product).catch(() => null);
    if (out === null) return away(`/@${store.handle}?cart=error#cart`);
    if (out) return away(`/@${store.handle}?cart=changed#cart`);
  }

  try {
    const via = await attributionFor(store, products[0].id, {
      via: request.cookies.get(viaCookieName(store.handle))?.value,
      session: request.cookies.get(affiliateCookieName(store.handle))?.value,
    }).catch(() => null);
    const reminding = remind && remindEmail.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(remindEmail) && assistReminderShown(store);
    // Offers after paying, from the first product in the cart whose funnel is
    // on (lib/cart-offers.ts): a secret for this browser, its fingerprint on
    // the checkout, as for one product (app/api/store/checkout/route.ts).
    const offerFrom = await cartOfferOwner(store, products).catch(() => null);
    const upsell = offerFrom ? newUpsellKey() : null;
    // A buyer who went back from Stripe's page hands back the units that checkout held before holding them again (lib/stock.ts).
    const previous = request.cookies.get(CART_HOLD_COOKIE)?.value ?? "";
    if (previous) await releaseCartStockHolds(store, products, previous).catch(() => {});
    // One unit of each limited product held for this checkout, or nothing opened (lib/stock.ts, withCartStockHolds).
    const holding = await withCartStockHolds(store, products, async (held) => createCartCheckout(store, products, linkOrigin(request, store), {
      held,
      remind: reminding,
      // A code that came in a link to this store (lib/code-link.ts), applied
      // by Stripe only if it is one of the creator's live codes.
      code: readLinkCode(request.cookies.get(codeCookieName(store.handle))?.value) || undefined,
      country: readCountry(request.headers.get("x-vercel-ip-country")),
      cameFrom: cameFrom(request.headers.get("referer"), new URL(origin).hostname),
        // The channel this sale is credited to: the page's own tags, else the
        // one remembered for this visitor (lib/visit-channel.ts), else direct.
        channel: { ...channelOfRequest(request, store.handle, new URL(origin).hostname, Date.now() / 1000, store.attributionDays), ...(await adsCheckout(request, store)) },
      via,
      digitalConsent,
      offers: upsell && offerFrom ? { upsellKey: upsell.fingerprint, from: offerFrom.id } : null,
    }), (error) => error instanceof OrdersPausedError || error instanceof DigitalConsentMissing || error instanceof CartShippingRefused);
    // Sold out since the cart was opened: back to it, which says which; busy or unreadable: nothing was charged, try again.
    if (!holding.ok) return away(`/@${store.handle}?cart=${holding.reason === "soldout" ? "changed" : "error"}#cart`);
    const opened = holding.value;
    if (reminding) await keepAssistReminder({ store, session: opened.id, email: remindEmail, version: remindVersion });
    for (const product of products) after(() => countHit(request, store, { kind: "checkout", id: product.id }));
    const headers = new Headers({ Location: opened.url, "Cache-Control": "no-store" });
    // The secret only the browser that pays holds: without it no offer can be answered.
    if (upsell) headers.append("Set-Cookie", `${UPSELL_COOKIE}=${upsell.secret}; Path=/; Max-Age=7200; HttpOnly; SameSite=Lax${origin.startsWith("https://") ? "; Secure" : ""}`);
    if (products.some((product) => product.stock !== null)) {
      headers.append("Set-Cookie", `${CART_HOLD_COOKIE}=${opened.id}; Path=/api/store/cart; Max-Age=${HOLD_SECONDS}; HttpOnly; SameSite=Lax${origin.startsWith("https://") ? "; Secure" : ""}`);
    }
    return new Response(null, { status: 303, headers });
  } catch (error) {
    if (error instanceof OrdersPausedError) return away(`/@${store.handle}?status=${error.reason === "paused" ? "paused" : "error"}`);
    // The box was not checked (or the page was from before its words changed): back to the cart, nothing charged.
    if (error instanceof DigitalConsentMissing) return away(`/@${store.handle}?cart=consent#cart`);
    // Its physical products cannot all be shipped to one address any more (lib/cart-shipping.ts): back to the cart, which says which.
    if (error instanceof CartShippingRefused) return away(`/@${store.handle}?cart=changed#cart`);
    console.error("a cart's checkout failed", error);
    after(() => noteCheckoutTrouble(store, error).catch(() => {}));
    return away(`/@${store.handle}?cart=error#cart`);
  }
}
