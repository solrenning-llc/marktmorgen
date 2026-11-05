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

export const NOT_ADVICE =
  "This page describes how this store works and is updated by itself when its settings change. It is not legal advice, and it does not say that the store meets any particular law.";

const list = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** The sections, in order, with only what applies to this store. */
export function policyFacts(input: PolicyFactsInput): PolicySection[] {
  const name = input.storeName.trim() || "This store";
  const sections: PolicySection[] = [
    {
      id: "seller",
      title: "Who sells",
      sentences: [
        `${name} is the seller. Each sale is a contract between ${name} and the buyer.`,
        "Marktmorgen provides the store and its checkout. It is not a party to the sale and is not the merchant of record.",
        `Payments go into ${name}'s own Stripe account${input.paypal ? ", or its own PayPal account when you pay with PayPal" : ""}.`,
      ],
    },
  ];
  const cancel: string[] = [];
  if (input.sellsDigital || input.sellsMemberships) {
    cancel.push("In the European Union, the United Kingdom and some other places, a consumer who buys online usually has 14 days to cancel.");
  }
  if (input.sellsDigital) {
    cancel.push("For digital content, such as a file, a link, a course or a private podcast, that right ends once access starts only if you agreed at checkout that it may start within the 14 days, said you understood you would lose the right, and received a confirmation of both.");
  }
  if (input.sellsMemberships) {
    cancel.push("A membership is at least partly a service: at checkout you ask for it to start now, you keep the right to cancel within the 14 days, and if you do, you may be asked to pay for what you already received.");
  }
  if (cancel.length) sections.push({ id: "cancel", title: "Canceling within 14 days", sentences: cancel });
  if (input.sellsMemberships) {
    sections.push({
      id: "memberships",
      title: "Memberships",
      sentences: [
        "You can cancel a membership yourself at any time, from the link in any email about it, without contacting anyone.",
        "Canceling ends the membership at the end of the period you already paid for.",
      ],
    });
  }
  const pixels = [...new Set(input.pixels.map((p) => p.trim()).filter(Boolean))];
  if (pixels.length) {
    sections.push({
      id: "measurement",
      title: "Ad measurement",
      sentences: [
        `${name} measures its ads with ${list(pixels)}.`,
        "Where the law asks visitors first, nothing is measured until you say yes, and you can say no.",
        "If your browser sends Global Privacy Control, nothing is measured.",
      ],
    });
  }
  // Only what is set: with no postal address there is no sentence, rather than one about a contact page the store may not have.
  const address = input.postalAddress.replace(/\s+/g, " ").trim();
  if (address) sections.push({ id: "contact", title: "Contact", sentences: [`${name}'s postal address: ${address}.`] });
  return sections;
}

/** A fingerprint of every word, so each version can be kept with its date. */
export function policyFingerprint(sections: readonly PolicySection[]): string {
  return createHash("sha256").update(JSON.stringify(sections.map((s) => [s.id, s.title, s.sentences]))).digest("hex").slice(0, 16);
}
