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
import { EU_VAT_COUNTRIES, type EuSupplyFields, euSupplyOf } from "@/lib/eu-vat-supply";
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

/**
 * The places whose consumers are refused at checkout while neither the EU nor the UK has a "collect" record (the
 * coordinator's opening path, C2-20261113-1320-ABRIR-1, 2b): the 27 Member States, the EU's outermost regions and
 * Åland, which a country code names apart (GF, GP, MQ, RE, YT, MF, AX), Monaco, which is inside France's VAT territory,
 * and the United Kingdom with the Isle of Man, which is inside the UK's. Wider than the VAT territories on purpose:
 * refusing a buyer there costs a sale, while selling there unrecorded would owe VAT nobody collected.
 */
export const REFUSED_PLACES: ReadonlySet<string> = new Set([...EU_VAT_COUNTRIES, "GF", "GP", "MQ", "RE", "YT", "MF", "AX", "MC", "GB", "IM"]);

/** Said when a paid product electronically supplied, or a physical one, is asked for from the EU or the UK. */
export const EU_UK_REFUSED =
  "This product can't be bought from the European Union or the United Kingdom yet, because we can't charge the VAT those countries require on it. Nothing was charged.";

/** Said when the checkout was sent without the country the buyer is buying from. */
export const BILLING_COUNTRY_NEEDED = "Choose the country you're buying from, then try again.";

export type ConsumerGate = { ok: true } | { ok: false; reason: "refused" | "billing"; message: string };

/** Whether a product delivers nothing but a service a person gives live: itself, or each member of its bundle. */
function onlyHuman(product: EuSupplyFields, members?: ReadonlyMap<string, EuSupplyFields>): boolean {
  if (product.bundle === null || product.bundle === undefined) return euSupplyOf(product, members) === "human";
  if (!Array.isArray(product.bundle) || !members) return false;
  return product.bundle.every((id) => {
    const member = typeof id === "string" ? members.get(id) : undefined;
    return member !== undefined && euSupplyOf({ ...member, priceCents: Math.max(1, member.priceCents) }) === "human";
  });
}

/** A two-letter country code as Vercel's edge or the buyer's choice names one, or null for anything else. */
const country = (value: string | null): string | null => (value && /^[A-Z]{2}$/.test(value) && !/^(AA|Q[M-Z]|X[A-Z]|ZZ)$/.test(value) ? value : null);

/**
 * The checkout's question before any charge (C2-20261113-1320-ABRIR-1, 2b): may this buyer go on to pay for this
 * product? A free product, and a service a person gives live, go on wherever the buyer is (no electronically supplied
 * service, so not art. 9a). Anything else paid (a download, a course, a membership, a key, physical goods, or a
 * product whose kind does not read) is refused when EITHER the IP's country or the billing country the buyer chose is
 * in REFUSED_PLACES: the reading that protects the company, so a VPN either way is refused. With neither there, it
 * goes on when the billing country was given; without one (missing, or not a country), the buyer is asked for it,
 * unless the IP already places them where the sale is refused. A business with an EU or UK VAT number is refused the
 * same way until the reverse charge is built with the "collect" treatment (2c).
 */
export function consumerGate(input: { product: EuSupplyFields; members?: ReadonlyMap<string, EuSupplyFields>; headers: Headers; form: URLSearchParams | FormData }): ConsumerGate {
  const supply = euSupplyOf(input.product, input.members);
  if (supply === "free") return { ok: true };
  // A live service goes on; a bundle goes on as one only when every member is one (euSupplyOf ranks a bundle by its
  // "worst" member, so a download beside a call would otherwise pass as the call).
  if (supply === "human" && onlyHuman(input.product, input.members)) return { ok: true };
  const items = checkoutEvidence(input.headers, input.form);
  const ip = country(items.ip);
  const billing = country(items.billing);
  if ((ip !== null && REFUSED_PLACES.has(ip)) || (billing !== null && REFUSED_PLACES.has(billing))) {
    return { ok: false, reason: "refused", message: EU_UK_REFUSED };
  }
  if (billing === null) return { ok: false, reason: "billing", message: BILLING_COUNTRY_NEEDED };
  return { ok: true };
}
