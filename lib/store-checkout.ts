/**
 * Selling, on the creator's own Stripe account.
 *
 * Every charge here is a direct charge on the connected account, with no
 * application fee. That is not a detail: it is what makes the money the
 * creator's from the first second, puts their name on the buyer's statement,
 * and leaves Marktmorgen with nothing to hold, skim or lose. The 0% on the home
 * page is this file.
 */
import { randomBytes } from "node:crypto";
import { prepareOrderConfirmationPreintent } from "@/lib/orders";
import { CURRENT_SHIPMENT_MAIL_LIFECYCLE } from "@/lib/shipment-record";
import { confirmationBodyDigest, openConfirmationOrigin, reserveConfirmationOrigin, type ConfirmationOriginRuntime } from "@/lib/order-confirmation-outbox";
import { itemsHandedOver } from "@/lib/store-data-rules";
import { ADMITTED_FIELD, OrdersPausedError, admitOrders } from "@/lib/order-admission";
import { firstCharge } from "@/lib/move-rules";
import { currentMeta } from "@/lib/tier-rules";
import { saleOff } from "@/lib/store-sale";
import { fairOff } from "@/lib/fair-price";
import { fairCoupon } from "@/lib/fair-coupon";
import { introCoupon } from "@/lib/intro-coupon";
import { activeIntro } from "@/lib/intro-price";
import { activeYearly } from "@/lib/yearly-price";
import { activeShipping } from "@/lib/shipping";
import { type ShipAddress, shippingAddressOf, wasShipped } from "@/lib/shipping-address";
import { type Shipped, readShipped } from "@/lib/shipments";
import { shippingWords } from "@/lib/buyer-words/shipping";
import { GIFT_ID } from "@/lib/gift-rules";
import { GROUP_ID, canGroup, payable, peopleWords } from "@/lib/group-rules";
import { commissionRate } from "@/lib/affiliate-setting";
import { saleHandles } from "@/lib/store";
import type { Listing, Product, Store } from "@/lib/store";
import { readListing, readListings } from "@/lib/catalog";
import type { ProductFile } from "@/lib/product-file";
import {
  type ProductOption,
  handsOver,
  lowestPriceCents,
  sellableOptions,
} from "@/lib/product-option";

// Read here for years; it now lives beside the option rules, so the studio can read it too.
export { sellableOptions };
import { isPaidUp } from "@/lib/billing";
import { codesMayTakeOff, livePromotionId } from "@/lib/discount";
import { StripeError, checkoutClosesAt, onAccount, platformKey } from "@/lib/stripe-account";
import { type Bump, MAX_BUMPS, activeBumps, bumpTargets, planFor } from "@/lib/product-extras";
import { planLine } from "@/lib/buyer-words";
import { LANGUAGES } from "@/lib/store-language";
import { type CameFrom, hasSource } from "@/lib/came-from";
import { applyTax, applyTaxDocuments, refusedTaxDocuments, withoutTaxDocuments } from "@/lib/tax";
import { inTheCurrencyShown, isSettled, onlyInstantMethods, reusableMethod, saveCardForOffers } from "@/lib/instant-pay";
import { activePwyw, pwywPriceId } from "@/lib/pay-what-you-want";
import { type Answer, applyCheckoutFields, readAnswers } from "@/lib/checkout-fields";
import { imageUrl } from "@/lib/product-image";
import { readMoves } from "@/lib/call-records";
import { RECOVERY_OPEN_SECONDS, applyRecovery, recoveryOn, refusedRecovery, withoutRecovery } from "@/lib/recovery-setting";
import { isLive, membershipStatus, soldAMembership } from "@/lib/membership-access";
import { purchaseRefunded } from "@/lib/refunds";
import { BUMP_KEYS, type BumpKey, MIN_BUNDLE_ITEMS, bumpsFromMeta, bundleFromMeta, bundleMeta, chosenItems, deliverableItems, picks } from "@/lib/bundle-rules";
import { type BundleContents, contentsOf } from "@/lib/bundles";
import { isHouseStore } from "@/lib/house-store";
import { DEMO_CONNECTED_ACCOUNT } from "@/lib/demo-account";
import { preorderProblem } from "@/lib/preorder-rules";
import { type MayComeOff, applyShare, leastPaid, linesTotal, shareBps } from "@/lib/platform-share";
import { CONSENT_META, type DigitalConsent, consentKind, consentMetaValue, deliversDigitally, keepConsentOn, requireDigitalConsent } from "@/lib/digital-consent";

/**
 * How long a paid link keeps working.
 *
 * The session id in that link is what opens the download, so it is a key, and
 * a key that never expires is a file quietly published. Three days is long
 * enough for a buyer who checks mail on Monday and short enough that a link
 * forwarded once does not become a permanent leak.
 */
export const DOWNLOAD_WINDOW_SECONDS = 3 * 24 * 60 * 60;

const SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

/** The name printed at the top of Stripe's page (Stripe API 2025-09-30.clover and later). */
const DISPLAY_NAME = "branding_settings[display_name]";

// Keep newly created memberships/plans on the classic semantics used by our
// renewal changes, independently of the platform account default. CX-47.
const SUBSCRIPTION_CHECKOUT_VERSION = "2025-09-30.clover";

export function isSellingConfigured(): boolean {
  return platformKey() !== null;
}

/**
 * Whether this store can actually take money right now.
 *
 * Both halves matter. A connected account that Stripe has not cleared cannot
 * charge, and saying otherwise on the store page would take a buyer's time for
 * nothing.
 */
export function canSell(store: Store): boolean {
  return (
    isSellingConfigured() &&
    Boolean(store.stripeAccountId) &&
    store.stripeChargesEnabled &&
    // The third condition is how this company stays alive. Everything else
    // here is free — the address, the page, the editor, connecting Stripe —
    // and what the subscription buys is the till. A creator inside the trial
    // passes this too, because a trial that cannot sell proves nothing.
    isPaidUp(store) &&
    // Switched off after notices about its content (lib/takedown.ts): no new sale until it is back.
    !store.suspended
  );
}

/**
 * A product can only be sold once there is something to hand over.
 *
 * Either kind counts: a file we host, or a link to wherever the creator keeps
 * it. What is refused is a product with neither, because a buyer would pay and
 * then be shown nothing.
 *
 * With price options the same question is asked of them instead of the
 * product: at least one has to be ready, because that is what the buyer picks.
 */
export function canSellProduct(store: Store, product: Listing): boolean {
  // Something free is never sold. It has its own door, and a checkout for
  // nothing would be a card form that cannot work.
  if (product.priceCents === 0) return false;
  // A draft is not on sale until the creator publishes it.
  if (product.hidden) return false;
  if (!canSell(store)) return false;
  // What it hands over is read from the product alone (lib/product-option.ts,
  // handsOver), which the studio also reads to say what removing a price does.
  return handsOver(product);
}

/** The figure a product card leads with: the cheapest way in. */
export function fromPriceCents(product: Listing): number {
  return lowestPriceCents(sellableOptions(product), product.priceCents);
}

/**
 * Opens a checkout for one product and returns where to send the buyer.
 *
 * When the product has price options, the buyer's form sends an option id and
 * nothing else about money. The amount charged is read from the option the
 * creator saved, found here, on the server. A page that accepted a price from
 * the form would be a page where anything can be bought for a cent, and that
 * is the single rule this whole feature rests on.
 */
export async function createCheckout(
  store: Store,
  product: Product,
  origin: string,
  optionId?: string,
  extras: {
    /**
     * Which boxes the buyer checked, by the product each offers. "yes" is
     * the first box, as a page drawn when a product had one box sends it.
     * What each costs is read from the product, never from here.
     */
    bumps?: string[];
    /** A unit of the product is held, so the checkout has to close in time. */
    held?: boolean;
    /** For a bundle its buyer builds: the products they ticked (lib/bundle-rules.ts, chosenItems). */
    picked?: string[];
    /**
     * The fingerprint of the secret the buyer's browser keeps, when an upsell
     * follows: the card is then kept for payments made while they are there.
     */
    upsellKey?: string;
    /** The buyer chose to pay in the creator's payment plan. */
    plan?: boolean;
    /** A monthly membership paid yearly instead, where it offers that (lib/yearly-price.ts). */
    yearly?: boolean;
    /**
     * The utm tags on the page this checkout was opened from
     * (lib/came-from.ts). Written onto the Stripe session so the creator can
     * see which of their links the money came from, in the one record that
     * outlives ours.
     */
    cameFrom?: CameFrom;
    /**
     * The channel this sale is credited to, as Stripe metadata
     * (lib/visit-channel.ts channelMetadata): the page's own tags, else the
     * channel remembered for this visitor, else direct. Written on the session
     * and, for a membership or payment plan, on the subscription, so every
     * renewal carries it too.
     */
    channel?: Record<string, string>;
    /**
     * For a course: the fingerprint of the secret the buyer's browser keeps,
     * so the course opens right away in the browser that paid.
     */
    buyerKey?: string;
    /** The buyer ticked the box to hear from the creator. */
    news?: boolean;
    /**
     * The buyer checked the Store assistant's box for one reminder if they do
     * not finish (lib/assistant-reminder.ts): the checkout closes after an
     * hour, so the reminder can follow an hour after that.
     */
    remind?: boolean;
    /** And the second box, allowing their link use in sequences to be seen (lib/mail-clicks.ts). */
    clicks?: boolean;
    /**
     * The affiliate whose link the buyer followed, still inside the store's
     * window, and the share this product earns them (lib/affiliates.ts).
     */
    via?: { aff: string; rate: number; own?: number | null } | null;
    /**
     * A come-back offer's coupon (lib/winback.ts), applied by Stripe to this
     * checkout alone. It replaces the box for typing a code: Stripe takes one
     * or the other.
     */
    coupon?: string;
    /** The coupon is the store's welcome offer (lib/welcome-offer.ts), not a come-back one. */
    welcome?: boolean;
    /** The address the checkout opens with, fixed, for an offer made to one person. */
    email?: string;
    /**
     * The country the buyer's connection is in (lib/fair-price.ts), read by
     * the route from the request; "" when it is not known.
     */
    country?: string;
    /** No free trial: somebody coming back has had theirs. */
    noTrial?: boolean;
    /**
     * The funnel of pages this checkout was opened in (lib/page-funnel.ts),
     * so its thank-you page can lead on to the next step.
     */
    funnel?: string;
    /** The page test and version the buyer was shown (lib/headline-test.ts abMeta), so a paid sale counts for it. */
    ab?: string;
    /**
     * Bought through the checkout script on one of the creator's listed sites
     * (lib/embed-sites.ts): the address to send the buyer back to, or the
     * site itself when none was given. Checked against the list by the route.
     */
    embedSite?: string;
    /**
     * Bought for somebody else (lib/gifts.ts): paid at once, with nothing
     * added at checkout and no offer after it, and handed to the recipient.
     */
    gift?: string;
    /**
     * Bought for several people at once (lib/group-buy.ts): one payment of
     * the price times that many, with nothing added at checkout and no offer
     * after it, and one link that hands out the places.
     */
    group?: { id: string; people: number };
    /**
     * A member moving their membership from another platform (lib/move-members.ts):
     * nothing is charged until `firstChargeAt`, the day it would have renewed
     * there (null: it is due now, and charged now), and no free trial on top.
     */
    moved?: { firstChargeAt: number | null };
    /**
     * A pre-order (lib/preorders.ts): paid at once, with nothing added at
     * checkout and no offer after it, and handed over the day it comes out.
     */
    preorder?: boolean;
    /**
     * A discount code that came in a link (lib/code-link.ts). Applied only as
     * the creator's own live promotion code, by Stripe; otherwise the box to
     * type one is shown as it always is.
     */
    code?: string;
    /**
     * The buyer's yes, checked on the form before paying, to start access at
     * once and lose the right to cancel once it starts (lib/digital-consent.ts).
     * Needed whenever this order hands over anything digitally: without it,
     * nothing is opened (DigitalConsentMissing).
     */
    digitalConsent?: DigitalConsent | null;
  } = {},
  /** Internal integration dependency; never populated from HTTP or environment flags. */
  confirmationRuntime: ConfirmationOriginRuntime = {},
): Promise<{ url: string; id: string }> {
  if (!store.stripeAccountId) throw new Error("This store has no account");
  if (extras.gift) extras = { ...extras, bumps: [], plan: false, upsellKey: undefined, group: undefined };
  if (extras.preorder) {
    // Checked again here, where the charge is built: only what can be handed over later as one thing.
    if (preorderProblem(product) !== null) throw new Error("This cannot be pre-ordered");
    extras = { ...extras, bumps: [], plan: false, upsellKey: undefined, group: undefined, gift: undefined, buyerKey: undefined };
  }
  if (extras.group) {
    // Checked again here, where the charge is built: the number of people
    // multiplies the price, so nothing reaches Stripe that the rules refuse.
    if (!GROUP_ID.test(extras.group.id) || !canGroup(product)) throw new Error("This cannot be bought for several people");
    extras = { ...extras, bumps: [], plan: false, upsellKey: undefined, buyerKey: undefined };
  }
  // A call is booked for a time, through its own door, never bought blind.
  if (product.call) throw new Error("A call is booked, not bought directly");
  // A physical product is shipped to the buyer who pays for it: not as a gift or for a group (lib/shipping.ts).
  const shipping = activeShipping(product);
  if (shipping && (extras.gift || extras.group)) throw new Error("This is shipped to the buyer who pays for it");

  // A bundle's list is read now and written onto the checkout, so what this
  // buyer gets is what it held when they paid, whatever it holds later.
  const pool = product.bundle ? deliverableItems(product, await readListings(store, product.bundle)) : null;
  if (pool && pool.length < MIN_BUNDLE_ITEMS) throw new Error("This bundle holds too little that can be handed over right now");
  // A bundle its buyer builds: exactly the ones they chose, from what it can
  // hand over now (lib/bundle-rules.ts). Anything else is refused, not guessed.
  const pick = picks(product);
  const bundled = pool && pick ? chosenItems(pool, extras.picked ?? [], pick) : pool;
  if (pool && !bundled) throw new Error("This bundle needs its buyer's choice");

  const offered = sellableOptions(product);
  let chosen: ProductOption | null = null;
  if (offered.length > 0) {
    chosen = offered.find((option) => option.id === optionId) ?? null;
    // No id, or one that names nothing this product offers. Refusing beats
    // guessing: a buyer charged for the option they did not pick is a refund.
    if (!chosen) throw new Error("This product needs one of its options");
  }

  const membership = product.recurring;
  // Paying in instalments is a subscription that ends by itself; paying at
  // once is a single payment. The amount of each is the creator's, read here.
  // On a product with several prices, the payments are those of the price picked.
  const plan = extras.plan && !membership ? planFor(product, chosen?.id ?? null) : null;
  if (extras.plan && !membership && !plan) throw new Error("This price cannot be paid in a plan");
  const recurring = membership !== null || plan !== null;
  const priceCents = plan ? plan.amountCents : chosen ? chosen.priceCents : product.priceCents;
  const baseName = chosen ? `${product.title} (${chosen.label})` : product.title;
  const name = plan
    ? `${baseName} (${planLine(store, plan)})`
    : pick && bundled
      ? `${baseName}: ${bundled.map((p) => p.title).join(", ")}`.slice(0, 250)
      : baseName;
  // Bought for several: the same price, that many times, on one line.
  const people = extras.group ? extras.group.people : 1;
  if (extras.group && !payable(priceCents, people)) throw new Error("This cannot be bought for several people");
  // The buyer names the amount on Stripe's page, from the creator's floor up.
  // Only a single one-off line can carry that, which activePwyw has checked.
  const pwyw = !chosen && !plan && !membership ? activePwyw(product) : null;

  const body = new URLSearchParams({
    mode: recurring ? "subscription" : "payment",
    // In the store's language, like every other page a buyer meets here
    // (lib/store-language.ts), rather than whatever Stripe guesses from the browser.
    locale: LANGUAGES[store.language].stripe,
    "line_items[0][quantity]": String(people),
    // The store's own currency (lib/money.ts): every amount saved in it is in
    // that currency's smallest unit, which is what Stripe counts in.
    "line_items[0][price_data][currency]": store.currency,
    "line_items[0][price_data][unit_amount]": String(priceCents),
    "line_items[0][price_data][product_data][name]": name,
    "metadata[store]": store.handle,
    "metadata[product]": product.id,
    // Kept on the charge itself so the order still says what was sold after
    // the creator renames or removes the product. Stripe's record outlives
    // ours, and the creator should not lose the history by tidying the store.
    "metadata[title]": (extras.group ? `${name} (for ${peopleWords(people)})` : name).slice(0, 480),
    success_url: `${origin}/@${store.handle}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/@${store.handle}`,
  });

  if (recurring) body.set("subscription_data[billing_mode][type]", "classic");

  // Which option was bought decides which file is handed over later, so it
  // travels with the charge rather than being worked out again afterward.
  if (chosen) body.set("metadata[option]", chosen.id);
  // Which of the creator's own links this sale came from. Only written when
  // there is something to write, so an untagged sale carries no empty field.
  if (extras.cameFrom && hasSource(extras.cameFrom)) {
    if (extras.cameFrom.source) body.set("metadata[utm_source]", extras.cameFrom.source);
    if (extras.cameFrom.medium) body.set("metadata[utm_medium]", extras.cameFrom.medium);
    if (extras.cameFrom.campaign) body.set("metadata[utm_campaign]", extras.cameFrom.campaign);
    if (extras.cameFrom.content) body.set("metadata[utm_content]", extras.cameFrom.content);
    if (recurring) {
      for (const [key, value] of Object.entries(extras.cameFrom)) {
        if (value) body.set(`subscription_data[metadata][utm_${key}]`, value);
      }
    }
  }
  for (const [key, value] of Object.entries(extras.channel ?? {})) {
    body.set(`metadata[${key}]`, value);
    if (recurring) body.set(`subscription_data[metadata][${key}]`, value);
  }
  if (bundled) {
    for (const [key, value] of Object.entries(bundleMeta("bundle", bundled.map((p) => p.id)))) body.set(`metadata[${key}]`, value);
  }

  // Shipped by the creator (lib/shipping.ts): Stripe asks for an address in a
  // country it goes to, and adds the shipping as its own line before paying.
  if (shipping) {
    const sw = shippingWords(store.language);
    shipping.countries.forEach((code, i) => body.set(`shipping_address_collection[allowed_countries][${i}]`, code));
    const rate = "shipping_options[0][shipping_rate_data]";
    body.set(`${rate}[type]`, "fixed_amount");
    body.set(`${rate}[fixed_amount][amount]`, String(shipping.cents));
    body.set(`${rate}[fixed_amount][currency]`, store.currency);
    body.set(`${rate}[display_name]`, [shipping.cents > 0 ? sw.rate : sw.freeRate, shipping.note].filter(Boolean).join(" · ").slice(0, 100));
    // Stripe Tax: shipping taxed as shipping, and the product as goods rather than the account's default.
    if (store.tax.enabled) {
      body.set(`${rate}[tax_behavior]`, store.tax.included ? "inclusive" : "exclusive");
      body.set(`${rate}[tax_code]`, "txcd_92010001");
      body.set("line_items[0][price_data][product_data][tax_code]", "txcd_99999999");
    }
    body.set("metadata[ship]", "yes");
    body.set("payment_intent_data[metadata][ship]", "yes");
  }

  // Stripe's page shows the product's picture beside its name, when there is
  // one and it can be fetched from a public https address.
  if (product.image && origin.startsWith("https://")) {
    body.set("line_items[0][price_data][product_data][images][0]", `${origin}${imageUrl(product.image)}`);
  }

  // The products the buyer chose to add, each at the price the creator set
  // for it here — read from the store's record, never from the form. Only a
  // box being shown right now can be checked; anything else the form names
  // is ignored.
  const checked = new Set((extras.bumps ?? []).slice(0, MAX_BUMPS + 1));
  const shown = checked.size && !membership && !pwyw && product.bumps.length ? activeBumps(await readListings(store, bumpTargets(product)), product) : [];
  if (checked.has("yes") && shown[0]) checked.add(shown[0].target.id);
  const added: { key: BumpKey; bump: Bump; target: Listing }[] = [];
  for (const offer of shown) {
    if (!checked.has(offer.target.id)) continue;
    // A bundle ticked at checkout: its list is written down the same way.
    // One that holds too little right now is left off, as a box that cannot
    // be handed over always is (lib/product-extras.ts).
    const bundled = offer.target.bundle ? deliverableItems(offer.target, await readListings(store, offer.target.bundle)) : null;
    if (bundled && bundled.length < MIN_BUNDLE_ITEMS) continue;
    const key = BUMP_KEYS[added.length];
    const line = added.length + 1;
    if (bundled) {
      for (const [name, value] of Object.entries(bundleMeta(`${key}_bundle`, bundled.map((p) => p.id)))) body.set(`metadata[${name}]`, value);
    }
    body.set(`line_items[${line}][quantity]`, "1");
    body.set(`line_items[${line}][price_data][currency]`, store.currency);
    body.set(`line_items[${line}][price_data][unit_amount]`, String(offer.bump.priceCents));
    body.set(`line_items[${line}][price_data][product_data][name]`, offer.target.title);
    body.set(`metadata[${key}]`, offer.target.id);
    // What it was charged, on every order and not only one that came through
    // an affiliate's link: a sale credited later from a code typed at
    // checkout, or from a buyer kept with an affiliate, weighs each product's
    // own share by it too (lib/affiliates.ts, noteSession), so a product the
    // creator left out of the programme never earns the front product's rate.
    body.set(`metadata[${key}_cents]`, String(offer.bump.priceCents));
    if (!recurring) body.set(`payment_intent_data[metadata][${key}]`, offer.target.id);
    added.push({ key, bump: offer.bump, target: offer.target });
  }
  if (added.length) body.set("metadata[title]", [name, ...added.map((a) => a.target.title)].join(" + ").slice(0, 480));

  // Digital content or a membership (lib/digital-consent.ts): refused here,
  // before an order is admitted or anything reaches Stripe, unless the buyer
  // checked the box; kept on the order below, once every other field is
  // written, so it is counted against Stripe's 50.
  const digital = deliversDigitally(product, chosen?.id ?? null) || added.some((offer) => deliversDigitally(offer.target));
  requireDigitalConsent(digital, extras.digitalConsent);
  const kind = consentKind(product);

  // A limited product's unit is held while this checkout is open, so the
  // checkout closes before the hold does. The time is set just before the
  // checkout is made, below, because Stripe counts its minimum from then.

  // An upsell follows: the buyer becomes a customer of the creator and a
  // card is kept for payments they make while present — the one-click offer
  // on the thanks page — and never for charging them when they are not. Only
  // a card is asked to be kept, so every other way to pay stays on offer; a
  // buyer who pays another way meets no offer (lib/instant-pay.ts).
  if (extras.upsellKey && !recurring) {
    body.set("customer_creation", "always");
    saveCardForOffers(body);
    body.set("metadata[upsell_key]", extras.upsellKey);
  }

  // The box a buyer types a discount code into, shown only by a store that has
  // one. An empty box on every checkout is an invitation to go and look for a
  // code that does not exist, and a buyer who leaves to search for one is a
  // buyer who may not come back. What a code takes off is worked out by Stripe
  // from a coupon on the creator's own account; no amount is decided here.
  // Not where the buyer chooses the price: they already name the amount.
  // A sale across the store (lib/store-sale.ts): taken off by Stripe with the
  // creator's own coupon, with no code to type, while it runs. Not on a
  // payment plan: the page says the sale price is for paying in full.
  const saleOffNow = !extras.coupon && !plan ? saleOff(store.sale, product, Math.floor(Date.now() / 1000)) : 0;
  // A fair price for the buyer's country (lib/fair-price.ts): the same rule
  // the page used to show the price, and taken off the same way as a sale,
  // when it takes off more than the sale does. Never both.
  const fairOffNow = !extras.coupon && !plan && !membership ? fairOff(store.fair, product, extras.country ?? "") : 0;
  // A membership's introductory price (lib/intro-price.ts), unless a
  // come-back offer replaces it: one discount at a time, as everywhere here.
  const intro = membership && !extras.coupon ? activeIntro(product, store.tiers) : null;
  // What may come off this checkout, for the share of the sale
  // (lib/platform-share.ts): the fee set below is the share of the least the
  // buyer can pay, and whatever is above what they did pay is given back.
  const mayComeOff: MayComeOff[] = [];
  if (extras.coupon && !pwyw && extras.welcome) {
    // A welcome offer with a deadline of the person's own (lib/welcome-offer.ts).
    body.set("discounts[0][coupon]", extras.coupon);
    body.set("metadata[welcome]", "yes");
    if (recurring) body.set("subscription_data[metadata][discount]", "welcome");
    mayComeOff.push(extras.coupon === store.welcomeOffer.coupon ? { kind: "percent", percent: store.welcomeOffer.percent } : { kind: "unknown" });
  } else if (extras.coupon && !pwyw) {
    body.set("discounts[0][coupon]", extras.coupon);
    body.set("metadata[winback]", "yes");
    mayComeOff.push(extras.coupon === store.winback.coupon ? { kind: "percent", percent: store.winback.percent } : { kind: "unknown" });
  } else if (intro) {
    body.set("discounts[0][coupon]", await introCoupon(store.stripeAccountId, store.currency, product.priceCents - intro.cents, intro.count));
    // What the order says it was: the thanks page and the email read these (lib/purchase-email.ts).
    body.set("metadata[intro]", String(intro.count));
    body.set("metadata[intro_cents]", String(intro.cents));
    body.set("metadata[regular_cents]", String(product.priceCents));
    body.set("subscription_data[metadata][intro]", String(intro.count));
  } else if (fairOffNow > saleOffNow) {
    body.set("discounts[0][coupon]", await fairCoupon(store.stripeAccountId, fairOffNow));
    body.set("metadata[fair]", `${extras.country}:${fairOffNow}`);
    mayComeOff.push({ kind: "percent", percent: fairOffNow });
  } else if (saleOffNow > 0) {
    body.set("discounts[0][coupon]", store.sale.coupon);
    body.set("metadata[sale]", String(saleOffNow));
    // How a membership began, for who stays (lib/discount-impact.ts, entryOf).
    if (recurring) body.set("subscription_data[metadata][discount]", "sale");
    mayComeOff.push({ kind: "percent", percent: saleOffNow });
  } else if (store.hasDiscounts && !pwyw) {
    // A code from a link, or one typed in Stripe's box: either may be the
    // largest the store has.
    if (!recurring && shareBps(store) > 0) mayComeOff.push(...(await codesMayTakeOff(store.stripeAccountId, store.currency)));
    // A code from a link goes on by itself; Stripe takes either an applied
    // discount or the box, never both, so it is one or the other.
    const promotion = extras.code ? await livePromotionId(store.stripeAccountId, extras.code) : null;
    if (promotion) {
      body.set("discounts[0][promotion_code]", promotion);
      body.set("metadata[code]", extras.code as string);
      if (recurring) body.set("subscription_data[metadata][discount]", "code");
    } else {
      body.set("allow_promotion_codes", "true");
    }
  }
  if (extras.email) body.set("customer_email", extras.email);

  if (extras.gift) {
    body.set("metadata[gift]", extras.gift);
    if (!recurring) body.set("payment_intent_data[metadata][gift]", extras.gift);
  }
  if (extras.group) {
    body.set("metadata[group]", extras.group.id);
    body.set("metadata[people]", String(people));
    body.set("payment_intent_data[metadata][group]", extras.group.id);
  }
  if (extras.preorder) {
    body.set("metadata[preorder]", "yes");
    body.set("payment_intent_data[metadata][preorder]", "yes");
  }
  if (extras.buyerKey && !extras.gift) body.set("metadata[buyer_key]", extras.buyerKey);
  if (extras.funnel && !extras.gift && !extras.group) body.set("metadata[funnel]", extras.funnel);
  if (extras.ab && /^[a-z0-9]{4,12}:(a|b)$/.test(extras.ab)) body.set("metadata[ab]", extras.ab);
  if (extras.news) body.set("metadata[news]", "yes");
  if (extras.news && extras.clicks) body.set("metadata[clicks]", "yes");

  // Sent by an affiliate: who, and the share as it is today, kept with the
  // charge so a later change of terms never changes what this sale earned.
  // A membership or a payment plan is credited below, on its subscription.
  //
  // The order is what earns, not the front product. A bump that made it into
  // the charge is here by now, so this is the first point at which the whole
  // of what is being bought is known — and so the right place to ask whether
  // any of it earns a share. A creator who pays nothing on the front offer
  // and 30% on the add-on has an ordinary arrangement, and the credit used to
  // be thrown away on the front product's 0% before the bump was ever looked
  // at.
  // The affiliate's own share, when the creator set one for them, applies to the add-ons too.
  const addedRates = added.map((a) => commissionRate(store.affiliates, a.target.id, extras.via?.own ?? null));
  if (extras.via && !recurring && (extras.via.rate > 0 || addedRates.some((rate) => rate > 0))) {
    body.set("metadata[via]", extras.via.aff);
    body.set("metadata[via_rate]", String(extras.via.rate));
    body.set("payment_intent_data[metadata][via]", extras.via.aff);
    // Each box rides in the same order: its own share, which may be none, is
    // kept beside it, so it earns what the creator set for that product.
    added.forEach((a, at) => body.set(`metadata[${a.key}_rate]`, String(addedRates[at])));
  }

  // A membership or a payment plan, where the creator credits them
  // (lib/affiliate-setting.ts, recurring): the affiliate, the share and how
  // many months it lasts ride on the subscription, so each of its invoices
  // can be credited as it is paid, on the terms of the day it was sold.
  if (extras.via && recurring && store.affiliates.recurring > 0 && extras.via.rate > 0) {
    body.set("metadata[via]", extras.via.aff);
    body.set("metadata[via_rate]", String(extras.via.rate));
    body.set("subscription_data[metadata][via]", extras.via.aff);
    body.set("subscription_data[metadata][via_rate]", String(extras.via.rate));
    body.set("subscription_data[metadata][via_months]", String(store.affiliates.recurring));
    body.set("subscription_data[metadata][via_at]", String(Math.floor(Date.now() / 1000)));
  }

  if (membership) {
    // The subscription is created on the creator's own account, like every
    // other charge here, so the member is their customer and not ours.
    body.set("line_items[0][price_data][recurring][interval]", membership.interval);
    // Paid yearly, where the creator offers it: the year's price, once a year (lib/yearly-price.ts).
    const yearlyNow = extras.yearly ? activeYearly(product, store.tiers) : null;
    if (yearlyNow) {
      body.set("line_items[0][price_data][unit_amount]", String(yearlyNow.cents));
      body.set("line_items[0][price_data][recurring][interval]", "year");
      body.set("metadata[every]", "year");
      body.set("subscription_data[metadata][every]", "year");
    }
    body.set("subscription_data[metadata][store]", store.handle);
    body.set("subscription_data[metadata][product]", product.id);
    if (chosen) body.set("subscription_data[metadata][option]", chosen.id);
    if (extras.coupon && !extras.welcome) body.set("subscription_data[metadata][winback]", "yes");
    // A member moving from another platform has paid there up to the day
    // it would renew: the card is taken now and first charged on that day.
    if (extras.moved) {
      body.set("metadata[moved]", "yes");
      body.set("subscription_data[metadata][moved]", "yes");
      if (extras.moved.firstChargeAt) {
        body.set("subscription_data[trial_end]", String(extras.moved.firstChargeAt));
        body.set("metadata[first_charge]", String(extras.moved.firstChargeAt));
      }
    }
    // Days free before the first payment. The card is taken now, as the store
    // page says, and nothing is charged until the trial is over.
    else if (membership.trialDays > 0 && !extras.noTrial) {
      body.set("subscription_data[trial_period_days]", String(membership.trialDays));
      body.set("metadata[trial_days]", String(membership.trialDays));
    }
    // A membership that ends by itself after so many payments is given its
    // end once it has begun, exactly as a payment plan is (lib/plans.ts).
    if (membership.payments > 0) {
      body.set("metadata[ends_after]", String(membership.payments));
      body.set("metadata[ends_interval]", membership.interval);
      body.set("subscription_data[metadata][ends_after]", String(membership.payments));
      body.set("subscription_data[metadata][ends_interval]", membership.interval);
    }
  } else if (plan) {
    // Charged on the creator's account like everything else, and given its
    // end as soon as the first payment is through (lib/plans.ts).
    body.set("line_items[0][price_data][recurring][interval]", plan.interval);
    body.set("metadata[kind]", "plan");
    body.set("metadata[plan_payments]", String(plan.payments));
    body.set("metadata[plan_interval]", plan.interval);
    body.set("subscription_data[metadata][store]", store.handle);
    body.set("subscription_data[metadata][product]", product.id);
    body.set("subscription_data[metadata][kind]", "plan");
    body.set("subscription_data[metadata][plan_payments]", String(plan.payments));
    body.set("subscription_data[metadata][plan_interval]", plan.interval);
    body.set("subscription_data[description]", `${baseName}: ${planLine(store, plan)}`.slice(0, 500));
    if (chosen) body.set("subscription_data[metadata][option]", chosen.id);
  } else {
    body.set("payment_intent_data[metadata][store]", store.handle);
    body.set("payment_intent_data[metadata][product]", product.id);
    if (chosen) body.set("payment_intent_data[metadata][option]", chosen.id);
  }

  if (product.summary) {
    body.set("line_items[0][price_data][product_data][description]", product.summary);
  }

  // The creator's questions, answered on Stripe's page before paying.
  applyCheckoutFields(body, product.fields);

  // Sales tax, when the creator has switched it on: worked out by Stripe Tax
  // from the buyer's address, on the creator's account, for every line.
  applyTax(store, body);
  // And the two documents a business buyer needs, where the creator switched
  // them on: the box for their own tax number, and an invoice drawn up by
  // Stripe on the creator's account (lib/tax.ts).
  applyTaxDocuments(store, body, recurring);
  onlyInstantMethods(body);
  inTheCurrencyShown(body);
  // A store with reminders on: Stripe asks the buyer whether they want to
  // hear from the creator, and keeps their answer and their address if they
  // leave without paying (lib/checkout-recovery.ts). Set before the closing
  // time below, so a held unit's shorter time still wins.
  const recovering = recoveryOn(store);
  // Stripe's own box only where Stripe offers it (a US account). Asking for
  // it anywhere else is a checkout refused and opened again without it.
  if (recovering && store.recovery.asks) applyRecovery(body);
  // And the way back from the checkout leads to a page that says nothing was
  // charged and offers one reminder, which the buyer asks for themselves
  // (lib/checkout-ask.ts). Not for a call: its checkout holds a time.
  if (recovering && !product.call) {
    body.set("cancel_url", `${origin}/@${store.handle}/left?p=${encodeURIComponent(product.id)}`);
  }

  // The demo store's account is a test account whose own name cannot be
  // changed — neither we nor its dashboard may rename it — so its checkout
  // carries the store's name itself, where Stripe would otherwise print the
  // account's (lib/house-store.ts). Every other store's checkout is named by
  // its creator's own Stripe account, which is theirs to name.
  let named = isHouseStore(store);
  if (named) body.set(DISPLAY_NAME, store.name);

  // The share of the sale, when the store's plan has one. A choose-your-price
  // line is still at its floor here, which is the least it can be.
  applyShare(body, store, { recurring, least: leastPaid(linesTotal(body).cents, mayComeOff) });

  // The yes, with its version, its kind and its time, written last before the
  // order is admitted, with a field held back for the admitted mark: refused
  // rather than dropped when Stripe's fields have no room for it
  // (DigitalConsentNoRoom). On the payment too, or the membership, so the
  // record a dispute reads carries it.
  if (digital && extras.digitalConsent) {
    keepConsentOn(body, extras.digitalConsent, kind, 1);
    if (!recurring) body.set(`payment_intent_data[metadata][${CONSENT_META}]`, consentMetaValue(extras.digitalConsent, kind));
    else body.set(`subscription_data[metadata][${CONSENT_META}]`, consentMetaValue(extras.digitalConsent, kind));
  }

  // This ordinary origin has no verified original-file access recipe yet.
  // Funding alone cannot authorize taking payment. In particular, never_activated
  // must not route these new purchases through the legacy unprotected POST.
  // Its protected reservation/reconciliation adapter is constructed separately;
  // dispatch and hosted payment creation stay closed until rights are proved.
  const singleDigital = Boolean(store.stripeAccountId !== DEMO_CONNECTED_ACCOUNT && product.file && !product.link && !shipping &&
    product.priceCents > 0 && !product.bundle && !product.course && !product.podcast && !product.keys && !product.note &&
    !product.callPackage && !product.recurring && !product.plan && !product.pwyw && product.options.length === 0 &&
    product.fields.length === 0 && added.length === 0 && !extras.gift && !extras.group && !extras.preorder && !extras.email &&
    !extras.buyerKey && !extras.upsellKey && !extras.news && !extras.held && !extras.remind && !recovering && !named &&
    !store.tax.ids && !store.tax.invoices && !store.domain?.liveAt && !(store.affiliates.enabled && store.affiliates.buyers) &&
    !body.has("discounts[0][promotion_code]") && !body.has("discounts[0][coupon]"));
  if (singleDigital) throw new Error("The payment page could not be opened");

  // A paid store's new orders stop at its plan's figure (lib/order-admission.ts):
  // admitted here, before Stripe's page opens, so nobody is stopped while paying.
  // A purchase for several people holds its places too.
  const admitted = await admitOrders(store, 1 + (extras.group ? extras.group.people : 0), Date.now(), itemsHandedOver([product, ...added.map((offer) => offer.target)]));
  if (!admitted.ok) throw new OrdersPausedError(admitted.reason);
  if (admitted.hour !== null) body.set(`metadata[${ADMITTED_FIELD}]`, String(admitted.hour));

  // Where the receipt page sends the buyer back to, and the sale.completed
  // webhook's source: written last, and only while Stripe's fifty metadata
  // fields have room (one is kept for choose-your-price, below), so it can
  // never be what stops a sale.
  if (extras.embedSite && /^https:\/\//.test(extras.embedSite) && [...body.keys()].filter((key) => key.startsWith("metadata[")).length < 49) {
    body.set("metadata[embed_site]", extras.embedSite.slice(0, 300));
  }

  // First durable category: a single physical item without expiring access,
  // mutable checkout variants or coupled fulfillment. Other producers remain
  // explicit follow-up work; none are silently relabeled as durable here.
  const simplePhysical = Boolean(store.stripeAccountId !== DEMO_CONNECTED_ACCOUNT && (confirmationRuntime.lifecycle ?? CURRENT_SHIPMENT_MAIL_LIFECYCLE) !== "never_activated" && shipping && !product.bundle && !product.course && !product.podcast && !product.keys && !product.note &&
    !product.callPackage && !product.recurring && !product.plan && !product.pwyw && !product.file && !product.link && product.options.length === 0 &&
    product.fields.length === 0 && added.length === 0 && !extras.gift && !extras.group && !extras.preorder && !extras.email && !extras.buyerKey &&
    !extras.upsellKey && !extras.news && !extras.held && !extras.remind && !recovering && !named && !store.tax.ids && !store.tax.invoices &&
    !store.domain?.liveAt && !(store.affiliates.enabled && store.affiliates.buyers) && !body.has("discounts[0][promotion_code]") && !body.has("discounts[0][coupon]"));
  if (simplePhysical) {
    if ([...body.keys()].filter(key => key.startsWith("metadata[")).length > 47) throw new Error("The payment page could not be opened");
    const nonce = randomBytes(32).toString("hex");
    body.set("metadata[mm_order_intent]", nonce);
    body.set("metadata[mm_order_origin]", "physical-v1");
    const bodyDigest = confirmationBodyDigest(body.toString());
    body.set("metadata[mm_order_hash]", bodyDigest);
    const accountId = store.stripeAccountId;
    const preintent = await prepareOrderConfirmationPreintent(store, admitted, { nonce, accountId, bodyDigest }, { now: confirmationRuntime.now });
    if (!preintent) throw new Error("The payment page could not be opened");
    const reserved = await reserveConfirmationOrigin({ statsId: store.statsId, nonce, accountId, body: body.toString(), preintent,
      snapshot: { store: { handle: store.handle, name: store.name, email: store.email, sid: store.sid, extra: store.extra,
        previousHandles: [...store.previousHandles], releasedHandles: [...store.releasedHandles], stripeAccountId: accountId,
        statsId: store.statsId, currency: store.currency, language: store.language, domain: null,
        affiliates: { enabled: false, buyers: false }, tax: { enabled: store.tax.enabled, included: store.tax.included } },
        product: { id: product.id, title: product.title, priceCents: product.priceCents, options: [], call: null,
          recurring: null, course: null, podcast: null, shipping: product.shipping, bundle: null, note: false, keys: null } },
    }, confirmationRuntime);
    if (!reserved.ok) throw new Error("The payment page could not be opened");
    const ready = await openConfirmationOrigin(reserved.id, confirmationRuntime);
    if (!ready) throw new Error("The payment page could not be confirmed");
    return ready;
  }

  const open = async (fresh: boolean) => {
    if (pwyw) {
      // The line becomes the creator's choose-your-price Price instead of an
      // amount of ours. Its name, floor, suggestion and tax setting are baked
      // into that Price, so the inline fields go.
      for (const key of [...body.keys()]) {
        if (key.startsWith("line_items[0][price_data]")) body.delete(key);
      }
      body.set("line_items[0][price]", await pwywPriceId(store, product, pwyw, fresh));
      body.set("metadata[pwyw]", "yes");
    }
    // Set just before the request, because Stripe counts its minimum from then.
    if (extras.held) body.set("expires_at", String(checkoutClosesAt()));
    else if (extras.remind && !body.has("expires_at")) body.set("expires_at", String(Math.floor(Date.now() / 1000) + RECOVERY_OPEN_SECONDS));
    return onAccount("POST", store.stripeAccountId as string, "/checkout/sessions", body, recurring ? SUBSCRIPTION_CHECKOUT_VERSION : undefined);
  };

  // Each of the two things Stripe may refuse is put right once, whichever it
  // refuses first, so a store with both — reminders Stripe will not ask for,
  // and a kept Price that was archived — still opens its checkout.
  let session: Record<string, unknown> | null = null;
  let asking = recovering;
  let documents = store.tax.ids || store.tax.invoices;
  let fresh = false;
  while (session === null) {
    try {
      session = await open(fresh);
    } catch (error) {
      if (named && error instanceof StripeError && error.status === 400) {
        // A name is never worth a checkout: refused, it opens under the
        // account's own name, as it would have without it.
        console.error("Stripe refused the demo checkout's display name; opening it without", error);
        body.delete(DISPLAY_NAME);
        named = false;
        continue;
      }
      if (body.has("discounts[0][promotion_code]") && error instanceof StripeError && error.status === 400 && /promotion|coupon|discount/i.test(error.message)) {
        // The code from the link is real but not for this sale — a minimum,
        // a first order only, another product. The buyer is not turned away
        // for it: the checkout opens with the box, as it would have.
        console.error("a code from a link did not fit this checkout; opened with the box instead", error);
        body.delete("discounts[0][promotion_code]");
        body.delete("metadata[code]");
        body.set("allow_promotion_codes", "true");
        continue;
      }
      if (asking && refusedRecovery(error)) {
        // Stripe decides which accounts it will ask for consent on behalf of.
        // One it refuses still sells: the checkout is opened again without
        // asking, and that buyer is simply never reminded.
        console.error("checkout refused the reminder fields; opened without them", error);
        withoutRecovery(body);
        asking = false;
        continue;
      }
      if (documents && refusedTaxDocuments(error)) {
        // A tax number box and an invoice are worth a great deal to a business
        // buyer and nothing at all to a sale that never happens. Refused on
        // this account, the checkout opens again without them and sells.
        console.error("checkout refused the tax number box or the invoice; opened without them", error);
        withoutTaxDocuments(body);
        documents = false;
        continue;
      }
      // The kept Price was archived or deleted in the creator's dashboard: make
      // a new one and try once more, rather than leave the product unsellable.
      const aboutThePrice =
        error instanceof StripeError &&
        error.status < 500 &&
        (error.code === "resource_missing" || /price/i.test(error.message));
      if (!pwyw || fresh || !aboutThePrice) throw error;
      fresh = true;
    }
  }
  if (typeof session.url !== "string" || !session.url || typeof session.id !== "string") {
    throw new Error("Stripe did not return a checkout URL");
  }
  return { url: session.url, id: session.id };
}

/** A product added at checkout, as an order hands it over. */
export type AddedProduct = { key: BumpKey; product: Listing; file: ProductFile | null; link: string | null; items: BundleContents | null };

export type Order =
  | {
      state: "paid";
      /** The product as listed; read it in full (readProduct) for its funnel. */
      product: Listing;
      /** The price option that was bought, when the product has any. */
      option: ProductOption | null;
      /** What to hand over: the option's if there was one, else the product's. */
      file: ProductFile | null;
      link: string | null;
      amount: number;
      /** The address the buyer paid with, so the link can be sent again. */
      email: string | null;
      /** How long this download still has, in seconds. */
      secondsLeft: number;
      /**
       * For a paid call: the time booked — where its buyer moved it, if they
       * did — the buyer's own time zone, and how many times it was moved.
       */
      call: { start: number; end: number; buyerTz: string; moves: number; lead: string; pi: string } | null;
      /**
       * The products the buyer added at checkout, in the order of their
       * boxes, each with what it delivers — and, when it is a bundle, the
       * products it hands over (lib/bundles.ts). `key` is where the order
       * names it (lib/bundle-rules.ts, BUMP_KEYS), which the download link
       * uses to say which one.
       */
      bumps: AddedProduct[];
      /**
       * When the product bought is a bundle: the products it hands over, from
       * the list written on this order when it was paid (lib/bundle-rules.ts).
       */
      items: BundleContents | null;
      /** When it was paid, in seconds since the epoch. */
      created: number;
      /** The fingerprint an upsell must be taken with, when one follows. */
      upsellKey: string | null;
      /** When the buyer chose the payment plan: how many payments, how often. */
      plan: { payments: number; interval: "week" | "month" } | null;
      /** For a course: the fingerprint of the paying browser's secret. */
      buyerKey: string | null;
      /** The buyer ticked the box to hear from the creator. */
      news: boolean;
      /** And allowed their link use in sequences to be seen (lib/mail-clicks.ts). */
      clicks: boolean;
      /** For a membership: the days free before the first payment, 0 for none. */
      trialDays: number;
      /**
       * For a membership moved from another platform (lib/move-members.ts):
       * when its first payment here is taken, in seconds; 0 when it was
       * charged at checkout, or was not moved.
       */
      firstChargeAt: number;
      /** For a membership that ends by itself: after how many payments. */
      endsAfter: number;
      /** What the buyer answered at checkout. */
      answers: Answer[];
      /**
       * The checkout as Stripe returned it, for the little only one page
       * needs from it (an affiliate's sale is written down from it).
       */
      record: Record<string, unknown>;
      /**
       * For a membership: whether it is still running, as Stripe says in this
       * same request. An ended one hands nothing over (lib/membership-access.ts).
       * Null for anything that is not a membership.
       */
      membership: "live" | "ended" | null;
      /** The checkout's own id, which a license key and a stamped copy are kept under. */
      reference: string;
      /**
       * Bought for somebody else (lib/gifts.ts): what it hands over is theirs,
       * and nothing is handed over here. Null for an ordinary purchase.
       */
      gift: string | null;
      /**
       * Bought for several people (lib/group-buy.ts): its places are handed
       * out from its own link, and nothing is handed over here. Null otherwise.
       */
      group: string | null;
      /**
       * A pre-order (lib/preorders.ts): nothing is handed over here; it is
       * handed over, and emailed, the day the product comes out.
       */
      preorder: boolean;
      /** What it was charged in, as Stripe says: the store's currency when it was bought. */
      currency: string;
      /**
       * Whether the buyer paid with a method a one-click offer can charge
       * (lib/instant-pay.ts): a saved card, Apple Pay or Google Pay. A buyer
       * who paid with Klarna, iDEAL or the like is shown no offer.
       */
      reusable: boolean;
    }
  /** Refunded in full: what it bought is closed, on every page (lib/refunds.ts). */
  | { state: "unpaid" | "processing" | "expired" | "invalid" | "unavailable" | "error" | "refunded" };

/**
 * Decides whether this buyer may have the file.
 *
 * Nothing about the visitor is trusted except the session id, and that is
 * checked against Stripe every time rather than against anything we wrote
 * down. The session must belong to this store and name a product this store
 * still lists, so a session from somewhere else cannot open a door here.
 *
 * It does not ask whether the store can sell today. Somebody who paid is owed
 * what they paid for even if the creator's subscription ended, or Stripe
 * paused their account, while the buyer was on the payment page.
 */
export async function readOrder(
  store: Store,
  sessionId: string | undefined,
): Promise<Order> {
  if (!isSellingConfigured() || !store.stripeAccountId) return { state: "unavailable" };
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    return { state: "invalid" };
  }

  let session: Record<string, unknown>;
  try {
    // The membership comes with it, so whether it still runs is known from
    // this one request rather than a second one; so does the payment's
    // charge, so a refund made since closes the order on the next request.
    session = await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription&expand[]=payment_intent.latest_charge&expand[]=payment_intent.payment_method`,
    );
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) {
      return { state: "invalid" };
    }
    console.error("order lookup failed", error);
    return { state: "error" };
  }

  // A membership switched to another tier is read as the tier it is on now (lib/tier-rules.ts).
  const metadata = session.metadata ? currentMeta(session.metadata as Record<string, string>, session) : null;
  // Sold under an address this store still answers to: a rename while the
  // buyer was paying does not lose them their order.
  const handles = saleHandles(store);
  if (!handles.has(metadata?.store ?? "")) return { state: "invalid" };
  const mainList = bundleFromMeta(metadata, "bundle");
  const addedMeta = bumpsFromMeta(metadata);
  const [product, items, ...addedRead] = await Promise.all([
    metadata?.product ? readListing(store, metadata.product) : null,
    mainList.length ? contentsOf(store, mainList) : null,
    ...addedMeta.map(async ({ key, id }) => {
      const list = bundleFromMeta(metadata, `${key}_bundle`);
      const [listing, inside] = await Promise.all([readListing(store, id), list.length ? contentsOf(store, list) : null]);
      return { key, listing, inside };
    }),
  ]);
  if (!product) return { state: "invalid" };

  // The option is read from the charge, not from anything the visitor sends.
  // An option the creator has since removed leaves the order readable and its
  // delivery empty, which the pages say plainly rather than guessing another.
  const option =
    product.options.find((entry) => entry.id === metadata?.option) ?? null;

  // Paid by a method that settles later: the checkout is done, the money is
  // not. Said as such, rather than telling the buyer nothing was paid.
  if (session.status === "complete" && session.payment_status === "unpaid") {
    return { state: "processing" };
  }
  if (!isSettled(session)) {
    return { state: "unpaid" };
  }
  // Given back in full: the download, the course and the offers after it
  // close, whatever time is left on the link.
  if (await purchaseRefunded(store.stripeAccountId, session)) {
    return { state: "refunded" };
  }

  const start = Number(metadata?.start);
  const end = Number(metadata?.end);
  let call =
    metadata?.kind === "call" && Number.isFinite(start) && Number.isFinite(end) && end > start
      ? {
          start,
          end,
          buyerTz: typeof metadata?.tz === "string" ? metadata.tz : "UTC",
          moves: 0,
          // The affiliate a lead is credited to once the call takes place, and its payment (lib/affiliate-leads.ts).
          lead: /^[0-9a-f]{12}$/.test(metadata?.lead_via ?? "") ? (metadata?.lead_via as string) : "",
          pi:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent && typeof session.payment_intent === "object" && typeof (session.payment_intent as { id?: unknown }).id === "string"
                ? (session.payment_intent as { id: string }).id
                : "",
        }
      : null;
  // A booking its buyer moved is at its new time everywhere it is shown.
  if (call) {
    try {
      const move = (await readMoves([sessionId])).get(sessionId);
      if (move) call = { ...call, start: move.s, end: move.e, moves: move.n };
    } catch (error) {
      console.error("reading a moved booking failed", error);
      return { state: "error" };
    }
  }

  // A download link lasts three days; a booked call is shown, with its
  // calendar file, until it is over, because the reminder emails link here.
  const created = typeof session.created === "number" ? session.created : 0;
  const age = Date.now() / 1000 - created;
  if (age > DOWNLOAD_WINDOW_SECONDS && !(call && call.end > Date.now())) return { state: "expired" };

  const details = session.customer_details as { email?: unknown } | null;
  const email =
    typeof details?.email === "string" && details.email ? details.email : null;

  // Delivered as it is now, like the product itself: the offer may since have
  // changed, but what was paid for was this product.
  const bumps: AddedProduct[] = addedRead.flatMap(({ key, listing, inside }) =>
    listing ? [{ key, product: listing, file: listing.file, link: listing.link, items: inside }] : [],
  );

  let membership: "live" | "ended" | null = null;
  if (soldAMembership(product, { mode: session.mode, metadata })) {
    try {
      membership = isLive(await membershipStatus(store, session.subscription)) ? "live" : "ended";
    } catch (error) {
      console.error("reading a membership failed", error);
      return { state: "error" };
    }
  }

  return {
    state: "paid",
    membership,
    gift: typeof metadata?.gift === "string" && GIFT_ID.test(metadata.gift) ? metadata.gift : null,
    group: typeof metadata?.group === "string" && GROUP_ID.test(metadata.group) ? metadata.group : null,
    preorder: metadata?.preorder === "yes",
    reference: sessionId,
    call,
    bumps,
    items,
    created,
    upsellKey: typeof metadata?.upsell_key === "string" ? metadata.upsell_key : null,
    buyerKey: typeof metadata?.buyer_key === "string" ? metadata.buyer_key : null,
    news: metadata?.news === "yes",
    clicks: metadata?.news === "yes" && metadata?.clicks === "yes",
    trialDays: Number.isInteger(Number(metadata?.trial_days)) ? Math.max(0, Number(metadata?.trial_days)) : 0,
    firstChargeAt: firstCharge(metadata),
    endsAfter: Number.isInteger(Number(metadata?.ends_after)) ? Math.max(0, Number(metadata?.ends_after)) : 0,
    answers: readAnswers(session),
    record: session,
    plan:
      metadata?.kind === "plan" && Number(metadata?.plan_payments) >= 2
        ? { payments: Number(metadata.plan_payments), interval: metadata.plan_interval === "week" ? "week" : "month" }
        : null,
    product,
    option,
    file: option ? option.file : product.options.length > 0 ? null : product.file,
    link: option ? option.link : product.options.length > 0 ? null : product.link,
    amount: typeof session.amount_total === "number" ? session.amount_total : 0,
    currency: typeof session.currency === "string" && session.currency ? session.currency : store.currency,
    reusable: reusableMethod(session),
    email,
    secondsLeft: Math.max(0, Math.floor(DOWNLOAD_WINDOW_SECONDS - age)),
  };
}

/** How many past sales the studio shows at once. */
export const ORDERS_PAGE_SIZE = 25;

export type Sale = {
  /** Stripe's own id for the sale. The creator can search it in Stripe. */
  reference: string;
  title: string;
  amount: number;
  /** What it was paid in, as Stripe says. */
  currency: string;
  email: string | null;
  /** Seconds since the epoch, as Stripe counts them. */
  paidAt: number;
  /** Whether the buyer's own download link still opens. */
  stillDownloadable: boolean;
  /** A booked call delivers a time, not a download. */
  isCall: boolean;
  /** What the buyer answered at checkout, question by question. */
  answers: Answer[];
  /** A membership that began with a free trial, so nothing was charged yet. */
  trial: boolean;
  /** Given through "Support my work" (lib/store-tips.ts): nothing was bought and nothing is delivered. */
  isTip: boolean;
  /** A physical product the creator ships (lib/shipping.ts): where it is going; null for anything else. */
  shipTo?: ShipAddress | null;
  /** And when it was marked as shipped (lib/shipments.ts); null while it has not been. */
  shipped?: Shipped | null;
};

// Each state is its own member so a check on one narrows the rest away;
// a combined "unavailable" | "error" member does not narrow in a JSX chain.
export type SaleList =
  | { state: "ok"; sales: Sale[] }
  | { state: "unavailable" }
  | { state: "error" };

type SessionRecord = {
  id?: unknown;
  status?: unknown;
  payment_status?: unknown;
  mode?: unknown;
  created?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: unknown } | null;
  custom_fields?: unknown;
};

/**
 * What this store has sold.
 *
 * Read from the creator's own Stripe account every time rather than kept in a
 * table here. That costs a request, and it buys something worth more: there is
 * no second copy of the sales record to drift from the real one, and nothing
 * for us to lose, leak or quietly get wrong. Stripe is the ledger; this is a
 * window onto it.
 *
 * Only paid sessions carrying this store's handle are returned, so one
 * creator's account can never show another's sales even if an id were reused.
 */
export async function listSales(store: Store): Promise<SaleList> {
  if (!canSell(store)) return { state: "unavailable" };

  let page: Record<string, unknown>;
  try {
    page = await onAccount(
      "GET",
      store.stripeAccountId as string,
      // Only completed checkouts: this is one page, and a store's open and expired ones (a buyer who left the card form)
      // would otherwise fill it and hide its recent orders (as lib/stats.ts, readPaidSales, asks).
      `/checkout/sessions?limit=${ORDERS_PAGE_SIZE}&status=complete`,
    );
  } catch (error) {
    console.error("listing orders failed", error);
    return { state: "error" };
  }

  // An unreadable provider list is unknown, never proof of an empty history.
  if (typeof page !== "object" || page === null || Array.isArray(page)
    || !Object.hasOwn(page, "data") || !Array.isArray(page.data)
    || page.data.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
    return { state: "error" };
  }
  const rows = page.data as SessionRecord[];
  const now = Date.now() / 1000;

  const titles = new Map((await listingsNamedIn(store, rows)).map((p) => [p.id, p.title]));
  // Sales made under an address the store used before are still its sales.
  const handles = saleHandles(store);
  const sales = rows
    .filter(
      (row) =>
        isSettled(row) &&
        // A checkout that only saved a card (setup mode, lib/card-update.ts) owes nothing and is no order, as the API reads
        // it (lib/api-sales.ts, isSale).
        row.mode !== "setup" && row.metadata?.kind !== "card" &&
        handles.has(row.metadata?.store ?? ""),
    )
    .map((row): Sale => {
      const paidAt = typeof row.created === "number" ? row.created : 0;
      const known = row.metadata?.product ? { title: titles.get(row.metadata.product) } : null;
      const email = row.customer_details?.email;
      return {
        reference: typeof row.id === "string" ? row.id : "",
        // The title recorded on the charge wins, because it is what the buyer
        // saw. The current product name is only a fallback for older sales.
        title:
          row.metadata?.title ||
          known?.title ||
          "A product that is no longer listed",
        amount: typeof row.amount_total === "number" ? row.amount_total : 0,
        currency: typeof row.currency === "string" && row.currency ? row.currency : "usd",
        email: typeof email === "string" && email ? email : null,
        paidAt,
        stillDownloadable: now - paidAt <= DOWNLOAD_WINDOW_SECONDS,
        isCall: row.metadata?.kind === "call",
        answers: readAnswers(row),
        trial: Number(row.metadata?.trial_days) > 0,
        isTip: row.metadata?.kind === "tip",
        shipTo: wasShipped(row) ? (shippingAddressOf(row as Record<string, unknown>) ?? { name: "", lines: [], country: "" }) : null,
        shipped: null,
      };
    })
    .filter((sale) => sale.reference !== "");
  // When each shipped order was marked as sent, read at once.
  let shippedAt: Map<string, Shipped>;
  try {
    shippedAt = await readShipped(sales.filter((sale) => sale.shipTo).map((sale) => sale.reference));
  } catch (error) {
    console.error("reading order shipment status failed", error);
    return { state: "error" };
  }
  for (const sale of sales) if (sale.shipTo) sale.shipped = shippedAt.get(sale.reference) ?? null;

  // Products taken in one click after paying are their own charges, not
  // checkouts, so they are read from the payments on the same account.
  let added: Sale[] = [];
  try {
    const intents = await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/payment_intents?limit=${ORDERS_PAGE_SIZE}`,
    );
    const list = Array.isArray(intents.data) ? (intents.data as Record<string, unknown>[]) : [];
    added = list
      .filter((pi) => {
        const meta = pi.metadata as Record<string, string> | null;
        return meta?.kind === "upsell" && handles.has(meta?.store ?? "") && pi.status === "succeeded";
      })
      .map((pi): Sale => {
        const meta = pi.metadata as Record<string, string>;
        const paidAt = typeof pi.created === "number" ? pi.created : 0;
        return {
          reference: typeof pi.id === "string" ? pi.id : "",
          title: `${meta.title || "A product that is no longer listed"} (added after paying)`,
          amount: typeof pi.amount === "number" ? pi.amount : 0,
          currency: typeof pi.currency === "string" && pi.currency ? pi.currency : "usd",
          email: typeof pi.receipt_email === "string" && pi.receipt_email ? pi.receipt_email : null,
          paidAt,
          stillDownloadable: now - paidAt <= DOWNLOAD_WINDOW_SECONDS,
          isCall: false,
          answers: [],
          trial: false,
          isTip: false,
        };
      })
      .filter((sale) => sale.reference !== "");
  } catch (error) {
    // The checkouts are still the whole of the list; this part is extra.
    console.error("listing upsells failed", error);
  }

  const all = [...sales, ...added].sort((a, b) => b.paidAt - a.paidAt).slice(0, ORDERS_PAGE_SIZE);
  return { state: "ok", sales: all };
}

/** The listings of the products a page of checkouts names, read at once. */
async function listingsNamedIn(store: Store, rows: SessionRecord[]): Promise<Listing[]> {
  const ids = rows.map((row) => row.metadata?.product).filter((id): id is string => typeof id === "string" && id !== "");
  return ids.length ? readListings(store, ids) : [];
}
