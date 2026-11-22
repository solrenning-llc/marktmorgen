/**
 * 793 [IV3] unit 2, item (a): what the Terms and the pricing page tell a creator about the VAT Marktmorgen collects
 * as the supplier for VAT of a sale to an EU or UK consumer of a product delivered automatically online (lib/eu-vat-supply.ts
 * "ess"; never a live call or goods), with a worked example in figures
 * (OWNER-20261121-1529-ART9A-PENDING-DECISIONS, item 2; OWNER-20261122-0022-CODEX-LIST-VAT-COSTS, option A: AGENTS.md
 * IV (b) stands, so the platform's fee carries the VAT and the real costs of receiving it, with no profit).
 *
 * The rule the words say, item 2 (a) to (d):
 *   - the VAT is added on top of the creator's price, seen by the buyer before paying;
 *   - the platform's fee on that sale carries the VAT and what receiving it and paying it over costs
 *     (lib/eu-vat-collection-cost.ts, feeCents), with no profit;
 *   - Stripe's processing fee on the VAT part is taken from the creator's account at the creator's own Stripe rates,
 *     and the creator pays it, as on every sale; Marktmorgen does not give it back;
 *   - never a card surcharge to the buyer; never a share of tax.
 *
 * Shown only while that VAT is really collected: null while vatCollecting holds for neither place, the same condition the
 * checkout charges on (lib/eu-vat-collect.ts: the deemed-supplier record says "collect" and the whole switch is on), and
 * null while the example cannot be worked out (no sourced rate, or an unknown cost of receiving the VAT, which also
 * refuses the sale itself). So no page shows a rule that is not live (AGENTS.md VR, item 2). The example's figures come
 * from the code that charges (vatOnTop, ukVatOnTop, vatCollectionCostOf), never typed; only the example's Stripe rate
 * is an illustration, named as one, because each creator's Stripe rates are their own.
 *
 * Pure and browser-safe: no IO, no secret.
 */
import { vatOnTop } from "@/lib/eu-vat-amount";
import type { EuSupply } from "@/lib/eu-vat-supply";
import { REVIEWED_VAT_FX_ALLOWANCES, allowanceInForce, vatCollectionCostOf, type VatFxAllowance } from "@/lib/eu-vat-collection-cost";
import { UK_VAT_RATE_VALID_UNTIL, ukVatOnTop } from "@/lib/uk-vat";
import {
  EU_OSS_REGISTRATION, UK_VAT_REGISTRATION, VAT_COMMERCIAL_REVIEWS, type SwitchInput, vatCanTurnOn, vatCollecting,
} from "@/lib/vat-registrations";

/** The Stripe rate the example uses, in basis points: an illustration, never a creator's real rate. */
export const EXAMPLE_PROCESSING_BPS = 300;
/** The example's price, in minor units of its currency. */
const EXAMPLE_PRICE_CENTS = 10_000;

export type VatFeePlace = "EU" | "UK";

export type VatFeeFigures = {
  country: string;
  currency: string;
  priceCents: number;
  basisPoints: number;
  vatCents: number;
  totalCents: number;
  /** What receiving the VAT and paying it over costs: the fee's part beside the VAT. */
  costCents: number;
  /** The platform's fee on the example sale: the VAT plus that cost. */
  feeCents: number;
  /** The part of Stripe's fee that falls on the VAT, at EXAMPLE_PROCESSING_BPS. */
  stripePartCents: number;
};

export type VatFeeWords = {
  places: VatFeePlace[];
  title: string;
  /** The Terms' paragraph, one sentence each. */
  terms: string[];
  /** The pricing page's paragraph, one sentence each. */
  pricing: string[];
  /** What the checkout does not accept there for now, led by `refusedLead`, shown as a list on both pages. */
  refused: string[];
  /** The places under the VAT_REFUSED_PLACES_WORDS item, one a line (VAT_REFUSED_PLACE_NAMES). */
  refusedPlaces: string[];
  refusedLead: { terms: string; pricing: string };
  /** The worked example, one sentence each, the same on both pages. */
  example: string[];
  figures: VatFeeFigures;
  /**
   * The first day these words can show, YYYY-MM-DD: the latest of each place's registration start, the owner's review
   * of it and the exchange-rate allowance the example's cost rests on. The day before, vatFeeWords gives null.
   */
  since: string;
};

export type VatFeeInput = {
  eu?: SwitchInput;
  uk?: SwitchInput;
  /** Tests only: the deemed-supplier records instead of DEEMED_SUPPLIER_RECORDS (lib/deemed-supplier.ts). */
  records?: unknown;
  now?: Date;
  allowances?: readonly VatFxAllowance[];
};

const money = (cents: number, currency: string): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

const percent = (bps: number): string => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

/** `cents` × `bps` / 10,000, rounded half up, in integers. */
const halfUp = (cents: number, bps: number): number => Math.floor((cents * bps + 5_000) / 10_000);

function figuresOf(place: VatFeePlace, now: Date, allowances: readonly VatFxAllowance[]): VatFeeFigures | null {
  const day = Number.isFinite(now.getTime()) ? now.toISOString().slice(0, 10) : null;
  if (day === null) return null;
  const currency = place === "EU" ? "eur" : "gbp";
  const country = place === "EU" ? "DE" : "GB";
  const vat = place === "EU" ? vatOnTop(EXAMPLE_PRICE_CENTS, country, undefined, now) : day <= UK_VAT_RATE_VALID_UNTIL ? ukVatOnTop(EXAMPLE_PRICE_CENTS) : null;
  if (!vat) return null;
  const cost = vatCollectionCostOf(vat.vatCents, currency, allowances, now);
  if (!cost) return null;
  return {
    country, currency, priceCents: vat.priceCents, basisPoints: vat.basisPoints, vatCents: vat.vatCents,
    totalCents: vat.totalCents, costCents: cost.feeCents, feeCents: vat.vatCents + cost.feeCents,
    stripePartCents: halfUp(vat.vatCents, EXAMPLE_PROCESSING_BPS),
  };
}

/** The words, or null when no such VAT is collected now or the example cannot be worked out. */
export function vatFeeWords(input: VatFeeInput = {}): VatFeeWords | null {
  const now = input.now ?? new Date();
  const allowances = input.allowances ?? REVIEWED_VAT_FX_ALLOWANCES;
  const places: VatFeePlace[] = [];
  if (vatCollecting("EU", input.records, { now, ...input.eu })) places.push("EU");
  if (vatCollecting("UK", input.records, { now, ...input.uk })) places.push("UK");
  if (places.length === 0) return null;
  const f = figuresOf(places[0], now, allowances);
  if (!f) return null;
  const where = places.map((p) => (p === "EU" ? "the European Union" : "the United Kingdom")).join(" and ");
  const buyer = f.country === "DE" ? "Germany" : "the United Kingdom";
  const m = (cents: number) => money(cents, f.currency);
  return {
    places,
    title: "VAT we collect for the tax authority",
    terms: [
      "This section covers one-off purchases of products delivered automatically online: a download, a link, license keys, a recorded course or a private podcast.",
      `When you sell one to a consumer in ${where}, the law makes Marktmorgen responsible for the VAT on that sale.`,
      "Live calls are not covered by this section.",
      "So the checkout adds that VAT on top of your price, and the buyer sees it before paying.",
      "Our platform fee on that sale carries the VAT, which we pay to the tax authority.",
      "The fee also carries what it costs us to receive that VAT and pay it to the tax authority.",
      "That is currency conversion, exchange-rate movement, sending the money on, and reserves for refunds and disputes on the VAT.",
      "We add no profit to those costs, and we never take a share of tax.",
      "Stripe takes its processing fee from your Stripe account on the whole amount the buyer pays, VAT included, at your own Stripe rates.",
      "The part of that fee that falls on the VAT is a cost you pay, as on every sale.",
      "The buyer never pays a card surcharge for it.",
    ],
    pricing: [
      "This covers one-off purchases of products delivered automatically online: a download, a link, license keys, a recorded course or a private podcast.",
      `On such a sale to a consumer in ${where}, the checkout adds VAT on top of your price.`,
      "Live calls are not covered here.",
      "Our fee on that sale carries the VAT, which we pay to the tax authority.",
      "It also carries what it costs us to receive that VAT, with no profit.",
      "Stripe's processing fee on the VAT part is a cost you pay, at your own Stripe rates.",
      "The buyer never pays a card surcharge, and we never take a share of tax.",
    ],
    example: [
      `Example: a buyer in ${buyer} buys a ${m(f.priceCents)} product.`,
      `VAT at ${percent(f.basisPoints)} is ${m(f.vatCents)}, so the buyer pays ${m(f.totalCents)} into your Stripe account.`,
      `Our fee on this sale is ${m(f.feeCents)}: the ${m(f.vatCents)} of VAT and ${m(f.costCents)} to receive it and pay it to the tax authority.`,
      `So you keep your ${m(f.priceCents)} price, less ${m(f.costCents)} and Stripe's fee.`,
      `At a ${percent(EXAMPLE_PROCESSING_BPS)} rate, which is only an example, the part of Stripe's fee that falls on the VAT is ${m(f.stripePartCents)}.`,
    ],
    refused: VAT_REFUSED_SALES.map((r) => r.words),
    refusedPlaces: Object.values(VAT_REFUSED_PLACE_NAMES),
    refusedLead: REFUSED_LEAD(where),
    figures: f,
    since: sinceOf(places, input, now, f.currency, allowances),
  };
}

/**
 * What the checkout refuses to a consumer there while it collects (lib/eu-vat-collect.ts applyEuCollect and euSaleGate,
 * #5086, Claude 1 coord's MEDIUM 2), said plainly so no page promises a sale the checkout turns down. VAT_REFUSED_SALES
 * names each refusal beside the check that makes it; tests/vat-fee-words.test.ts holds the two together.
 */
/**
 * The places in, or tied to, the EU or the UK whose consumers the checkout refuses even while it collects
 * (lib/eu-vat-supply.ts: TERRITORY_UNSETTLED is read as a place not settled, and the rest of REFUSED_PLACES falls outside
 * EU_VAT_COUNTRIES), by the name a buyer knows (#5086, coord 0cb1's MEDIUM). tests/vat-fee-words.test.ts walks both lists
 * through euSaleGate, so a place charged is never named and a place refused always is.
 */
export const VAT_REFUSED_PLACE_NAMES: Readonly<Record<string, string>> = {
  ES: "Spain", EA: "Ceuta and Melilla", IC: "the Canary Islands", MC: "Monaco", GF: "French Guiana", GP: "Guadeloupe",
  MQ: "Martinique", RE: "Réunion", YT: "Mayotte", MF: "Saint Martin", AX: "the Åland Islands", IM: "the Isle of Man",
};
/** The item that leads the places, shown with each place on its own line under it (AX274 3.1.5; Claude 1 2as's LEVE). */
export const VAT_REFUSED_PLACES_WORDS = "Buyers in these places";

export const VAT_REFUSED_SALES: readonly { words: string; checks: readonly string[]; files?: readonly string[] }[] = [
  { words: "Products that ship", checks: ["shipping or a subscription"] },
  { words: "Subscriptions and memberships", checks: ["shipping or a subscription"] },
  { words: "Payment plans", checks: ["not a one-off payment"] },
  { words: "Pay-what-you-want prices", checks: ["a price the buyer chooses"] },
  { words: "Discount or promotion codes", checks: ["a discount or a promotion box"] },
  { words: "Prices converted to the buyer's own currency", checks: ["a conversion to the buyer's currency"] },
  { words: "More than one of the same product", checks: ["a quantity other than one"] },
  { words: "Other products added to one product's checkout", checks: ["more than one line"], files: ["app/api/store/checkout/route.ts"] },
  { words: "A bundle in a cart", checks: ["euCartGate"] },
  { words: "Payments through PayPal", checks: [], files: ["app/api/store/paypal/checkout/route.ts"] },
  { words: "The offer shown after paying", checks: [], files: ["lib/upsell.ts"] },
  { words: "Tips and payment requests", checks: [], files: ["app/api/store/tip/route.ts", "app/api/store/pay-request/route.ts"] },
  { words: "E-books and other e-publications, which are books, newspapers or magazines read on a screen", checks: ["notAPublication"] },
  { words: "A product you have not yet marked, on the product, as not an e-publication", checks: ["notAPublication"] },
  { words: "A product with nothing to deliver online and no live call, so we cannot tell what it is", checks: ["euSupplyOf"] },
  { words: VAT_REFUSED_PLACES_WORDS, checks: ["euCheckout"] },
  { words: "A bundle that combines a live call with something delivered online", checks: ["consumerGate"] },
  { words: "A sale where the buyer's internet address shows no country, or a different country from their billing address", checks: ["checkoutEvidence"] },
  { words: "Any sale whose VAT, or the cost of receiving it, we cannot work out, such as one in a currency with no checked exchange rate", checks: ["no sourced rate, or no sterling rate", "the cost of receiving the VAT is unknown"] },
];

/**
 * How the words treat each kind of supply (lib/eu-vat-supply.ts EuSupply), so no kind the gate refuses goes unnamed
 * (#5086, Claude 1 f9afa7's LEVE): "covered" is charged VAT under the rule above; "outside" is sold as before; any
 * other answer is the item of VAT_REFUSED_SALES that names the refusal.
 */
export const VAT_SUPPLY_WORDS: Readonly<Record<EuSupply, "covered" | "outside" | string>> = {
  ess: "covered",
  human: "outside",
  free: "outside",
  goods: "Products that ship",
  unknown: "A product with nothing to deliver online and no live call, so we cannot tell what it is",
};

/**
 * The checkout's other refusals (lib/eu-vat-collect.ts), each a body our own code builds wrong, never a creator's
 * choice, so the words do not name them: tests/vat-fee-words.test.ts fails on a refusal in neither list.
 */
export const VAT_BODY_REFUSALS = [
  { check: "country", why: "the gate passes only a two-letter country" },
  { check: "more lines than a cart holds", why: "a cart holds at most four products for every buyer, anywhere (lib/cart-rules.ts MAX_CART)" },
  { check: "the lines", why: "our checkout numbers its lines from zero" },
  { check: "a Stripe Price instead of an amount", why: "our one-off lines carry an amount; a Price comes only with pay-what-you-want or a subscription, named above" },
  { check: "the line's amount or currency", why: "our lines carry a whole amount and a currency code" },
  { check: "lines in different currencies", why: "a store's checkout is in one currency" },
  { check: "the lines' total", why: "a total past a safe integer is no price we take" },
  { check: "the VAT line", why: "the VAT line is written by applyEuVatLines from figures checked just before" },
] as const;

const REFUSED_LEAD = (where: string): { terms: string; pricing: string } => ({
  terms: `For now, the checkout does not accept these sales from a consumer in ${where}; nothing is charged for them:`,
  pricing: `For now, the checkout does not accept these sales from a consumer in ${where}; nothing is charged for them:`,
});

function sinceOf(places: VatFeePlace[], input: VatFeeInput, now: Date, currency: string, allowances: readonly VatFxAllowance[]): string {
  const dates: string[] = [];
  for (const place of places) {
    const own = place === "EU" ? input.eu : input.uk;
    const registration = place === "EU" ? (own?.eu ?? EU_OSS_REGISTRATION) : (own?.uk ?? UK_VAT_REGISTRATION);
    dates.push(registration.effectiveFrom);
    for (const review of (own?.reviews ?? VAT_COMMERCIAL_REVIEWS) as readonly { jurisdiction?: unknown; reviewedOn?: unknown }[]) {
      if (review && review.jurisdiction === place && typeof review.reviewedOn === "string") dates.push(review.reviewedOn);
    }
  }
  const day = now.toISOString().slice(0, 10);
  // Only the allowances the cost code itself accepts (allowanceInForce), so a malformed or refused one never dates the words.
  for (const a of allowances) if (allowanceInForce(a, currency, day)) dates.push(a.checkedOn);
  return dates.filter(realDay).reduce((latest, date) => (date > latest ? date : latest), "");
}

/**
 * Whether the words can ever show in this build (lib/vat-registrations.ts). While it is false no clock turns a switch on,
 * so a page built ahead of time says what the checkout does; once it is true, the Terms and the pricing page render per
 * request (components/per-request.tsx) and the proxy gives them the nonce policy (lib/csp.ts), on this same answer.
 */
export { vatCanTurnOn };

const realDay = (day: string): boolean => {
  const at = new Date(`${day}T00:00:00Z`);
  return REAL_DAY.test(day) && Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === day;
};

const REAL_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * The Terms' "Last updated" date (Terms section 15: it changes when the Terms do): `base`, the day the Terms' own text
 * last changed, or the first day the VAT paragraph shows (`words.since`) when that is later. An impossible day throws,
 * so no page prints a date that is not one.
 */
export function termsLastUpdated(base: string, words: VatFeeWords | null): string {
  if (!realDay(base)) throw new Error(`Not a calendar day: ${base}`);
  const day = words && realDay(words.since) && words.since > base ? words.since : base;
  const at = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(at);
}
