/**
 * EU VAT under art. 9a, part 2 of the build, unit 10c: the one call a checkout route makes before it opens a session.
 * It reads the request's two items of location evidence (lib/eu-vat-evidence.ts: the IP country Vercel's edge sets and
 * the billing country the buyer chose), what the product is (lib/eu-vat-supply.ts) and the EU record's treatment
 * (lib/eu-vat-checkout.ts), and answers "go on", with the VAT to add when it is collected, or a refusal with the plain
 * sentence the buyer reads. Pure; nothing is opened, written or asked here.
 *
 * Nothing calls it yet: the routes and the billing-country field are wired in a later unit, once the coordinator says
 * so, and sales stay closed by lib/opening.ts regardless (PLANS_ON_SALE false, DEEMED_SUPPLIER_RECORDS empty).
 */
import { type EuSupplyFields, euSupplyOf } from "@/lib/eu-vat-supply";
import { checkoutEvidence } from "@/lib/eu-vat-evidence";
import { type EuVatRate, type VatOnTop } from "@/lib/eu-vat-amount";
import { euCheckout } from "@/lib/eu-vat-checkout";

/** Said when the two items of evidence are missing or name different countries (docs/art9a-sources-and-build-spec, 2.3). */
export const EU_PLACE_REFUSED =
  "We could not confirm which country you are buying from. Check that the billing country you chose is where you are, and try again.";

/** Said when the buyer is in the EU and this product cannot be sold there today. */
export const EU_SALE_REFUSED = "This product can't be bought from a country in the European Union.";

export type EuGate =
  | { ok: true; vat: VatOnTop | null }
  | { ok: false; reason: "place" | "goods" | "human" | "supply" | "record" | "treatment" | "rate"; message: string };

export function euCheckoutGate(input: {
  product: EuSupplyFields;
  members?: ReadonlyMap<string, EuSupplyFields>;
  headers: Headers;
  form: URLSearchParams | FormData;
  rates?: readonly EuVatRate[];
  records?: unknown;
}): EuGate {
  const supply = euSupplyOf(input.product, input.members);
  const items = checkoutEvidence(input.headers, input.form);
  // A free product is no supply for consideration: no EU VAT and no evidence needed, wherever the buyer is.
  if (supply === "free") return { ok: true, vat: null };
  const answer = euCheckout({ supply, priceCents: input.product.priceCents, items, rates: input.rates, records: input.records });
  if (answer.kind === "outside" || answer.kind === "free") return { ok: true, vat: null };
  if (answer.kind === "collect") return { ok: true, vat: answer.vat };
  return { ok: false, reason: answer.reason, message: answer.reason === "place" ? EU_PLACE_REFUSED : EU_SALE_REFUSED };
}
