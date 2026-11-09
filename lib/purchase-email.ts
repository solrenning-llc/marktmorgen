/**
 * The email a buyer gets after paying: what they bought, what it cost, and
 * how to get back to it.
 *
 * Stripe can send its own receipt from the creator's account, but only when
 * the creator switched that on in their Stripe settings, and it says nothing
 * about where the file is or how to open the course. So every paid checkout
 * on a creator's store gets this one, from the store's own name, once.
 *
 * Once is the whole difficulty. A buyer can land on the thanks page, refresh
 * it, open it again from their history, or never reach it at all because they
 * closed the tab while Stripe was redirecting. So the email is sent from both
 * places that learn about a payment — the thanks page, and a pass of the
 * five-minute job over each store's recent checkouts (lib/checkout-sweep.ts) —
 * and a key in Redis, taken before sending, decides which of them does it.
 * The sender is also handed an idempotency key, so a retry after a lost reply
 * cannot send it twice either.
 *
 * Nothing about the purchase is written down here beyond that key. What was
 * bought is read from the checkout on the creator's own Stripe account, which
 * is the record of it; the key only remembers that the email went out.
 *
 * Booked calls are left out: they have their own confirmation, with the time
 * and a calendar file, sent the moment the time is written down (lib/calls.ts).
 *
 * A product that hands out license keys has its key in the email too, given
 * to the sale here if the thanks page has not given it already
 * (lib/licence-keys.ts): the same key either way, because a sale only ever
 * gets one.
 *
 * An offer taken in one click after paying (lib/upsell.ts) is a payment of
 * its own, made after this email has usually gone, so it gets a short one of
 * its own (confirmOffer): what was added, what it cost, how to get it, and
 * its license key when it hands one out — kept under the offer's payment,
 * the same reference the thanks page and the list of purchases use.
 */
import { CLOSING_ACCESS_SENTENCE, CLOSING_TERMS_PATH, CLOSING_TERMS_WORDS } from "@/lib/closing-buyers-rules";
import { deliversDigitally } from "@/lib/digital-consent";
import { consentEmailLines } from "@/lib/digital-consent-email";
import { ADMITTED_FIELD, settleAdmitted } from "@/lib/order-admission";
import { countOrder } from "@/lib/orders";
import { shippingWords } from "@/lib/buyer-words/shipping";
import { shippingAddressOf, wasShipped } from "@/lib/shipping-address";
import { recordPackage } from "@/lib/call-packages";
import { type PaidSession, markPaid, sendReceipt } from "@/lib/payment-request-store";
import { type ThanksNote } from "@/lib/thanks-note";
import { readThanksNote } from "@/lib/thanks-note-store";
import { videoAddress } from "@/lib/sales-page";
import { deliverGift } from "@/lib/gifts";
import { resendGroupReceipt, settleGroup } from "@/lib/group-buy";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { saleHandles } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import { canUseDomain } from "@/lib/domains";
import { canManage } from "@/lib/membership-manage";
import { DEMO_CONNECTED_ACCOUNT } from "@/lib/demo-account";
import { SITE_URL } from "@/lib/site-url";
import { creatorAddress } from "@/lib/mail-from";
import type { Listing, Store } from "@/lib/store";
import { listingsNamed, readListing, recordListings } from "@/lib/catalog";
import { recordEnrollment } from "@/lib/learn";
import { type HandOverDeps, confirmPreorder, resendPreorder } from "@/lib/preorders";
import { speechFor } from "@/lib/buyer-words";
import { ordersWords } from "@/lib/buyer-words/orders";
import { firstCharge } from "@/lib/move-rules";
import { type SaleKey, activeKeys, keyForSale } from "@/lib/licence-keys";
import { purchaseRefunded } from "@/lib/refunds";
import { scheduleReviewAsk } from "@/lib/review-ask";
import { type BundleSlot, bumpsFromMeta, bundleFromMeta, deliveredIds, isBundle } from "@/lib/bundle-rules";
import { type NextOffer, nextOfferForEmail } from "@/lib/next-offer";
import { nextOfferWords } from "@/lib/buyer-words/next-offer";
import { pricePill } from "@/components/store-product";
import { productSegment } from "@/lib/product-slug";

/** The fixed sentence as a receipt carries it, with the address of the Terms that explain its limit (queue item 307 EC1). */
const closingAccessLine = () => `${CLOSING_ACCESS_SENTENCE} ${CLOSING_TERMS_WORDS}: ${SITE_URL}${CLOSING_TERMS_PATH}`;

const SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const INTENT_ID_PATTERN = /^pi_[A-Za-z0-9]{10,200}$/;

/**
 * How old a paid checkout may be and still be confirmed. The five-minute job
 * reaches every store well inside a day; anything older was either confirmed
 * already or belongs to a time before this email existed, and a confirmation
 * a week late reads like a mistake.
 */
export const CONFIRM_WITHIN_SECONDS = 24 * 60 * 60;

/** How long the "sent" mark is kept: well past the window above. */
const SENT_MARK_SECONDS = 40 * 24 * 60 * 60;
/** How long a send in progress holds the mark before another may try. */
const SENDING_MARK_SECONDS = 15 * 60;

export const confirmationKey = (session: string) => `nl:confirm:${session}`;

/** A checkout as Stripe lists or returns it, with only the fields read here. */
export type SessionRecord = {
  id?: unknown;
  status?: unknown;
  payment_status?: unknown;
  mode?: unknown;
  created?: unknown;
  expires_at?: unknown;
  amount_total?: unknown;
  amount_subtotal?: unknown;
  currency?: unknown;
  /** What came off, as Stripe sums it (`amount_discount`). */
  total_details?: unknown;
  /** The coupons and promotion codes on it; each coupon's `duration` only when Stripe returned it expanded. */
  discounts?: unknown;
  customer_email?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: unknown } | null;
  consent?: { promotions?: unknown } | null;
  after_expiration?: { recovery?: { enabled?: unknown } | null } | null;
};

/** A name that can sit inside the quotes of an email's From line. */
export function senderName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

/** The From line of an email a store sends its buyers: the store's own name. */
export function fromStore(store: Store): string {
  return `"${senderName(store.name)}" <${senderAddress()}>`;
}

/**
 * The From line of an email in which a store asks for a sale (a checkout
 * left open): the store's own name, at the creator's own address where one
 * is set apart (lib/mail-from.ts), and at the site's otherwise. A receipt,
 * a file or a failed payment is never sent from it: those are fromStore.
 */
export function fromCreator(store: Store): string {
  return `"${senderName(store.name)}" <${creatorAddress(store.handle, NIMBUS_FROM) ?? senderAddress()}>`;
}

/**
 * Where the store lives, for links in an email: the creator's own domain
 * while it is live and on Pro, otherwise its address here. A path under it is
 * one of the store's own pages (/orders, /manage, /course/…), which both
 * addresses answer to.
 */
export function storeBase(store: Store): string {
  if (store.domain?.liveAt && canUseDomain(store)) return `https://${store.domain.name}`;
  return `${SITE_URL}/@${store.handle}`;
}

/** Whether this store's buyers can be sent their confirmation at all. */
export function canConfirm(store: Store): boolean {
  return (
    isRedisConfigured() &&
    isSenderConfigured() &&
    Boolean(store.stripeAccountId) &&
    // Nothing sold on the demo's account is ever confirmed by email
    // (lib/house-store.ts): its checkout takes any address and charges
    // nothing, so a confirmation would be a way to write to anybody.
    store.stripeAccountId !== DEMO_CONNECTED_ACCOUNT
  );
}

/** How a store speaks in an email about money charged in this currency (lib/buyer-words). */
function speaking(store: Pick<Store, "language">, currency: string) {
  return speechFor(store.language, currency);
}

export type Confirmation = { to: string; subject: string; text: string };

/** A license key the email carries, with the product it is for. */
export type KeyLine = { title: string; key: SaleKey };

/**
 * The email for one checkout, or null when this checkout is not one to
 * confirm: not settled, not this store's, a booked call, or too old.
 */
export function confirmationFor(
  store: Store,
  session: SessionRecord,
  nowSeconds = Date.now() / 1000,
  keys: KeyLine[] = [],
  /** The product and what was added, read by the caller; the store record's own when not given. */
  listings: Listing[] = recordListings(store),
  /** The creator's own note after paying, read by the caller (lib/thanks-note.ts). */
  note: ThanksNote | null = null,
  /**
   * The Store assistant's next product, as the page after paying chose it
   * (lib/next-offer.ts, nextOfferForEmail): only where the creator allows it
   * and the buyer agreed at checkout to hear from them. No email of its own.
   */
  next: NextOffer | null = null,
): Confirmation | null {
  const letter = renderConfirmation(store, session, nowSeconds, keys, listings, note, next, true);
  return letter === UNREAD_CHARGE ? null : letter;
}

/** Only the selected, protected physical origin may outlive the old sweep.
 * It grants no expiring digital link and reads no current product catalog.
 * Payment and source binding must be independently checked by its worker.
 */
export function originalPhysicalConfirmation(store: Store, session: SessionRecord, product: Listing): Confirmation | null {
  if (store.stripeAccountId === DEMO_CONNECTED_ACCOUNT || session.metadata?.mm_order_origin !== "physical-v1" || !wasShipped(session) || !product.shipping ||
      product.call || product.course || product.podcast || product.recurring || product.bundle || product.keys || product.note ||
      product.file || product.link || product.plan || product.pwyw || product.callPackage || product.options.length !== 0 ||
      !Number.isSafeInteger(session.amount_total) || Number(session.amount_total) < 0 ||
      session.payment_status === "no_payment_required" && session.amount_total !== 0 ||
      typeof session.currency !== "string" || !/^[a-z]{3}$/.test(session.currency)) return null;
  const letter = renderConfirmation(store, session, Date.now() / 1000, [], [product], null, null, false);
  return letter === UNREAD_CHARGE ? null : letter;
}

/**
 * What renderConfirmation answers for a checkout it would confirm but whose amount, currency or discount figure does
 * not read in its exact shape (CX-123 rule 24): no email is written with a value it does not know, and confirmOnce
 * takes no mark, so the next run reads the checkout again.
 */
const UNREAD_CHARGE = "unread-charge";

/** What was charged and in what, as Stripe returned it: a whole number of the currency's smallest unit, and its code. */
function chargeReads(session: SessionRecord): boolean {
  return Number.isSafeInteger(session.amount_total) && Number(session.amount_total) >= 0 &&
    typeof session.currency === "string" && /^[a-z]{3}$/.test(session.currency);
}

/** A coupon's `duration` on one of the checkout's discounts, when Stripe returned the coupon expanded; null otherwise. */
function couponDuration(entry: unknown): "once" | "repeating" | "forever" | null {
  if (!entry || typeof entry !== "object") return null;
  const { coupon, promotion_code: code } = entry as { coupon?: unknown; promotion_code?: unknown };
  const promotion = code && typeof code === "object" ? (code as { promotion?: { coupon?: unknown } | null; coupon?: unknown }) : null;
  const found = [coupon, promotion?.promotion?.coupon, promotion?.coupon].find((c) => c && typeof c === "object") as { duration?: unknown } | undefined;
  const duration = found?.duration;
  return duration === "once" || duration === "repeating" || duration === "forever" ? duration : null;
}

/**
 * Whether a discount came off a membership's first charge, and how long it keeps coming off, read exactly from the
 * checkout: "none" when Stripe says nothing came off (or says nothing and nothing names a discount); "once" when only
 * this charge had it: Stripe's own coupon says so, or it is the store sale or the welcome offer, whose coupons are
 * always made for the first charge only (app/api/store/sale/route.ts, app/api/store/welcome-offer/route.ts);
 * "every" when Stripe's coupon says every charge; "unsure" when something came off and how long it lasts does not
 * read (a code, which the creator may have made in their own Stripe dashboard, one typed at checkout, a come-back
 * offer); "unread" when the amount that came off is there but not a whole number (CX-123 rule 24).
 */
function firstChargeDiscount(session: SessionRecord): "none" | "once" | "every" | "unsure" | "unread" {
  const meta = session.metadata ?? {};
  const details = session.total_details;
  if (details !== undefined && details !== null) {
    const off = typeof details === "object" ? (details as { amount_discount?: unknown }).amount_discount : undefined;
    if (!Number.isSafeInteger(off) || Number(off) < 0) return "unread";
    if (off === 0) return "none";
  }
  const coupons = Array.isArray(session.discounts) ? session.discounts : [];
  const named = Boolean(meta.code || meta.sale || meta.welcome || meta.winback);
  if ((details === undefined || details === null) && coupons.length === 0 && !named) {
    // Stripe gave no total_details and nothing names a discount: what came off is read from the price before discounts.
    // Above what was charged, something came off whose length does not read; a price before discounts that does not
    // read is not taken for "nothing came off" (CX-123 rule 24).
    const subtotal = session.amount_subtotal;
    if (!Number.isSafeInteger(subtotal) || Number(subtotal) < 0 || !Number.isSafeInteger(session.amount_total)) return "unread";
    return Number(subtotal) > Number(session.amount_total) ? "unsure" : "none";
  }
  const durations = coupons.map(couponDuration);
  if (durations.length > 0 && durations.every((d) => d === "once")) return "once";
  if (durations.length > 0 && durations.every((d) => d === "forever")) return "every";
  if (durations.every((d) => d === null) && (meta.sale || meta.welcome) && !meta.code && !meta.winback) return "once";
  return "unsure";
}

/**
 * For the thanks page (rule 27): a membership charged at checkout whose discount came off its first charge, said in
 * the same words as the confirmation's "Paid:" line; "unread" when what was charged or what came off does not read, so
 * the page names no price; null when the price is said as before (nothing off, every charge off, a free trial, a moved
 * membership, a payment plan or an introductory price, which the page says itself).
 */
export function firstChargeSaid(store: Pick<Store, "language" | "tax">, session: SessionRecord, product: Listing): string | "unread" | null {
  if (!product.recurring) return null;
  const meta = session.metadata ?? {};
  if (introOf(meta) || wholeNumber(meta.trial_days) > 0 || firstCharge(meta) || (meta.kind === "plan" && Number(meta.plan_payments) >= 2)) return null;
  if (!chargeReads(session)) return "unread";
  const discount = firstChargeDiscount(session);
  if (discount === "unread") return "unread";
  if (discount !== "once" && discount !== "unsure") return null;
  const every = meta.every === "year" ? "year" : product.recurring.interval;
  return paidLine(store, product, session.amount_total as number, session.currency as string, null, 0, wholeNumber(meta.ends_after), null, every, discount, regularOf(session, meta));
}

function renderConfirmation(store: Store, session: SessionRecord, nowSeconds: number, keys: KeyLine[], listings: Listing[],
  note: ThanksNote | null, next: NextOffer | null, ageLimited: boolean): Confirmation | null | typeof UNREAD_CHARGE {
  const id = typeof session.id === "string" ? session.id : "";
  if (!SESSION_ID_PATTERN.test(id)) return null;
  if (!isSettled(session)) return null;
  const meta = session.metadata ?? {};
  const handles = saleHandles(store);
  if (!handles.has(meta.store ?? "")) return null;
  if (meta.kind === "call") return null;
  const product = listings.find((p) => p.id === meta.product);
  if (!product || product.call) return null;
  const created = typeof session.created === "number" ? session.created : 0;
  if (ageLimited && nowSeconds - created > CONFIRM_WITHIN_SECONDS) return null;
  const typed = session.customer_details?.email;
  const email = typeof typed === "string" && typed ? typed : typeof session.customer_email === "string" ? session.customer_email : "";
  if (!email) return null;
  // What it cost, in what, and for a membership what came off, never assumed (CX-123 rule 24).
  if (!chargeReads(session)) return UNREAD_CHARGE;
  const discount = product.recurring ? firstChargeDiscount(session) : "none";
  if (discount === "unread") return UNREAD_CHARGE;

  const option = product.options.find((entry) => entry.id === meta.option) ?? null;
  // What a bundle bought or ticked hands over, from the list on the order.
  const inside = (slot: BundleSlot) =>
    bundleFromMeta(meta, slot)
      .map((pid) => listings.find((p) => p.id === pid))
      .filter((p): p is Listing => Boolean(p));
  const items = inside("bundle");
  // Every product ticked at checkout, in the order of its boxes, with what a bundle among them holds.
  const ticked = bumpsFromMeta(meta).flatMap(({ key, id: tickedId }) => {
    const listing = listings.find((p) => p.id === tickedId);
    return listing ? [{ listing, items: inside(`${key}_bundle`) }] : [];
  });
  const bumpItems = ticked.flatMap((added) => added.items);
  const plan =
    meta.kind === "plan" && Number(meta.plan_payments) >= 2
      ? { payments: Number(meta.plan_payments), weekly: meta.plan_interval === "week" }
      : null;
  const amount = session.amount_total as number;
  // What Stripe charged it in.
  const currency = session.currency as string;
  const title = option ? `${product.title} (${option.label})` : product.title;
  const base = storeBase(store);
  const name = store.name;
  // A membership as it was bought: its free trial and its set number of
  // payments travel on the checkout (lib/store-checkout.ts), and are read the
  // way the thanks page reads them, so the email and the page say the same.
  const trialDays = product.recurring ? wholeNumber(meta.trial_days) : 0;
  // A membership moved from another platform: first charged on the day it would have renewed there.
  const firstChargeAt = product.recurring ? firstCharge(meta) : 0;
  const endsAfter = product.recurring ? wholeNumber(meta.ends_after) : 0;
  // And its introductory price, when it had one (lib/intro-price.ts): what the first payments cost, and the price after.
  const intro = product.recurring ? introOf(meta) : null;
  // A monthly membership may have been paid yearly (lib/yearly-price.ts): said as it was bought.
  const every = product.recurring ? (meta.every === "year" ? "year" : product.recurring.interval) : "month";

  const words = ordersWords(store.language);
  const said = speaking(store, currency);
  /** "A and B", "A, B and C" said the language's way. */
  const listed = (titles: string[]) => titles.reduce((all, one) => words.and(all, one));

  const paid =
    firstChargeAt && amount === 0
      ? words.movedToday(speaking(store, currency).money(0))
      : paidLine(store, product, amount, currency, plan, trialDays, endsAfter, intro, every, discount, regularOf(session, meta));
  const lines: string[] = [
    words.confirmIntro(name),
    "",
    words.whatYouBought(title, ticked.length ? listed(ticked.map((added) => added.listing.title)) : ""),
    ...(items.length ? [words.insideOf(product.title, items.map((p) => p.title).join(", "))] : []),
    ...ticked.flatMap((added) => (added.items.length ? [words.insideOf(added.listing.title, added.items.map((p) => p.title).join(", "))] : [])),
    words.paid(paid),
    words.orderReference(id),
    // The yes to start access at once, confirmed on a durable medium (lib/digital-consent-email.ts).
    ...consentEmailLines(store, meta),
  ];

  if (plan) {
    lines.push("", words.planNote(plan.payments, plan.weekly, plan.payments - 1, name));
  }

  lines.push("");
  if (product.podcast) {
    lines.push(words.addPodcastAt(`${base}/podcast/${product.id}`), "", words.podcastNote(email));
  } else if (product.course) {
    lines.push(words.startCourseAt(`${base}/course/${product.id}`), "", words.courseNote(email));
  } else if (wasShipped(session)) {
    // A physical product the creator ships (lib/shipping.ts): where it is going, and who sends it.
    const sw = shippingWords(store.language);
    const to = shippingAddressOf(session as unknown as Record<string, unknown>, said.lang.locale);
    lines.push(`${sw.goingTo}:`, ...(to ? [to.name, ...to.lines].filter(Boolean) : []), "", sw.shipsBy(name));
  } else {
    lines.push(words.openWhatYouBought(`${base}/thanks?session_id=${id}`), "", words.threeDays(`${base}/orders`, email, name));
  }
  // A course inside a bundle opens on its own page, as one bought on its own does.
  const courses = [...items, ...bumpItems].filter((p) => p.course);
  for (const course of courses) {
    lines.push("", words.startTitleAt(course.title, `${base}/course/${course.id}`));
  }
  if (courses.length) {
    lines.push("", words.bundleCourseNote(email));
  }

  for (const line of keys) {
    const label = keys.length > 1 ? words.yourKeyFor(line.title) : words.yourKey;
    lines.push("", line.key.state === "issued" ? words.keyIssued(label, line.key.key) : words.keyOnItsWay(label, name));
  }

  if (product.recurring) {
    if (firstChargeAt) {
      const firstCents = option ? option.priceCents : product.priceCents;
      lines.push("", words.movedCharge(said.money(firstCents), store.tax.enabled && !store.tax.included, said.date(firstChargeAt * 1000)));
    } else if (trialDays > 0) {
      const firstCents = option ? option.priceCents : product.priceCents;
      const tax = store.tax.enabled && !store.tax.included;
      const firstOn = said.date((created + trialDays * 86400) * 1000);
      lines.push("", words.trialCharge(said.money(firstCents), tax, trialDays, firstOn));
    }
    const schedule = words.renews(every, endsAfter);
    lines.push(
      "",
      canManage(store)
        ? `${schedule} ${words.manageAt(endsAfter > 0, `${base}/manage`, email)}`
        : `${schedule} ${words.cancelByReply(endsAfter > 0, name)}`,
    );
  }

  // What lasts depends on the store staying open (queue item 307 EC1): the fixed sentence, drawn here, never the creator's.
  if (deliversDigitally(product)) lines.push("", closingAccessLine());

  // The creator's own note after paying, as the thank-you page shows it: words, video, button.
  if (note) {
    lines.push("", note.heading || words.noteFrom(name));
    if (note.body) lines.push(note.body);
    if (note.video) lines.push(videoAddress(note.video));
    if (note.button) lines.push(`${note.button.label}: ${note.button.url}`);
  }

  // Where the creator lets buyers take their own affiliate link
  // (lib/affiliates.ts, joinAsBuyer): the order is the proof, so the email
  // that carries it can offer the link.
  if (store.affiliates.enabled && store.affiliates.buyers && store.statsId && amount > 0) {
    lines.push("", words.earnBySharing(store.affiliates.percent, name, `${base}/affiliates?order=${id}`));
  }

  // One next product from the same store, as its page after paying showed it: its published price and its own words, labeled as AI's when the model chose it.
  if (next && meta.news === "yes") {
    const nw = nextOfferWords(store.language);
    const why = next.why || next.product.summary;
    lines.push(
      "",
      `${next.ai ? nw.aiLabel : nw.label(name)}: ${next.product.title}, ${pricePill(store, next.product)}`,
      ...(why ? [why] : []),
      `${base}/p/${productSegment(next.product)}`,
      ...(next.ai ? [nw.aiNote(name)] : []),
      nw.emailConsent(name),
    );
  }

  lines.push("", words.storeAt(name, base), "", words.questions(name), words.paymentWent(name));

  return {
    to: email,
    subject: words.confirmSubject(name, product.title).slice(0, 200),
    text: lines.join("\n"),
  };
}

/** The note after paying of the product an order is for, when it has one (lib/thanks-note.ts). */
async function noteFor(store: Store, session: SessionRecord, listings: Listing[]): Promise<ThanksNote | null> {
  const product = listings.find((p) => p.id === session.metadata?.product);
  return product?.note ? readThanksNote(store.statsId, product.id).catch(() => null) : null;
}

/** A membership's introductory price as its checkout carried it (lib/store-checkout.ts), or null. */
export function introOf(meta: Record<string, string | undefined>): { cents: number; count: number; regular: number } | null {
  const count = wholeNumber(meta.intro);
  const cents = wholeNumber(meta.intro_cents);
  const regular = wholeNumber(meta.regular_cents);
  return count && cents && regular ? { cents, count, regular } : null;
}

/** A count carried in a checkout's metadata, or 0 when there is none. */
function wholeNumber(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * What each charge of a membership is before any discount, as Stripe returned the checkout (`amount_subtotal`), or
 * null when it does not read or when products ticked at checkout are in it too: never a catalog price that may have
 * changed since.
 */
function regularOf(session: SessionRecord, meta: Record<string, string>): number | null {
  const subtotal = session.amount_subtotal;
  return Number.isSafeInteger(subtotal) && Number(subtotal) > 0 && bumpsFromMeta(meta).length === 0 ? Number(subtotal) : null;
}

function paidLine(
  store: Pick<Store, "language" | "tax">,
  product: Listing,
  amount: number,
  currency: string,
  plan: { payments: number; weekly: boolean } | null,
  trialDays: number,
  endsAfter: number,
  intro: { cents: number; count: number; regular: number } | null = null,
  every: "day" | "week" | "month" | "year" = product.recurring?.interval ?? "month",
  discount: ReturnType<typeof firstChargeDiscount> = "none",
  regular: number | null = null,
): string {
  const words = ordersWords(store.language);
  const { w, money } = speaking(store, currency);
  const taxOnTop = store.tax.enabled && !store.tax.included;
  if (trialDays > 0 && amount === 0) return words.trialStarted(money(0), trialDays);
  // A membership whose discount came off the first charge: today's amount, and each charge after it at its price
  // before the discount, saying the discount may go on when how long it lasts does not read. Never today's amount as
  // the price of every charge.
  if (product.recurring && !plan && !intro && (discount === "once" || discount === "unsure")) {
    const then = regular === null ? null : `${money(regular)} ${w.every(every)}`;
    return words.discountToday(money(amount), then && endsAfter > 0 ? words.paymentsInAll(then, endsAfter) : then, taxOnTop, discount === "unsure");
  }
  if (amount === 0) return words.discountCovered(money(0));
  if (plan) return w.today(money(amount));
  if (product.recurring && intro) {
    const schedule = w.introThen(money(intro.cents), intro.count, product.recurring.interval, `${money(intro.regular)} ${w.every(product.recurring.interval)}`);
    // With sales tax added on top, what was charged today is said first, as a one-time order says what it charged.
    return taxOnTop ? words.introTaxed(money(amount), schedule) : schedule;
  }
  if (product.recurring) {
    const line = `${money(amount)} ${w.every(every)}`;
    return endsAfter > 0 ? words.paymentsInAll(line, endsAfter) : line;
  }
  return money(amount);
}

export type ConfirmOutcome = "sent" | "already" | "skip" | "failed";

/**
 * Sends the confirmation for one checkout, unless it has gone already.
 *
 * `known` is the checkout as the caller already has it from Stripe; without
 * it, it is asked for — but only after the mark says it is still owed, so a
 * thanks page opened ten times asks Stripe nothing after the first.
 */
export async function confirmPurchase(
  store: Store,
  sessionId: string,
  known?: SessionRecord,
): Promise<ConfirmOutcome> {
  const read: { session?: SessionRecord; items?: number } = {};
  const outcome = await confirmOnce(store, sessionId, known, read);
  // Confirmed now, so it is one of the month's orders (lib/orders.ts): once,
  // by the checkout, and not at all when its sale paid a share.
  if (outcome === "sent") {
    const paid = typeof read.session?.amount_total === "number" ? read.session.amount_total : 0;
    await countOrder(store, `checkout:${sessionId}`, paid, Date.now());
    // The hour its checkout was held in gives it back, now that it is counted (lib/order-admission.ts).
    await settleAdmitted(store, read.session?.metadata?.[ADMITTED_FIELD], 1, read.items ?? 1);
  }
  return outcome;
}

async function confirmOnce(
  store: Store,
  sessionId: string,
  known: SessionRecord | undefined,
  read: { session?: SessionRecord; items?: number },
): Promise<ConfirmOutcome> {
  if (!canConfirm(store) || !SESSION_ID_PATTERN.test(sessionId)) return "skip";
  const key = confirmationKey(sessionId);
  const [mark] = await redisPipeline([["GET", key]]);
  if (mark) return "already";

  let session = known;
  if (!session) {
    try {
      session = (await onAccount(
        "GET",
        store.stripeAccountId as string,
        `/checkout/sessions/${encodeURIComponent(sessionId)}`,
      )) as SessionRecord;
    } catch (error) {
      if (error instanceof StripeError && error.status === 404) return "skip";
      throw error;
    }
  }
  if (session.id !== sessionId) return "skip";
  // The original reserved source owns confirmation and accounting. The
  // thanks page/sweep must never start a second legacy sender or counter.
  if (["physical-v1", "single-digital-v1"].includes(session.metadata?.mm_order_origin ?? "")) return "skip";
  read.session = session;
  // A gift through "Support my work" has nothing to hand over or confirm (lib/store-tips.ts).
  if (session.metadata?.kind === "tip") return "skip";
  // A payment request (lib/payment-requests.ts): written down as paid, and its receipt emailed.
  if (session.metadata?.kind === "request") return confirmRequest(store, session, key);
  const listings = await listingsNamed(store, session.metadata);
  // The products it hands over, a bundle's each, for what it keeps (lib/store-data-rules.ts).
  read.items = listings.reduce((n, product) => n + (isBundle(product) ? (product.bundle?.length ?? 1) : 1), 0) || 1;
  // Bought for somebody else: handed to them, and the buyer gets a receipt
  // that says so (lib/gifts.ts), instead of the usual confirmation.
  if (session.metadata?.gift) return confirmGift(store, session, key);
  // Bought for several people: marked as paid, and the buyer gets a receipt
  // with the link that hands out the places (lib/group-buy.ts).
  if (session.metadata?.group) return confirmGroup(store, session, key);
  // A pre-order: written down and receipted, or handed over at once when the
  // product is already out (lib/preorders.ts).
  if (session.metadata?.preorder) return confirmPreorderOnce(store, session, key);
  // A package of calls: written down, and its booking link emailed (lib/call-packages.ts).
  if (session.metadata?.kind === "package") {
    const product = listings.find((p) => p.id === session.metadata?.product);
    if (!product || !saleHandles(store).has(session.metadata?.store ?? "")) return "skip";
    const bought = await recordPackage({ store, session, product, base: storeBase(store), from: fromStore(store) });
    if (bought) await redisPipeline([["SET", key, "sent", "EX", SENT_MARK_SECONDS]]);
    return bought ? "sent" : "skip";
  }
  const first = renderConfirmation(store, session, Date.now() / 1000, [], listings, null, null, true);
  // A charge that does not read: failed, with no mark taken, so the next run reads the checkout again (CX-123 rule 24).
  if (first === UNREAD_CHARGE) return "failed";
  if (!first) return "skip";
  const next = await nextOfferForEmail(store, sessionId, session.metadata ?? {}).catch(() => null);
  const letter = confirmationFor(store, session, Date.now() / 1000, await keysFor(store, session, listings), listings, await noteFor(store, session, listings), next);
  if (!letter) return "skip";

  const [claimed] = await redisPipeline([["SET", key, "sending", "NX", "EX", SENDING_MARK_SECONDS]]);
  if (claimed === null) return "already";

  let sent = false;
  try {
    sent = await sendEmail({ meter: { by: "order" },
      from: fromStore(store),
      to: letter.to,
      subject: letter.subject,
      text: letter.text,
      replyTo: store.email,
      idempotencyKey: `nimbus-confirm:${sessionId}`,
    });
  } finally {
    // Sent: kept, so nobody sends it again. Not sent: let go, so the next
    // pass of the job, or the next open of the thanks page, tries again.
    await redisPipeline(sent ? [["SET", key, "sent", "EX", SENT_MARK_SECONDS]] : [["DEL", key]]);
  }
  // A paid order confirmed while the store asks for reviews goes on the list
  // to be asked, once (lib/review-ask.ts). Nothing is asked of a trial that
  // charged nothing or of an order paid in full by a discount, and an offer
  // taken after paying is not asked about on its own: one email per order.
  if (sent && typeof session.amount_total === "number" && session.amount_total > 0) {
    const paidAt = typeof session.created === "number" ? session.created : Math.floor(Date.now() / 1000);
    await scheduleReviewAsk(store, sessionId, paidAt).catch((error) => console.error("putting an order on the review list failed", error));
  }
  return sent ? "sent" : "failed";
}

/**
 * A paid payment request (lib/payment-request-store.ts): written down as
 * paid, once, and its receipt emailed to the address it was sent to, as an
 * order's own email. The order is counted by confirmPurchase, as any.
 */
async function confirmRequest(store: Store, session: SessionRecord, key: string): Promise<ConfirmOutcome> {
  const meta = session.metadata ?? {};
  if (!isSettled(session) || !saleHandles(store).has(meta.store ?? "") || typeof meta.request !== "string") return "skip";
  const marked = await markPaid(store, meta.request, session as PaidSession);
  if (!marked) return "skip";
  const [claimed] = await redisPipeline([["SET", key, "sending", "NX", "EX", SENDING_MARK_SECONDS]]);
  if (claimed === null) return "already";
  let sent = false;
  try {
    sent = await sendReceipt({ store, request: marked.request, base: storeBase(store), from: fromStore(store), idempotencyKey: `nimbus-confirm:${String(session.id)}` });
  } finally {
    await redisPipeline(sent ? [["SET", key, "sent", "EX", SENT_MARK_SECONDS]] : [["DEL", key]]);
  }
  return sent ? "sent" : "failed";
}

/**
 * The product a checkout for somebody else names. Read by its own id, never
 * from `listingsNamed`: that list is what the checkout hands to whoever paid
 * (lib/bundle-rules.ts deliveredIds), which for a gift or a purchase for
 * several people is nothing at all — and a gift looked for in it was never
 * found, so it was paid for and never handed over.
 */
async function productFor(store: Store, meta: Record<string, string>): Promise<Listing | null> {
  return meta.product ? readListing(store, meta.product) : null;
}

async function confirmGift(store: Store, session: SessionRecord, key: string): Promise<ConfirmOutcome> {
  if (!isSettled(session)) return "skip";
  const meta = session.metadata ?? {};
  if (!saleHandles(store).has(meta.store ?? "")) return "skip";
  const product = await productFor(store, meta);
  if (!product) return "skip";
  const base = storeBase(store);
  const outcome = await deliverGift({
    store,
    session: session as Parameters<typeof deliverGift>[0]["session"],
    product,
    base,
    from: fromStore(store),
    recordStart: async (email, productId, start) => {
      const course = productId === product.id ? product : await readListing(store, productId);
      if (course?.course) await recordEnrollment(store, email, productId, start);
    },
    ordersLink: (email) => ordersLinkFor(store, email, base),
  });
  if (outcome !== "skip") await redisPipeline([["SET", key, "sent", "EX", SENT_MARK_SECONDS]]);
  return outcome === "given" ? "sent" : outcome === "already" ? "already" : "skip";
}

/** What handing a pre-order over needs from this store: where it lives, who it writes from, and its doors. */
export function preorderDeps(store: Store): HandOverDeps {
  const base = storeBase(store);
  return {
    base,
    from: fromStore(store),
    ordersLink: (email) => ordersLinkFor(store, email, base),
    recordStart: (email, productId, start) => recordEnrollment(store, email, productId, start),
  };
}

async function confirmPreorderOnce(store: Store, session: SessionRecord, key: string): Promise<ConfirmOutcome> {
  const meta = session.metadata ?? {};
  if (!isSettled(session) || !saleHandles(store).has(meta.store ?? "")) return "skip";
  const product = await productFor(store, meta);
  if (!product) return "skip";
  const [claimed] = await redisPipeline([["SET", key, "sending", "NX", "EX", SENDING_MARK_SECONDS]]);
  if (claimed === null) return "already";
  let outcome: Awaited<ReturnType<typeof confirmPreorder>> = "failed";
  try {
    outcome = await confirmPreorder(store, session as Parameters<typeof confirmPreorder>[1], product, preorderDeps(store));
  } finally {
    await redisPipeline(outcome === "failed" ? [["DEL", key]] : [["SET", key, "sent", "EX", SENT_MARK_SECONDS]]);
  }
  return outcome === "failed" ? "failed" : outcome === "skip" ? "skip" : "sent";
}

async function confirmGroup(store: Store, session: SessionRecord, key: string): Promise<ConfirmOutcome> {
  if (!isSettled(session)) return "skip";
  const meta = session.metadata ?? {};
  if (!saleHandles(store).has(meta.store ?? "")) return "skip";
  const product = await productFor(store, meta);
  if (!product) return "skip";
  const outcome = await settleGroup({
    store,
    session: session as Parameters<typeof settleGroup>[0]["session"],
    product,
    base: storeBase(store),
    from: fromStore(store),
  });
  if (outcome !== "skip") await redisPipeline([["SET", key, "sent", "EX", SENT_MARK_SECONDS]]);
  return outcome === "settled" ? "sent" : outcome === "already" ? "already" : "skip";
}

/** One offer taken in one click after paying, as Stripe charged it. */
export type TakenOffer = {
  /** The offer's own payment (pi_…): what its key and its stamped copy are kept under. */
  reference: string;
  /** The checkout it followed, whose thanks page delivers it. */
  parent: string;
  product: Listing;
  email: string;
  amountCents: number;
  /** What Stripe charged it in. */
  currency: string;
  /** When what was added is a bundle: the products it hands over. */
  items?: Listing[];
  /** The offer's own payment metadata, where its yes to start access at once is kept (lib/digital-consent.ts). */
  metadata?: Record<string, string> | null;
};

/** The email for an offer taken after paying, with its license key when it has one. */
export function offerConfirmationFor(store: Store, offer: TakenOffer, key: SaleKey | null = null, keys: KeyLine[] = []): Confirmation | null {
  if (!INTENT_ID_PATTERN.test(offer.reference) || !SESSION_ID_PATTERN.test(offer.parent) || !offer.email) return null;
  const name = store.name;
  const base = storeBase(store);
  const words = ordersWords(store.language);
  const { money } = speaking(store, offer.currency);
  const lines: string[] = [
    words.offerIntro(name),
    "",
    words.whatYouAdded(offer.product.title),
    ...(offer.items?.length ? [words.insideIt(offer.items.map((p) => p.title).join(", "))] : []),
    words.paidOnce(money(offer.amountCents)),
    words.reference(offer.reference),
    ...consentEmailLines(store, offer.metadata),
    "",
    words.openItAt(`${base}/thanks?session_id=${offer.parent}`),
    "",
    words.offerThreeDays(`${base}/orders`, offer.email, name),
    // The fixed sentence (queue item 307 EC1), when what was added lasts.
    ...(deliversDigitally(offer.product) ? ["", closingAccessLine()] : []),
  ];
  for (const line of [...(key ? [{ title: offer.product.title, key }] : []), ...keys]) {
    const label = words.yourKeyFor(line.title);
    lines.push("", line.key.state === "issued" ? words.keyIssued(label, line.key.key) : words.keyOnItsWay(label, name));
  }
  lines.push("", words.storeAt(name, base), "", words.questions(name), words.paymentWent(name));
  return {
    to: offer.email,
    subject: words.offerSubject(name, offer.product.title).slice(0, 200),
    text: lines.join("\n"),
  };
}

/**
 * Sends the confirmation for one offer taken after paying, once, whichever of
 * the offer's own answer and the thanks page settling it gets there first.
 * Its license key is given here if nothing gave it yet: the same key the
 * thanks page and the list of purchases show, because a sale only gets one.
 */
export async function confirmOffer(store: Store, offer: TakenOffer): Promise<ConfirmOutcome> {
  if (!canConfirm(store) || !INTENT_ID_PATTERN.test(offer.reference) || !offer.email) return "skip";
  const mark = confirmationKey(offer.reference);
  const [seen] = await redisPipeline([["GET", mark]]);
  if (seen) return "already";
  let key: SaleKey | null = null;
  if (activeKeys(offer.product)) {
    try {
      key = await keyForSale(store, offer.product, offer.reference, offer.email);
    } catch (error) {
      // Left out rather than holding the email back: it is still on the
      // thanks page and on the buyer's list of purchases.
      console.error("reading a license key for an offer's email failed", error);
    }
  }
  // Each product of a bundle added this way has its own key, under the offer's payment.
  const keys: KeyLine[] = [];
  for (const item of offer.items ?? []) {
    if (!activeKeys(item)) continue;
    try {
      const found = await keyForSale(store, item, offer.reference, offer.email);
      if (found) keys.push({ title: item.title, key: found });
    } catch (error) {
      console.error("reading a license key for an offer's email failed", error);
    }
  }
  const letter = offerConfirmationFor(store, offer, key, keys);
  if (!letter) return "skip";
  const [claimed] = await redisPipeline([["SET", mark, "sending", "NX", "EX", SENDING_MARK_SECONDS]]);
  if (claimed === null) return "already";
  let sent = false;
  try {
    sent = await sendEmail({ meter: { by: "order" },
      from: fromStore(store),
      to: letter.to,
      subject: letter.subject,
      text: letter.text,
      replyTo: store.email,
      idempotencyKey: `nimbus-confirm:${offer.reference}`,
    });
  } finally {
    await redisPipeline(sent ? [["SET", mark, "sent", "EX", SENT_MARK_SECONDS]] : [["DEL", mark]]);
  }
  // One of the month's orders (lib/orders.ts), by its own payment.
  if (sent) await countOrder(store, `offer:${offer.reference}`, offer.amountCents);
  return sent ? "sent" : "failed";
}

/**
 * The license keys a paid checkout earns: the product's, and the one ticked
 * at checkout's. A key that cannot be read or given right now is left out
 * rather than holding the email back; it is still on the thanks page and on
 * the buyer's list of purchases.
 */
async function keysFor(store: Store, session: SessionRecord, listings: Listing[]): Promise<KeyLine[]> {
  const meta = session.metadata ?? {};
  const id = typeof session.id === "string" ? session.id : "";
  const typed = session.customer_details?.email;
  const email = typeof typed === "string" ? typed : "";
  // The product, the one ticked at checkout, and each product of a bundle.
  const products = deliveredIds(meta)
    .map((pid) => listings.find((p) => p.id === pid))
    .filter((p): p is Listing => Boolean(p && activeKeys(p)));
  const lines: KeyLine[] = [];
  for (const product of products) {
    try {
      const key = await keyForSale(store, product, id, email);
      if (key) lines.push({ title: product.title, key });
    } catch (error) {
      console.error("reading a license key for an email failed", error);
    }
  }
  return lines;
}

export type ResendOutcome = "sent" | "unknown" | "call" | "refunded" | "failed";

/**
 * Sends a buyer their purchase email again, when the creator — or someone on
 * their team who answers buyers — asks from the studio's list of sales.
 *
 * The same email as the first, read afresh from the checkout on the
 * creator's own Stripe account, whatever its age, with one line on top saying
 * it is a copy sent at the store's request. The license key in it is the one
 * the sale already has; a sale never gets a second. A checkout that is not
 * this store's, a booked call (which has its own confirmation) and a sale
 * refunded in full are refused rather than sent.
 */
export async function resendPurchase(store: Store, sessionId: string): Promise<ResendOutcome> {
  if (!canConfirm(store) || !SESSION_ID_PATTERN.test(sessionId)) return "unknown";
  let session: SessionRecord & { payment_intent?: unknown };
  try {
    session = (await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent.latest_charge`,
    )) as SessionRecord & { payment_intent?: unknown };
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return "unknown";
    throw error;
  }
  if (session.id !== sessionId) return "unknown";
  if (session.metadata?.kind === "call") return "call";
  if (await purchaseRefunded(store.stripeAccountId, session)) return "refunded";
  const created = typeof session.created === "number" ? session.created : 0;
  // Bought for several people: the buyer's receipt, with the link that hands
  // out the places (lib/group-buy.ts), is what there is to send again.
  if (session.metadata?.group) {
    const meta = session.metadata;
    if (!isSettled(session) || !saleHandles(store).has(meta.store ?? "")) return "unknown";
    const product = await productFor(store, meta);
    if (!product) return "unknown";
    const sent = await resendGroupReceipt({ store, session: session as Parameters<typeof resendGroupReceipt>[0]["session"], product, base: storeBase(store), from: fromStore(store) });
    return sent ? "sent" : "failed";
  }
  // A pre-order: its receipt while it waits, the way in once it was handed over (lib/preorders.ts).
  if (session.metadata?.preorder) {
    const meta = session.metadata;
    if (!saleHandles(store).has(meta.store ?? "")) return "unknown";
    const product = await productFor(store, meta);
    if (!product) return "unknown";
    const sent = await resendPreorder(store, session as Parameters<typeof resendPreorder>[1], product, preorderDeps(store));
    return sent === "refunded" ? "refunded" : sent;
  }
  // Read by id, so a sale of any product of a store of any size is found.
  const listings = await listingsNamed(store, session.metadata);
  const letter = confirmationFor(store, session, created, await keysFor(store, session, listings), listings, await noteFor(store, session, listings));
  if (!letter) return "unknown";
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: fromStore(store),
    to: letter.to,
    subject: letter.subject,
    text: [ordersWords(store.language).copyNote(senderName(store.name)), "", letter.text].join("\n"),
    replyTo: store.email,
  });
  return sent ? "sent" : "failed";
}
