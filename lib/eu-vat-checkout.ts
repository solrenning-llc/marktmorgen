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
 *            ("review"), or a business whose VAT number VIES did not answer "verified" for that country ("business").
 *   reverse-charge  a business with a VIES-verified VAT number of the country the evidence places it in, under a
 *            complete EU record and the review: no VAT is added; the business accounts for it (Directive 2006/112/EC
 *            art. 196). Only "verified" counts: invalid, unavailable or anything else is refused, never collected.
 */
import { type ConsumerPlace, type EuSupply, consumerPlace } from "@/lib/eu-vat-supply";
import { type EuVatRate, type VatOnTop, EU_VAT_RATES, vatOnTop } from "@/lib/eu-vat-amount";
import { recordedTreatment } from "@/lib/deemed-supplier";

/**
 * Collecting EU VAT and reverse-charging a business (coordinator IVA-2, 13/11/2026: Stripe Tax does not calculate the
 * VAT for the platform on direct charges, so the table in lib/eu-vat-amount.ts is used) are built but locked: false
 * until a reviewer checks the whole treatment, the owner's non-Union OSS registration and the VIES reading. It never
 * opens sales by itself (PLANS_ON_SALE and DEEMED_SUPPLIER_RECORDS stay as they are).
 */
export const EU_VAT_COLLECT_REVIEWED = false;

/** A VAT number: two capital letters (Greece's prefix is EL), then 2 to 12 digits or capital letters. */
const VAT_NUMBER = /^([A-Z]{2})[0-9A-Z]{2,12}$/;
const VAT_PREFIX: Record<string, string> = { EL: "GR" };

export type EuCheckout =
  | { kind: "outside"; country: string }
  | { kind: "free"; country: string }
  | { kind: "collect"; vat: VatOnTop; place: Extract<ConsumerPlace, { kind: "eu" }> }
  | { kind: "reverse-charge"; country: string; vatNumber: string }
  | { kind: "refuse"; reason: "place" | "goods" | "human" | "supply" | "record" | "treatment" | "rate" | "review" | "business" };

export function euCheckout(input: {
  supply: EuSupply;
  priceCents: number;
  items: { ip: unknown; billing: unknown; card?: unknown };
  rates?: readonly EuVatRate[];
  /** The deemed-supplier records; lib/deemed-supplier.ts DEEMED_SUPPLIER_RECORDS unless a test passes its own. */
  records?: unknown;
  /** A business buyer: its VAT number and what VIES answered for it ("verified" only counts). */
  business?: { vatNumber: unknown; vies: unknown } | null;
  /** EU_VAT_COLLECT_REVIEWED unless a test passes its own. */
  reviewed?: boolean;
}): EuCheckout {
  const place = consumerPlace(input.items);
  if (place.kind === "unknown") return { kind: "refuse", reason: "place" };
  if (place.kind === "outside") return { kind: "outside", country: place.country };
  if (input.supply === "free") return { kind: "free", country: place.country };
  if (input.supply === "goods") return { kind: "refuse", reason: "goods" };
  if (input.supply === "human") return { kind: "refuse", reason: "human" };
  if (input.supply !== "ess") return { kind: "refuse", reason: "supply" };
  const treatment = recordedTreatment("EU", input.records);
  if (treatment === null) return { kind: "refuse", reason: "record" };
  const reviewed = (input.reviewed ?? EU_VAT_COLLECT_REVIEWED) === true;
  if (input.business !== undefined && input.business !== null) {
    if (!reviewed) return { kind: "refuse", reason: "review" };
    const { vatNumber, vies } = input.business;
    const match = typeof vatNumber === "string" ? VAT_NUMBER.exec(vatNumber) : null;
    if (vies !== "verified" || !match || (VAT_PREFIX[match[1]] ?? match[1]) !== place.country) return { kind: "refuse", reason: "business" };
    return { kind: "reverse-charge", country: place.country, vatNumber: vatNumber as string };
  }
  if (treatment !== "collect") return { kind: "refuse", reason: "treatment" };
  if (!reviewed) return { kind: "refuse", reason: "review" };
  const vat = vatOnTop(input.priceCents, place.country, input.rates ?? EU_VAT_RATES);
  if (!vat) return { kind: "refuse", reason: "rate" };
  return { kind: "collect", vat, place };
}
