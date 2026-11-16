/**
 * The buyer's yes before something is handed over during the 14-day
 * cancellation period, and what is kept of it (queue item 91
 * [D2-EU-WITHDRAWAL], 30 October 2026; corrected the same day after an
 * independent review).
 *
 * The law, read on 30 October 2026 from the adopted texts reproduced on
 * legislation.gov.uk (EUR-Lex's own article text could not be fetched from
 * here): Directive 2011/83/EU arts. 6(1)(k), 8(2), 8(7), 9(1), 9(2)(c) and
 * 14(3), as amended by Directive (EU) 2019/2161 art. 4(6), (7)(b), (11) and
 * (12), which replaced arts. 7(3), 8(8), 14(4)(b)(i), 16(a) and 16(m); and,
 * for the German words, § 356(6) no. 2 BGB (gesetze-im-internet.de). Two
 * rules apply, and the box says the one that fits:
 *
 *   - "digital" — digital content not on a tangible medium, sold once
 *     (a file, a link, a course, a private podcast, a bundle, a pre-order of
 *     one): the right to withdraw (14 days from the contract, art. 9(2)(c))
 *     is lost once supply has begun only if the consumer gave prior express
 *     consent to begin before the period ends, acknowledged that they
 *     thereby lose the right, and got the trader's confirmation on a durable
 *     medium (art. 16(m), art. 8(7)(b)). A pre-order begins on its release
 *     day, so its buyer keeps the right until then.
 *   - "membership" — a membership (a subscription that may hold a community,
 *     live events and coaching as well as content; the code cannot tell the
 *     service parts apart, so every membership is read this way): at least
 *     partly a service. The consumer asks expressly for it to start during
 *     the period (art. 8(8)); the right is lost only once the service is fully
 *     performed (art. 16(a)), and one who withdraws after asking pays in
 *     proportion to what was provided (art. 14(3)). So the box asks for the
 *     start and says what a cancellation in those 14 days costs, and never
 *     says the right is lost.
 *
 * The United Kingdom's rules are read the same way here; their own text was
 * not read on that date.
 *
 * Here the creator is the trader (app/terms, section 3); the store's checkout
 * asks on the creator's behalf, the same way for every buyer:
 *
 *   - one unchecked box before paying, on every form that pays for something
 *     handed over digitally (deliversDigitally), with the sentence of its
 *     kind (consentKind) in the store's language
 *     (lib/buyer-words/digital-consent.ts). Shown to every buyer, because the
 *     page cannot know who has the right; the note under it says it is for
 *     buyers who have that right where they live;
 *   - the server refuses to open the payment without it (consentFromForm,
 *     requireDigitalConsent): a forged form, a page from before the words
 *     changed (another version) or a missing box opens nothing;
 *   - each one-click offer after paying is its own contract, so it asks again
 *     on its own button (lib/upsell.ts);
 *   - a member's switch to another tier or to yearly charges at once under
 *     new terms, so it asks again before charging, and keeps the yes on the
 *     subscription in the request that charges (lib/tier-switch.ts,
 *     lib/yearly-switch.ts; 91 [D2-EU-WITHDRAWAL], the owner's decision
 *     C1-20261106-0100-TODOS-1). The automatic move back to monthly after a
 *     failed yearly renewal (lib/yearly-fallback.ts) asks nothing: the
 *     member is not there, and it opens nothing new;
 *   - what is kept is "yes", the version, the kind and the time, under
 *     CONSENT_META: on the order in the creator's own Stripe account, or, for
 *     a PayPal order, in Marktmorgen's own record of that order, which is
 *     kept 400 days (lib/paypal-sales.ts, PAID_KEPT_SECONDS). No other
 *     personal data, no cookie, no tracking;
 *   - the confirmation email (the durable medium) quotes the sentence, its
 *     version and the day, and says what follows for that order: access
 *     started, starts on the release day, or the membership's 14 days
 *     (lib/digital-consent-email.ts).
 *
 * A product shipped by the creator delivers nothing digital (lib/shipping.ts,
 * shipProblem refuses one with a file, link, course, podcast or bundle, on
 * the product or on any option), so it is never asked, whichever option is
 * picked. An order of one with a digital product added at checkout asks
 * about the added one only, and the email says the shipped item keeps its own
 * right. A booked call (a service, through its own door) and anything free
 * are not asked.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { shipProblem } from "@/lib/shipping";

/**
 * The version of the sentence the buyer checks, in every language. Bumped
 * whenever the words change in any language, with CONSENT_WORDS_FINGERPRINT
 * (tests/digital-consent.test.ts fails when the words change and it does not).
 * Typed as a string: it is compared with what forms and orders carry.
 */
export const EU_WITHDRAWAL_CONSENT_VERSION: string = "2026-11-07.2";

/**
 * The SHA-256, in hex, of every language's two sentences (digital, then
 * membership) joined by "\n" in the order en, es, fr, de, it, nl, pt. Not read at run time: it is what ties the
 * version to the exact words, held by tests/digital-consent.test.ts.
 */
export const CONSENT_WORDS_FINGERPRINT = "d9c03703f1d3417027c0bd778eefdd7318b6c457b40620cc1afd79e9c950888a";

/** The checkbox's name and value, and the hidden field with the version the page showed. */
export const CONSENT_FIELD = "dc";
export const CONSENT_VERSION_FIELD = "dc_v";

/** The metadata key on the order (Stripe checkout session, payment, PayPal order record). */
export const CONSENT_META = "dc";

/** Which sentence the box says, and which rule follows (see above). */
export type ConsentKind = "digital" | "membership";

/** The buyer's yes, as the form gave it: the version of the words and the time, in seconds. */
export type DigitalConsent = { version: string; at: number };

/** The yes as it is kept on an order, with the kind of sentence that was shown. */
export type KeptConsent = DigitalConsent & { kind: ConsentKind };

/** Thrown where a charge is built without the yes it needs: nothing is opened and nothing is charged. */
export class DigitalConsentMissing extends Error {
  constructor() {
    super("This order needs the buyer's yes to start during the cancellation period");
    this.name = "DigitalConsentMissing";
  }
}

/**
 * Thrown where Stripe's 50 metadata fields have no room left for the yes
 * (one is always kept for a choose-your-price line). The yes is never the
 * field dropped: the checkout is refused instead, and nothing is charged.
 */
export class DigitalConsentNoRoom extends Error {
  constructor() {
    super("This checkout has no room left to keep the buyer's yes");
    this.name = "DigitalConsentNoRoom";
  }
}

/** The most metadata fields a checkout may carry before the yes, so it and a choose-your-price mark still fit in Stripe's 50. */
export const METADATA_ROOM_BEFORE_CONSENT = 48;

/** What deciding whether a product hands something over digitally reads. */
export type DeliveryCandidate = {
  priceCents?: number;
  call?: unknown;
  course?: unknown;
  podcast?: unknown;
  bundle?: unknown;
  recurring?: unknown;
  shipping?: unknown;
  pwyw?: unknown;
  plan?: unknown;
  file?: unknown;
  link?: unknown;
  options?: readonly { id?: string; file?: unknown; link?: unknown }[];
};

/**
 * Whether buying this product hands over digital content or a membership.
 * Only a product the creator ships does not, and only a booked call (a
 * service with its own door). A shipped product can hold nothing digital on
 * any option (lib/shipping.ts, shipProblem), so the answer is the same for
 * every option: the page and the server ask the same question and agree.
 * The option is taken so callers say which one, and is otherwise unused.
 */
export function deliversDigitally(product: DeliveryCandidate, optionId: string | null = null): boolean {
  void optionId;
  if (product.call) return false;
  if (product.shipping && shipProblem({
    priceCents: product.priceCents ?? 0,
    recurring: product.recurring ?? null,
    call: product.call ?? null,
    options: [...(product.options ?? [])],
    pwyw: product.pwyw ?? null,
    plan: product.plan ?? null,
    file: product.file ?? null,
    link: product.link ?? null,
    course: product.course ?? null,
    podcast: product.podcast ?? null,
    bundle: product.bundle ?? null,
  }) === null) return false;
  return true;
}

/** The sentence a product's box says: a membership's, or the one for digital content sold once. */
export function consentKind(product: Pick<DeliveryCandidate, "recurring">): ConsentKind {
  return product.recurring ? "membership" : "digital";
}

/**
 * The yes a form carries: only the checked box, sent with the version this
 * code shows today. Anything else, an old page included, is no yes.
 */
export function consentFromForm(form: Pick<FormData, "get">, nowSeconds = Math.floor(Date.now() / 1000)): DigitalConsent | null {
  if (form.get(CONSENT_FIELD) !== "yes") return null;
  if (form.get(CONSENT_VERSION_FIELD) !== EU_WITHDRAWAL_CONSENT_VERSION) return null;
  return { version: EU_WITHDRAWAL_CONSENT_VERSION, at: Math.floor(nowSeconds) };
}

/** A yes that can be kept: today's version and a real time. */
export function validConsent(consent: DigitalConsent | null | undefined): consent is DigitalConsent {
  return Boolean(consent && consent.version === EU_WITHDRAWAL_CONSENT_VERSION && Number.isSafeInteger(consent.at) && consent.at > 1_600_000_000);
}

/** Refuses, before anything is opened, a charge that needs the yes and does not have it. */
export function requireDigitalConsent(needed: boolean, consent: DigitalConsent | null | undefined): void {
  if (needed && !validConsent(consent)) throw new DigitalConsentMissing();
}

/** The value kept under CONSENT_META: "yes:<version>:<d|m>:<seconds>", 29 characters. */
export function consentMetaValue(consent: DigitalConsent, kind: ConsentKind): string {
  return `yes:${consent.version}:${kind === "membership" ? "m" : "d"}:${consent.at}`;
}

/**
 * Writes the yes onto a checkout's metadata, under Stripe's 50-field limit
 * (with one field kept for a choose-your-price mark and `after` for the rest):
 * refused (DigitalConsentNoRoom) rather than written over the limit or left
 * out, so the yes is never the field that is dropped.
 */
export function keepConsentOn(
  body: URLSearchParams,
  consent: DigitalConsent,
  kind: ConsentKind,
  /** Fields still to be written after the yes (the admitted-order mark), held back for. */
  after = 0,
): void {
  const fields = [...body.keys()].filter((key) => key.startsWith("metadata[") && key !== `metadata[${CONSENT_META}]`).length;
  if (fields + after > METADATA_ROOM_BEFORE_CONSENT) throw new DigitalConsentNoRoom();
  body.set(`metadata[${CONSENT_META}]`, consentMetaValue(consent, kind));
}

const META_VALUE = /^yes:([0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{1,3}):(d|m):([0-9]{10})$/;

/** The yes read back from an order's metadata, or null when it has none (or one this code did not write). */
export function readConsentMeta(meta: Record<string, string | undefined> | null | undefined): KeptConsent | null {
  const raw = meta?.[CONSENT_META];
  if (typeof raw !== "string") return null;
  const found = META_VALUE.exec(raw);
  if (!found) return null;
  return { version: found[1], at: Number(found[3]), kind: found[2] === "m" ? "membership" : "digital" };
}
