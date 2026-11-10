/**
 * A cart's checkout (the rules are in lib/cart-rules.ts): one plain payment
 * for several of a store's products, on the creator's own Stripe account,
 * like every other charge here (lib/store-checkout.ts).
 *
 * The first product is the order's product, and the others are named the
 * way products added at checkout always are (lib/bundle-rules.ts,
 * BUMP_KEYS), each with a bundle's list when it is one. So the thank-you
 * page, the emails, the list of purchases, downloads, courses, keys,
 * reviews, refunds and the creator's numbers hand each of them over and
 * count it exactly as they do a product ticked at checkout, with nothing new
 * to read.
 *
 * Each line is charged at its own price as the store shows it now: less the
 * store's sale on that product while it runs, or the fair price for the
 * buyer's country when that takes off more (lib/store-sale.ts,
 * lib/fair-price.ts). Taken off line by line, because a sale may be on some
 * products and not others; a discount code box is offered only when nothing
 * was taken off, as on any other checkout here.
 */
import { itemsHandedOver } from "@/lib/store-data-rules";
import { ADMITTED_FIELD, OrdersPausedError, admitOrders } from "@/lib/order-admission";
import type { Product, Store } from "@/lib/store";
import { KIND, readListings } from "@/lib/catalog";
import { BUMP_KEYS, MIN_BUNDLE_ITEMS, bundleMeta, deliverableItems } from "@/lib/bundle-rules";
import { heldIdsAmong } from "@/lib/child-safety-holds";
import { type SaleCandidate, saleOff, salePrice } from "@/lib/store-sale";
import { fairOff } from "@/lib/fair-price";
import { commissionRate } from "@/lib/affiliate-setting";
import { applyTax, applyTaxDocuments, refusedTaxDocuments, withoutTaxDocuments } from "@/lib/tax";
import { inTheCurrencyShown, onlyInstantMethods, saveCardForOffers } from "@/lib/instant-pay";
import { StripeError, checkoutClosesAt, onAccount } from "@/lib/stripe-account";
import { LANGUAGES } from "@/lib/store-language";
import { type CameFrom, hasSource } from "@/lib/came-from";
import { isHouseStore } from "@/lib/house-store";
import { CART_OFFER_META, MAX_CART, dealOff } from "@/lib/cart-rules";
import { RECOVERY_OPEN_SECONDS, applyRecovery, recoveryOn, refusedRecovery, withoutRecovery } from "@/lib/recovery-setting";
import { applyShare, leastPaid, linesTotal, shareBps } from "@/lib/platform-share";
import { codesMayTakeOff, livePromotionId } from "@/lib/discount";
import { CONSENT_META, type DigitalConsent, consentMetaValue, deliversDigitally, keepConsentOn, requireDigitalConsent } from "@/lib/digital-consent";
import { applyCartShipping, cartItemOf, cartShipping, shippedFirst, shipsWithOnline } from "@/lib/cart-shipping";

/**
 * A cart whose physical products cannot all be shipped to one address, one
 * whose shipping cannot be read, or one that mixes shipped products with
 * products handed over online (lib/cart-shipping.ts): refused before
 * anything is admitted or opened. The open cart says which before the buyer
 * pays, so this is met only by a cart that changed in between.
 */
export class CartShippingRefused extends Error {
  constructor(readonly why: "apart" | "unreadable" | "mixed") {
    super(`This cart cannot be shipped (${why})`);
    this.name = "CartShippingRefused";
  }
}

const DISPLAY_NAME = "branding_settings[display_name]";

/**
 * Whether a store offers a cart at all: two or more of its published products
 * could go in one, read from its own index without a single product read.
 */
export function offersCart(store: Store): boolean {
  // A limited product can go in one since its checkout holds a unit (lib/stock.ts, withCartStockHolds).
  const never = KIND.free | KIND.call | KIND.recurring | KIND.hidden;
  let count = 0;
  for (const item of store.catalog.items) {
    if ((item.kind & KIND.paid) !== 0 && (item.kind & never) === 0 && item.options.length === 0) count += 1;
    if (count >= 2) return true;
  }
  return false;
}

/** What one product in a cart is charged, in the store currency's smallest unit, and what was taken off. */
export function cartPrice(store: Pick<Store, "sale" | "fair">, product: SaleCandidate, country: string, nowSeconds = Math.floor(Date.now() / 1000)): { cents: number; off: number } {
  const sale = saleOff(store.sale, product, nowSeconds);
  const fair = fairOff(store.fair, product, country);
  const off = Math.max(sale, fair);
  return { cents: salePrice(product.priceCents, off), off };
}

/** Opens one checkout for every product in a cart, in its order. The caller has checked each can go in one. */
export async function createCartCheckout(
  store: Store,
  products: Product[],
  origin: string,
  extras: {
    country?: string;
    cameFrom?: CameFrom;
    /**
     * The channel this sale is credited to, as Stripe metadata
     * (lib/visit-channel.ts channelMetadata): the page's own tags, else the
     * channel remembered for this visitor, else direct. Written on the session.
     */
    channel?: Record<string, string>;
    /** The affiliate whose link the buyer followed, still inside the store's window (lib/affiliates.ts). */
    via?: { aff: string; rate: number; own?: number | null } | null;
    /**
     * A discount code that came in a link to this store (lib/code-link.ts),
     * applied by Stripe only if it is one of the creator's live codes, and
     * only when nothing else was taken off (624 [SZ8](23)).
     */
    code?: string;
    /** The buyer checked the Store assistant's box for one reminder (lib/assistant-reminder.ts): the checkout closes after an hour. */
    remind?: boolean;
    /** A unit of a limited product in it is held (lib/stock.ts, withCartStockHolds), so the checkout closes before the hold runs out. */
    held?: boolean;
    /** The buyer's yes to access at once (lib/digital-consent.ts), needed when anything in the cart is handed over digitally. */
    digitalConsent?: DigitalConsent | null;
    /**
     * Offers follow paying (lib/cart-offers.ts): the fingerprint of the key
     * set in this browser, and the cart product whose funnel they come from.
     */
    offers?: { upsellKey: string; from: string } | null;
  } = {},
): Promise<{ url: string; id: string }> {
  if (!store.stripeAccountId) throw new Error("This store has no account");
  if (products.length === 0 || products.length > MAX_CART) throw new Error("A cart holds one to four products");
  // Shipped and online products are not paid for together yet (lib/cart-shipping.ts, shipsWithOnline).
  if (shipsWithOnline(products)) throw new CartShippingRefused("mixed");
  // As the buyer put them in, for the way back to the cart.
  const asPut = products;
  // Shipped products first: the order's own product is the one the thanks page and the email show the address under.
  products = shippedFirst(products);
  // One address, in a country every physical product ships to (lib/cart-shipping.ts).
  const shipping = cartShipping(products.map(cartItemOf), extras.country);
  if (shipping.kind === "apart" || shipping.kind === "unreadable") throw new CartShippingRefused(shipping.kind);
  // Refused before anything is admitted or opened, as for one product (lib/store-checkout.ts).
  const digital = products.some((product) => deliversDigitally(product));
  requireDigitalConsent(digital, extras.digitalConsent);

  const country = extras.country ?? "";
  const body = new URLSearchParams({
    mode: "payment",
    // Stripe's paying label on its submit button ("Buy"), so the button that
    // places the order says it obliges payment (Directive 2011/83/EU art. 8(2);
    // EU consumer audit 2026-11-06, row 11). Read 6 November 2026 at
    // https://docs.stripe.com/api/checkout/sessions/create (API 2026-10-28):
    // `pay` "Submit button includes a 'Buy' label"; allowed only in payment or
    // subscription mode and not with ui_mode elements (this session is hosted).
    submit_type: "pay",
    locale: LANGUAGES[store.language].stripe,
    "metadata[store]": store.handle,
    "metadata[product]": products[0].id,
    "metadata[cart]": "yes",
    "metadata[title]": products.map((p) => p.title).join(" + ").slice(0, 480),
    "payment_intent_data[metadata][store]": store.handle,
    "payment_intent_data[metadata][product]": products[0].id,
    "payment_intent_data[metadata][cart]": "yes",
    success_url: `${origin}/@${store.handle}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/@${store.handle}`,
  });

  // Offers follow, exactly as after one product (lib/store-checkout.ts): the
  // buyer becomes the creator's customer and a card is kept only for payments
  // they make while present, the one-click offers on the thanks page. Only a
  // card is asked to be kept, so every other way to pay stays on offer; a
  // buyer who pays another way meets no offer (lib/instant-pay.ts).
  if (extras.offers && products.some((p) => p.id === extras.offers?.from)) {
    body.set("customer_creation", "always");
    saveCardForOffers(body);
    body.set("metadata[upsell_key]", extras.offers.upsellKey);
    body.set(`metadata[${CART_OFFER_META}]`, extras.offers.from);
  }

  // The store's deal for buying more (lib/cart-rules.ts): every line that much cheaper again.
  const deal = dealOff(store.cartDeal, products.length);
  if (deal > 0) body.set("metadata[cart_deal]", String(deal));
  let discounted = deal > 0;
  const lines: { key: string | null; cents: number; id: string }[] = [];
  // A bundle holding a product kept for a child-safety report is not sold (lib/child-safety-holds.ts): one read for
  // every bundle in the cart; a hold that cannot be read throws, so nothing reaches Stripe.
  const inBundles = products.flatMap((product) => product.bundle ?? []);
  const held = inBundles.length ? await heldIdsAmong(store, inBundles) : undefined;
  for (const [i, product] of products.entries()) {
    const key = i === 0 ? null : BUMP_KEYS[i - 1];
    // A bundle's list is written onto the order as it is now, as for any bundle sold.
    if (product.bundle) {
      const items = deliverableItems(product, await readListings(store, product.bundle), held);
      if (items.length < MIN_BUNDLE_ITEMS) throw new Error("A bundle in the cart holds too little right now");
      for (const [name, value] of Object.entries(bundleMeta(key ? `${key}_bundle` : "bundle", items.map((p) => p.id)))) body.set(`metadata[${name}]`, value);
    }
    const shown = cartPrice(store, product, country);
    const cents = salePrice(shown.cents, deal);
    const off = shown.off;
    if (off > 0) discounted = true;
    body.set(`line_items[${i}][quantity]`, "1");
    body.set(`line_items[${i}][price_data][currency]`, store.currency);
    body.set(`line_items[${i}][price_data][unit_amount]`, String(cents));
    body.set(`line_items[${i}][price_data][product_data][name]`, product.title);
    if (product.summary) body.set(`line_items[${i}][price_data][product_data][description]`, product.summary);
    if (key) {
      body.set(`metadata[${key}]`, product.id);
      body.set(`payment_intent_data[metadata][${key}]`, product.id);
      // What it was charged, which an affiliate's share is weighed by (lib/affiliates.ts).
      body.set(`metadata[${key}_cents]`, String(cents));
    }
    lines.push({ key, cents, id: product.id });
  }

  // Shipped by the creator: one address, and the shipping as its own line (lib/cart-shipping.ts).
  if (shipping.kind === "ships") applyCartShipping(body, store, products, shipping);

  // Sent by an affiliate: who, and each product's share as it is today.
  if (extras.via) {
    const own = extras.via.own ?? null;
    const rates = lines.map((line) => commissionRate(store.affiliates, line.id, own));
    if (rates.some((rate) => rate > 0)) {
      body.set("metadata[via]", extras.via.aff);
      body.set("metadata[via_rate]", String(rates[0]));
      body.set("payment_intent_data[metadata][via]", extras.via.aff);
      lines.forEach((line, i) => {
        if (line.key) body.set(`metadata[${line.key}_rate]`, String(rates[i]));
      });
    }
  }
  for (const [key, value] of Object.entries(extras.channel ?? {})) body.set(`metadata[${key}]`, value);
  if (extras.cameFrom && hasSource(extras.cameFrom)) {
    if (extras.cameFrom.source) body.set("metadata[utm_source]", extras.cameFrom.source);
    if (extras.cameFrom.medium) body.set("metadata[utm_medium]", extras.cameFrom.medium);
    if (extras.cameFrom.campaign) body.set("metadata[utm_campaign]", extras.cameFrom.campaign);
  }
  // One discount at a time, as everywhere here: a code box only when nothing was taken off already.
  const box = !discounted && store.hasDiscounts;
  // A code from a link goes on by itself, as on one product's checkout
  // (lib/store-checkout.ts); Stripe takes an applied discount or the box,
  // never both, so it is one or the other. Either is one of the store's own
  // codes, so what may come off below is the same.
  const promotion = box && extras.code ? await livePromotionId(store.stripeAccountId, extras.code) : null;
  if (promotion) {
    body.set("discounts[0][promotion_code]", promotion);
    body.set("metadata[code]", extras.code as string);
  } else if (box) body.set("allow_promotion_codes", "true");
  // The share of the sale, when the store's plan has one (lib/platform-share.ts):
  // the lines are already at the price the store set, and a code typed in the
  // box may take off as much as the largest the store has.
  const mayComeOff = box && shareBps(store) > 0 ? await codesMayTakeOff(store.stripeAccountId, store.currency) : [];
  applyShare(body, store, { recurring: false, least: leastPaid(linesTotal(body).cents, mayComeOff) });

  applyTax(store, body);
  applyTaxDocuments(store, body, false);
  onlyInstantMethods(body);
  inTheCurrencyShown(body);
  // A store with reminders on (lib/checkout-recovery.ts): Stripe asks for
  // consent where it offers to, and the way back leads to a page that offers
  // one reminder of the whole cart, which the buyer asks for themselves.
  const recovering = recoveryOn(store);
  if (recovering && store.recovery.asks) applyRecovery(body);
  if (recovering) body.set("cancel_url", `${origin}/@${store.handle}/left?cart=${asPut.map((p) => encodeURIComponent(p.id)).join(",")}`);
  let asking = recovering && store.recovery.asks;
  let named = isHouseStore(store);
  if (named) body.set(DISPLAY_NAME, store.name);
  let documents = store.tax.ids || store.tax.invoices;
  // The yes, written last before the order is admitted and refused rather than dropped when Stripe has no room for it (lib/digital-consent.ts).
  if (digital && extras.digitalConsent) {
    keepConsentOn(body, extras.digitalConsent, "digital", 1);
    body.set(`payment_intent_data[metadata][${CONSENT_META}]`, consentMetaValue(extras.digitalConsent, "digital"));
  }
  // A cart is one order, admitted before Stripe's page opens (lib/order-admission.ts).
  const admitted = await admitOrders(store, 1, Date.now(), itemsHandedOver(products));
  if (!admitted.ok) throw new OrdersPausedError(admitted.reason);
  if (admitted.hour !== null) body.set(`metadata[${ADMITTED_FIELD}]`, String(admitted.hour));

  for (;;) {
    try {
      // A held unit's shorter time wins over a reminder's hour, as on one product's checkout (lib/store-checkout.ts).
      if (extras.held) body.set("expires_at", String(checkoutClosesAt()));
      else if (extras.remind && !body.has("expires_at")) body.set("expires_at", String(Math.floor(Date.now() / 1000) + RECOVERY_OPEN_SECONDS));
      const session = await onAccount("POST", store.stripeAccountId, "/checkout/sessions", body);
      if (typeof session.url !== "string" || !session.url || typeof session.id !== "string") throw new Error("Stripe did not return a checkout URL");
      return { url: session.url, id: session.id };
    } catch (error) {
      if (named && error instanceof StripeError && error.status === 400) {
        body.delete(DISPLAY_NAME);
        named = false;
        continue;
      }
      if (body.has("discounts[0][promotion_code]") && error instanceof StripeError && error.status === 400 && /promotion|coupon|discount/i.test(error.message)) {
        // The code from the link is real but not for this cart (a minimum, a
        // first order only, other products): the buyer is not turned away for
        // it, and the checkout opens with the box, as it would have.
        console.error("a code from a link did not fit this cart; opened with the box instead", error);
        body.delete("discounts[0][promotion_code]");
        body.delete("metadata[code]");
        body.set("allow_promotion_codes", "true");
        continue;
      }
      if (asking && refusedRecovery(error)) {
        // Stripe decides which accounts it asks for consent for: refused, the cart still sells.
        console.error("cart checkout refused the reminder fields; opened without them", error);
        withoutRecovery(body);
        asking = false;
        continue;
      }
      if (documents && refusedTaxDocuments(error)) {
        withoutTaxDocuments(body);
        documents = false;
        continue;
      }
      throw error;
    }
  }
}
