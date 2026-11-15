/**
 * EU VAT under art. 9a, part 2 of the build, unit 5a: what a checkout does with one sale before it opens
 * (docs/eu-vat-article-9a.md, "The code that would be needed", points 1 to 3). Pure; nothing opens here, and nothing
 * calls it yet: the checkout paths are wired in a later unit, and sales stay closed by lib/opening.ts regardless.
 *
 *   outside  the consumer is placed outside the EU by agreeing evidence: no EU VAT (other jurisdictions are their own
 *            records in lib/deemed-supplier.ts);
 *   free     an EU consumer and a free product: no supply for consideration, no VAT;
 *   collect  an EU consumer and an electronically supplied service with a sourced rate: the VAT added on top of the
 *            price, the place kept as the record's evidence (lib/eu-vat-record.ts);
 *   refuse   anything else: an EU sale for consideration while the EU record in lib/deemed-supplier.ts is missing or
 *            incomplete ("record") or says "refuse-consumers" ("treatment"; docs/art9a-sources-and-build-spec, 2.4: with
 *            no application fee, nothing moves the VAT to the LLC today), a place that is unknown ("place": nothing shows the consumer is outside the EU), goods
 *            ("goods": art. 14a, not built), a service delivered by a person ("human": until a legal decision records
 *            how it is treated), a product whose kind is unknown ("supply"), or no sourced rate ("rate");
 *            and, until EU_VAT_COLLECT_REVIEWED is set, every sale that would be collected or reverse-charged
 *            ("review"); and every sale once the official rate table is past its review date ("rates-expired").
 *   reverse-charge  a business whose VAT number VIES answered "valid" with the associated name and address
 *            (Regulation 282/2011 art. 18(1)(a); lib/eu-vat-vies.ts viesValidFor), for the country the evidence
 *            places it in, asked within VIES_FRESH_SECONDS of the sale on the same day, under a complete EU
 *            record and the review: no VAT is added; the business accounts for it (Directive 2006/112/EC art. 196).
 *
 * A business whose number VIES did not answer "valid" (invalid, MS_UNAVAILABLE or any other unavailability, a
 * timeout, an old answer, another country's number) is charged the consumer's VAT, as VIES's FAQ says ("If you believe
 * that your customer is not a taxable person, you should not exempt the supply but should charge VAT", resp20, read on
 * 14/11/2026): its answer is kept on the "collect" result so the sale's record holds what VIES said at the sale.
 */
import { type ConsumerPlace, type EuSupply, consumerPlace } from "@/lib/eu-vat-supply";
import { type EuVatRate, type VatOnTop, EU_VAT_RATES, euVatRatesExpired, vatOnTop } from "@/lib/eu-vat-amount";
import { type ViesAnswer, splitVatNumber, viesValidFor } from "@/lib/eu-vat-vies";
import { recordedTreatment } from "@/lib/deemed-supplier";

/**
 * Collecting EU VAT and reverse-charging a business (coordinator IVA-2, 13/11/2026: Stripe Tax does not calculate the
 * VAT for the platform on direct charges, so the table in lib/eu-vat-amount.ts is used) are built but locked: false
 * until a reviewer checks the whole treatment, the owner's non-Union OSS registration and the VIES reading. It never
 * opens sales by itself (PLANS_ON_SALE and DEEMED_SUPPLIER_RECORDS stay as they are).
 */
export const EU_VAT_COLLECT_REVIEWED = false;

export type EuCheckout =
  | { kind: "outside"; country: string }
  | { kind: "free"; country: string }
  | { kind: "collect"; vat: VatOnTop; place: Extract<ConsumerPlace, { kind: "eu" }>; vies: ViesAnswer | null }
  | { kind: "reverse-charge"; country: string; vatNumber: string; place: Extract<ConsumerPlace, { kind: "eu" }>; vies: ViesAnswer }
  | { kind: "refuse"; reason: EuCheckoutRefusal };

export type EuCheckoutRefusal = "place" | "goods" | "human" | "supply" | "record" | "treatment" | "rate" | "rates-expired" | "review";

/** A VIES answer worth keeping on the record: an object with a state, as lib/eu-vat-vies.ts builds it; else null. */
const keptAnswer = (vies: unknown): ViesAnswer | null =>
  vies && typeof vies === "object" && typeof (vies as ViesAnswer).state === "string" && typeof (vies as ViesAnswer).askedAt === "string" ? (vies as ViesAnswer) : null;

export function euCheckout(input: {
  supply: EuSupply;
  priceCents: number;
  items: { ip: unknown; billing: unknown; card?: unknown };
  rates?: readonly EuVatRate[];
  /** The deemed-supplier records; lib/deemed-supplier.ts DEEMED_SUPPLIER_RECORDS unless a test passes its own. */
  records?: unknown;
  /** A business buyer: the VAT number it typed and what VIES answered at the sale (lib/eu-vat-vies.ts checkVies). */
  business?: { vatNumber: unknown; vies: unknown } | null;
  /** EU_VAT_COLLECT_REVIEWED unless a test passes its own. */
  reviewed?: boolean;
  /** The moment of the sale; the clock unless a test passes its own. */
  now?: Date;
}): EuCheckout {
  const now = input.now ?? new Date();
  const place = consumerPlace(input.items);
  if (place.kind === "unknown") return { kind: "refuse", reason: "place" };
  if (place.kind === "outside") return { kind: "outside", country: place.country };
  if (input.supply === "free") return { kind: "free", country: place.country };
  if (input.supply === "goods") return { kind: "refuse", reason: "goods" };
  if (input.supply === "human") return { kind: "refuse", reason: "human" };
  if (input.supply !== "ess") return { kind: "refuse", reason: "supply" };
  const treatment = recordedTreatment("EU", input.records);
  if (treatment === null) return { kind: "refuse", reason: "record" };
  // A clock that is not a moment dates nothing: no rate, no VIES answer and no record can be checked against it.
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return { kind: "refuse", reason: "rate" };
  const reviewed = (input.reviewed ?? EU_VAT_COLLECT_REVIEWED) === true;
  const business = input.business ?? null;
  const vies = business ? keptAnswer(business.vies) : null;
  if (business) {
    if (!reviewed) return { kind: "refuse", reason: "review" };
    const typed = splitVatNumber(business.vatNumber);
    // Art. 196 only with VIES's "valid", fresh, for this very number and the country the evidence places the buyer in.
    if (typed && vies && typed.country === place.country && viesValidFor(vies, place.country, now) && vies.number === typed.number) {
      const prefix = place.country === "GR" ? "EL" : place.country;
      return { kind: "reverse-charge", country: place.country, vatNumber: `${prefix}${typed.number}`, place, vies };
    }
  }
  if (treatment !== "collect") return { kind: "refuse", reason: "treatment" };
  if (!reviewed) return { kind: "refuse", reason: "review" };
  const table = input.rates ?? EU_VAT_RATES;
  if (euVatRatesExpired(table, now)) return { kind: "refuse", reason: "rates-expired" };
  const vat = vatOnTop(input.priceCents, place.country, table, now);
  if (!vat) return { kind: "refuse", reason: "rate" };
  return { kind: "collect", vat, place, vies };
}
