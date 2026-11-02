/**
 * The factual part of a store's policies, generated from what the store
 * really does: 617 [SZ1], unit 1 (owner's Shopify audit, 1 November 2026).
 * Pure, in US English; the translations, the policy page, the creator's own
 * words beside these and the kept versions come in later units, and nothing
 * here is shown to a buyer until they all work (rule VR).
 *
 * Every sentence states something the code does, and says where:
 *
 *   - Seller: the creator is the seller, the sale is a contract between them
 *     and the buyer, Marktmorgen is not the merchant of record, and payments
 *     go into the creator's own Stripe account by direct charges (app/terms,
 *     section 3); PayPal only when the store has it connected.
 *   - Canceling within 14 days: for digital content and for memberships, the
 *     two rules the checkout asks by (lib/digital-consent.ts), with the same
 *     meaning as the Terms, never saying more than they do.
 *   - Memberships: members cancel themselves from the link in the emails,
 *     and the membership ends at the end of the period already paid for
 *     (lib/membership-manage.ts).
 *   - Ad measurement: which pixels are switched on, that visitors are asked
 *     first where the law asks, and that a browser sending Global Privacy
 *     Control is never measured (components/store-pixels.tsx,
 *     lib/ad-consent.ts). No pixel on, no sentence about one.
 *   - Contact: the postal address the store sends its email from, only when
 *     it has one; otherwise no sentence (a contact page is optional).
 *
 * It describes; it is not legal advice, and no sentence promises that a store
 * complies with any law (said in `NOT_ADVICE`). The fingerprint changes with
 * any word, so a later unit keeps each version with its date.
 */
import { createHash } from "node:crypto";
import { POLICY_WORDS } from "@/lib/buyer-words/policies";
import { parseLanguage } from "@/lib/store-language";

export type PolicyFactsInput = {
  storeName: string;
  /** Products sold once and delivered online: files, links, courses, podcasts, bundles. */
  sellsDigital: boolean;
  /** Memberships (subscriptions). */
  sellsMemberships: boolean;
  /** Whether the store has its PayPal connected for checkout. */
  paypal: boolean;
  /** The ad pixels switched on, by their platform names ("Meta", "Google"…). */
  pixels: readonly string[];
  /** The postal address on the store's emails, or "" when none is set. */
  postalAddress: string;
};

export type PolicySection = { id: "seller" | "cancel" | "memberships" | "measurement" | "contact"; title: string; sentences: string[] };

/** The English sentence that says it is not legal advice; every language has its own (lib/buyer-words/policies.ts). */
export const NOT_ADVICE = POLICY_WORDS.en.notAdvice;

const list = (items: readonly string[], and: string) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;

/** The sections, in order, with only what applies to this store, in the store's language (English by default). */
export function policyFacts(input: PolicyFactsInput, language: unknown = "en"): PolicySection[] {
  const w = POLICY_WORDS[parseLanguage(language)];
  // Without the store's name nothing can be said truthfully about who sells: nothing is generated.
  const name = input.storeName.trim();
  if (!name) return [];
  const sections: PolicySection[] = [
    { id: "seller", title: w.titles.seller, sentences: [w.sellerIs(name), w.notParty, w.payments(name, input.paypal)] },
  ];
  const cancel: string[] = [];
  if (input.sellsDigital || input.sellsMemberships) cancel.push(w.cancelIntro);
  if (input.sellsDigital) cancel.push(w.cancelDigital);
  if (input.sellsMemberships) cancel.push(w.cancelMembership);
  if (cancel.length) sections.push({ id: "cancel", title: w.titles.cancel, sentences: cancel });
  if (input.sellsMemberships) sections.push({ id: "memberships", title: w.titles.memberships, sentences: [w.membersCancel, w.membersEnd] });
  const pixels = [...new Set(input.pixels.map((p) => p.trim()).filter(Boolean))];
  if (pixels.length) sections.push({ id: "measurement", title: w.titles.measurement, sentences: [w.measures(name, list(pixels, w.and)), w.askFirst, w.gpc] });
  // Only what is set: with no postal address there is no sentence, rather than one about a contact page the store may not have.
  const address = input.postalAddress.replace(/\s+/g, " ").trim();
  if (address) sections.push({ id: "contact", title: w.titles.contact, sentences: [w.postal(name, address)] });
  return sections;
}

/** The sentence under the policies that says what they are not, in the store's language. */
export function notAdvice(language: unknown = "en"): string {
  return POLICY_WORDS[parseLanguage(language)].notAdvice;
}

/** A fingerprint of every word, so each version can be kept with its date. */
export function policyFingerprint(sections: readonly PolicySection[]): string {
  return createHash("sha256").update(JSON.stringify(sections.map((s) => [s.id, s.title, s.sentences]))).digest("hex").slice(0, 16);
}
