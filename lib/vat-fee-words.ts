/**
 * 793 [IV3] unit 2, item (a): what the Terms and the pricing page tell a creator about the VAT Marktmorgen collects
 * as the supplier for VAT of a digital sale to an EU or UK consumer, with a worked example in figures
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
 * Shown only while that VAT is really collected: null while neither euVatCollectOn() nor ukVatCollectOn() holds, and
 * null while the example cannot be worked out (no sourced rate, or an unknown cost of receiving the VAT, which also
 * refuses the sale itself). So no page shows a rule that is not live (AGENTS.md VR, item 2). The example's figures come
 * from the code that charges (vatOnTop, ukVatOnTop, vatCollectionCostOf), never typed; only the example's Stripe rate
 * is an illustration, named as one, because each creator's Stripe rates are their own.
 *
 * Pure and browser-safe: no IO, no secret.
 */
import { vatOnTop } from "@/lib/eu-vat-amount";
import { REVIEWED_VAT_FX_ALLOWANCES, vatCollectionCostOf, type VatFxAllowance } from "@/lib/eu-vat-collection-cost";
import { UK_VAT_RATE_VALID_UNTIL, ukVatOnTop } from "@/lib/uk-vat";
import { euVatCollectOn, type SwitchInput, ukVatCollectOn } from "@/lib/vat-registrations";

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
  /** The worked example, one sentence each, the same on both pages. */
  example: string[];
  figures: VatFeeFigures;
};

export type VatFeeInput = {
  eu?: SwitchInput;
  uk?: SwitchInput;
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
  if (euVatCollectOn({ now, ...input.eu })) places.push("EU");
  if (ukVatCollectOn({ now, ...input.uk })) places.push("UK");
  if (places.length === 0) return null;
  const f = figuresOf(places[0], now, allowances);
  if (!f) return null;
  const where = places.map((p) => (p === "EU" ? "the European Union" : "the United Kingdom")).join(" and ");
  const buyer = f.country === "DE" ? "Germany" : "the United Kingdom";
  const m = (cents: number) => money(cents, f.currency);
  return {
    places,
    title: "VAT we collect for the tax office",
    terms: [
      `When you sell a digital product to a consumer in ${where}, the law makes Marktmorgen responsible for the VAT on that sale.`,
      "So the checkout adds that VAT on top of your price, and the buyer sees it before paying.",
      "Our platform fee on that sale carries the VAT, which we pay to the tax office.",
      "The fee also carries what it costs us to receive that VAT and pay it over.",
      "That is currency conversion, exchange-rate movement, the payment itself, and reserves for refunds and disputes on the VAT.",
      "We add no profit to those costs, and we never take a share of tax.",
      "Stripe takes its processing fee from your Stripe account on the whole amount the buyer pays, VAT included, at your own Stripe rates.",
      "The part of that fee that falls on the VAT is a cost you pay, as on every sale.",
      "The buyer never pays a card surcharge for it.",
    ],
    pricing: [
      `On a digital sale to a consumer in ${where}, the checkout adds VAT on top of your price.`,
      "Our fee on that sale carries the VAT, which we pay to the tax office, and what it costs us to receive it and pay it over, with no profit.",
      "Stripe's processing fee on the VAT part is a cost you pay, at your own Stripe rates.",
      "The buyer never pays a card surcharge, and we never take a share of tax.",
    ],
    example: [
      `Example: a buyer in ${buyer} buys a ${m(f.priceCents)} product.`,
      `VAT at ${percent(f.basisPoints)} is ${m(f.vatCents)}, so the buyer pays ${m(f.totalCents)} into your Stripe account.`,
      `Our fee on this sale is ${m(f.feeCents)}: the ${m(f.vatCents)} of VAT and ${m(f.costCents)} to receive it and pay it over.`,
      `So you keep your ${m(f.priceCents)} price, less ${m(f.costCents)} and Stripe's fee.`,
      `At a ${percent(EXAMPLE_PROCESSING_BPS)} rate, which is only an example, the part of Stripe's fee that falls on the VAT is ${m(f.stripePartCents)}.`,
    ],
    figures: f,
  };
}
