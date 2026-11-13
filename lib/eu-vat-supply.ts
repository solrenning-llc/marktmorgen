/**
 * EU VAT under Council Implementing Regulation (EU) No 282/2011 art. 9a, part 2 of the build (docs/eu-vat-article-9a.md),
 * units 1 and 2. Pure: imports nothing, reads and writes nothing, so a checkout, a page and a test read it alike.
 *
 * Nothing here records a treatment or opens a sale: DEEMED_SUPPLIER_RECORDS (lib/deemed-supplier.ts) stays empty and
 * PLANS_ON_SALE (lib/opening.ts) false until the whole treatment is built, tested and backed by the owner's real
 * non-Union OSS registration.
 *
 * 1. What a product is for EU VAT (euSupplyOf). Art. 7(1) of the Regulation: an electronically supplied service is
 *    supplied over the internet, essentially automated, with minimal human intervention. So:
 *      "ess"     a file, a link, licence keys, a recorded course, a private podcast, a membership (access sold);
 *      "human"   a live call or a package of calls: the person's delivery is the service (art. 7(1); compare 7(3)(j));
 *      "goods"   anything that ships (Directive 2006/112/EC art. 14a, not art. 9a);
 *      "free"    a price of zero with no pay-what-you-want amount: no supply for consideration;
 *      "unknown" anything else (a paid product that delivers nothing the code knows, a price that is not a whole
 *                number, a bundle with a member not given or itself unknown). Unknown never sells to an EU consumer.
 *    A bundle is the strictest of its members: goods over human over ess. Whether "human" sales to an EU consumer are
 *    collected or refused is a legal decision recorded elsewhere, never assumed here.
 *
 * 2. Where the consumer belongs (consumerPlace). Art. 24b(d) with art. 24f: two items of non-contradictory evidence.
 *    The items used before payment are the country of the request's IP address and the billing country the buyer
 *    gives; after payment, the card's issuing country may be added as a third. Every item must be a real country code,
 *    and all of them must agree. Disagreement, a missing item or a code that is not a country is "unknown": the EU sale
 *    is refused, never guessed (the evidence is never reduced to the one that suits). A country whose VAT territory its
 *    code alone does not settle (Directive art. 6: Spain's Canary Islands, Ceuta and Melilla; Monaco under France) is
 *    "unknown" too, until a finer item (a postal code) is built.
 */

/** The 27 Member States by ISO 3166-1 alpha-2 (Greece is GR here; its VAT prefix EL is not a country code). */
export const EU_VAT_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

/**
 * Codes whose VAT territory the code alone does not settle: some of the place is outside the EU VAT territory, or the
 * place is outside the EU but inside a Member State's VAT territory (Directive arts. 6 and 7). Until an item finer than
 * the country is built, a consumer placed there is unknown.
 */
const TERRITORY_UNSETTLED: ReadonlySet<string> = new Set(["ES", "EA", "IC", "MC"]);

/** Codes that are never a country: user-assigned ranges and the unknown markers proxies send (ISO 3166-1, 5.1). */
const NOT_A_COUNTRY = /^(AA|Q[M-Z]|X[A-Z]|ZZ|T1)$/;
const TWO_LETTERS = /^[A-Z]{2}$/;

export type EuSupply = "ess" | "human" | "goods" | "free" | "unknown";

/** The fields of a product (lib/catalog.ts, Product) that decide what it is for EU VAT. */
export type EuSupplyFields = {
  priceCents: number;
  file: unknown;
  link: unknown;
  keys: unknown;
  course: unknown;
  podcast?: unknown;
  recurring: unknown;
  call: unknown;
  callPackage?: unknown;
  bundle: readonly string[] | null;
  shipping?: unknown;
  pwyw: unknown;
};

const present = (value: unknown) => value !== null && value !== undefined && value !== false && value !== "";
const RANK: Record<Exclude<EuSupply, "unknown" | "free">, number> = { ess: 0, human: 1, goods: 2 };

/**
 * What one product is for EU VAT. `members` gives a bundle's products by id; a bundle whose member is missing from it,
 * or is itself a bundle, or is unknown, is unknown.
 */
export function euSupplyOf(product: EuSupplyFields, members?: ReadonlyMap<string, EuSupplyFields>): EuSupply {
  if (!product || typeof product !== "object") return "unknown";
  if (!Number.isSafeInteger(product.priceCents) || product.priceCents < 0) return "unknown";
  if (present(product.shipping)) return "goods";
  if (product.bundle !== null && product.bundle !== undefined) {
    if (!Array.isArray(product.bundle) || product.bundle.length === 0 || !members) return "unknown";
    let worst: Exclude<EuSupply, "unknown" | "free"> = "ess";
    for (const id of product.bundle) {
      const member = typeof id === "string" ? members.get(id) : undefined;
      if (!member || (member.bundle !== null && member.bundle !== undefined)) return "unknown";
      const kind = euSupplyOf(member);
      if (kind === "unknown") return "unknown";
      // A free member inside a paid bundle is supplied for the bundle's price: read as what it delivers.
      const delivered = kind === "free" ? euSupplyOf({ ...member, priceCents: 1 }) : kind;
      if (delivered === "unknown" || delivered === "free") return "unknown";
      if (RANK[delivered] > RANK[worst]) worst = delivered;
    }
    return product.priceCents === 0 && !present(product.pwyw) ? "free" : worst;
  }
  const human = present(product.call) || present(product.callPackage);
  const electronic = [product.file, product.link, product.keys, product.course, product.podcast, product.recurring].some(present);
  let kind: EuSupply = human ? "human" : electronic ? "ess" : "unknown";
  if (kind === "unknown") return "unknown";
  if (product.priceCents === 0 && !present(product.pwyw)) kind = "free";
  return kind;
}

export type ConsumerPlace =
  | { kind: "eu"; country: string; evidence: { ip: string; billing: string; card?: string } }
  | { kind: "outside"; country: string }
  | { kind: "unknown"; reason: "missing" | "not-a-country" | "contradiction" | "territory" };

/** One item of evidence as a country code: upper case, two letters, never a code that is not a country. */
function countryOf(value: unknown): string | null | "bad" {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return "bad";
  const code = value.trim().toUpperCase();
  return TWO_LETTERS.test(code) && !NOT_A_COUNTRY.test(code) ? code : "bad";
}

/**
 * Where the consumer belongs, from the IP address's country and the billing country (and, after payment, the card's).
 * Agreement of every item given is required; otherwise unknown.
 */
export function consumerPlace(items: { ip: unknown; billing: unknown; card?: unknown }): ConsumerPlace {
  const ip = countryOf(items.ip);
  const billing = countryOf(items.billing);
  const card = items.card === undefined ? undefined : countryOf(items.card);
  if (ip === null || billing === null || card === null) return { kind: "unknown", reason: "missing" };
  if (ip === "bad" || billing === "bad" || card === "bad") return { kind: "unknown", reason: "not-a-country" };
  if (ip !== billing || (card !== undefined && card !== ip)) return { kind: "unknown", reason: "contradiction" };
  if (TERRITORY_UNSETTLED.has(ip)) return { kind: "unknown", reason: "territory" };
  if (!EU_VAT_COUNTRIES.has(ip)) return { kind: "outside", country: ip };
  return { kind: "eu", country: ip, evidence: { ip, billing, ...(card !== undefined ? { card } : {}) } };
}
