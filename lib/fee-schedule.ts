/**
 * 253 [WH2]: every fee that comes with a sale made through Marktmorgen, in one
 * place, with the official page each figure was read from and the day it was
 * read. The public fee page (app/pricing/fees/page.tsx) is drawn only from
 * here, so it never says a figure that is not written, with its source, below.
 *
 * What is NOT here, on purpose: Marktmorgen's own share of a sale, which only
 * lib/fee-words.ts may put in words (tests/fee-words.test.ts), and the plan
 * prices, which come from lib/plan.ts. This file holds the fees that are not
 * ours: Stripe's, charged on the creator's own Stripe account.
 *
 * These are Stripe's published standard rates. A Stripe account can be on
 * other pricing (negotiated, or a promotional rate for a payment method Stripe
 * turns on), and Stripe can change them. That is why every figure carries the
 * day it was read and the page shows it, and why `feeScheduleDue` says when the
 * figures are more than REVIEW_DAYS old: the page then says so in plain words,
 * above the figures, and points to Stripe's own page.
 *
 * Read by Claude 4 on 15 November 2026 from the raw HTML of each URL below
 * (not a summary). Not a quote from Stripe for any account; no account read.
 */

/** How long a figure may go unreviewed before the page says it is due. */
export const REVIEW_DAYS = 90;

/** The day every figure below was last read from its source (YYYY-MM-DD). */
export const FEES_CHECKED_ON = "2026-11-15";

export type FeeCountry = "us" | "ca" | "gb" | "ie";

export type CountryFees = {
  country: FeeCountry;
  /** Where the creator's Stripe account is based. */
  name: string;
  /** The account's currency, as Stripe prints it. */
  currency: string;
  /** Stripe's country pricing page, every card, dispute and payout figure's source. */
  source: string;
  /** Stripe's local payment methods page for the same country, the Afterpay/Clearpay figure's source. */
  methodsSource: string;
  /** Each line as Stripe prints it, in the order a buyer's payment meets it. */
  domesticCard: string;
  /** The rate for a card from outside the account's country or region. */
  otherCards: { label: string; fee: string }[];
  currencyConversion: string;
  disputeReceived: string;
  disputeCountered: string;
  instantPayout: string;
  /** Klarna as the country page prints it ("starting at" where it says so). */
  klarna: string;
  /** Afterpay (Clearpay in the UK), or null where Stripe's page for the country does not list it. */
  afterpay: { name: string; fee: string } | null;
};

export const COUNTRY_FEES: readonly CountryFees[] = [
  {
    country: "us",
    name: "United States",
    currency: "USD",
    source: "https://stripe.com/pricing",
    methodsSource: "https://stripe.com/pricing/local-payment-methods",
    domesticCard: "2.9% + 30¢",
    otherCards: [{ label: "International cards", fee: "+ 1.5%" }],
    currencyConversion: "+ 1%",
    disputeReceived: "$15.00",
    disputeCountered: "$15.00",
    instantPayout: "1.5% (minimum 50¢)",
    klarna: "5.99% + 30¢",
    afterpay: { name: "Cash App Afterpay", fee: "6% + 30¢" },
  },
  {
    country: "ca",
    name: "Canada",
    currency: "CAD",
    source: "https://stripe.com/en-ca/pricing",
    methodsSource: "https://stripe.com/en-ca/pricing/local-payment-methods",
    domesticCard: "2.9% + CA$0.30",
    otherCards: [{ label: "International cards", fee: "+ 0.8%" }],
    currencyConversion: "+ 2%",
    disputeReceived: "CA$15.00",
    disputeCountered: "CA$15.00",
    instantPayout: "1% (minimum CA$0.60)",
    klarna: "starting at 5.99% + CA$0.30",
    afterpay: { name: "Afterpay", fee: "6% + CA$0.30" },
  },
  {
    country: "gb",
    name: "United Kingdom",
    currency: "GBP",
    source: "https://stripe.com/gb/pricing",
    methodsSource: "https://stripe.com/gb/pricing/local-payment-methods",
    domesticCard: "1.5% + 20p (standard UK cards; premium UK cards 2.8% + 20p)",
    otherCards: [
      { label: "European Economic Area cards", fee: "2.5% + 20p" },
      { label: "International cards", fee: "3.15% + 20p" },
    ],
    currencyConversion: "+ 2%",
    disputeReceived: "£20.00",
    disputeCountered: "£20.00",
    instantPayout: "1% (minimum 40p)",
    klarna: "starting at 4.99% + 35p",
    afterpay: { name: "Clearpay", fee: "6% + 30p" },
  },
  {
    country: "ie",
    name: "Ireland (the European Economic Area example)",
    currency: "EUR",
    source: "https://stripe.com/ie/pricing",
    methodsSource: "https://stripe.com/ie/pricing/local-payment-methods",
    domesticCard: "1.5% + €0.25 (standard EEA cards; premium EEA cards 2.8% + €0.25)",
    otherCards: [
      { label: "UK cards", fee: "2.5% + €0.25" },
      { label: "International cards", fee: "3.15% + €0.25" },
    ],
    currencyConversion: "+ 2%",
    disputeReceived: "€20.00",
    disputeCountered: "€20.00",
    instantPayout: "1% (minimum €0.50)",
    klarna: "starting at 4.99% + €0.40",
    afterpay: null,
  },
];

/** Stripe's standard payouts to the creator's bank, as every country page above prints them. */
export const STANDARD_PAYOUT = "Free, on Stripe's standard schedule";

const DAY_MS = 86_400_000;

/** Whether the figures are older than REVIEW_DAYS on `now`; an unreadable date counts as due, never as fresh. */
export function feeScheduleDue(now: number = Date.now(), checkedOn: string = FEES_CHECKED_ON): boolean {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(checkedOn) ? Date.parse(`${checkedOn}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(at) || !Number.isFinite(now)) return true;
  return now - at > REVIEW_DAYS * DAY_MS;
}

/** "November 15, 2026", for the page. */
export function checkedOnWords(checkedOn: string = FEES_CHECKED_ON): string {
  return new Date(`${checkedOn}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export type ExampleSale = {
  priceCents: number;
  /** Stripe's 2.9% + 30¢ on a US card, in whole cents, rounded to the nearest cent. */
  domesticFeeCents: number;
  /** The same sale paid with a card from outside the US: + 1.5%. */
  internationalFeeCents: number;
  /** The same international sale when the buyer's currency is converted: + 1% more. */
  convertedFeeCents: number;
  /** What Marktmorgen takes from the sale: nothing, while no share is published (lib/fee-words.ts). */
  oursCents: number;
};

const percentOf = (cents: number, bps: number) => Math.round((cents * bps) / 10_000);

/**
 * One sale by a creator whose Stripe account is in the US, worked out from the
 * US figures above. Only the arithmetic of one sale: no forecast of sales or
 * income. `oursCents` is passed in from lib/fee-words.ts's rule, never typed here.
 */
export function exampleSale(priceCents: number, oursCents: number): ExampleSale {
  if (!Number.isInteger(priceCents) || priceCents <= 0) throw new RangeError("an example sale needs a positive whole price in cents");
  const domesticFeeCents = percentOf(priceCents, 290) + 30;
  const internationalFeeCents = domesticFeeCents + percentOf(priceCents, 150);
  const convertedFeeCents = internationalFeeCents + percentOf(priceCents, 100);
  return { priceCents, domesticFeeCents, internationalFeeCents, convertedFeeCents, oursCents };
}

/** "$1.75". */
export function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
