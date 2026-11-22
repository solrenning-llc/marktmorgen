/**
 * 789 [IV1] step 3, unit 1 (coordinator C5-20261120-2100): EU VAT collected on top of the price on the one-off card
 * checkout, through the platform's fee, once the EU record says "collect" and the whole switch is on. Nothing opens
 * here: DEEMED_SUPPLIER_RECORDS is empty and EU_VAT_COLLECT_REVIEWED is false (lib/vat-registrations.ts), so in
 * production euSaleGate answers exactly what consumerGate answers today, and createCheckout is never handed `euVat`.
 *
 * Two steps, so the sale is decided before anything is held and the VAT is worked out on what is really charged:
 *   1. euSaleGate, in the checkout route, before anything is held or written. While the EU record is not "collect" or
 *      the switch is off, it IS consumerGate (an EU or UK buyer refused, a missing billing country asked for). With
 *      both on, a buyer the evidence places in the EU goes through the decision euCheckoutGate makes
 *      (lib/eu-vat-checkout.ts euCheckout): two agreeing items of evidence, an electronically supplied service, a sourced
 *      rate, or a refusal. A UK buyer is still
 *      refused (the UK is its own unit), and so is anything euCheckoutGate does not answer with a VAT amount.
 *   2. applyEuCollect, in createCheckout, after the share is set and before Stripe is asked. The VAT is worked out
 *      again on the one line's real amount (a sale, a fair price or a member price changes it), so it is the VAT on
 *      what the buyer pays for. Only a plain one-off sale can carry it: one line, quantity 1, an amount of ours (no
 *      choose-your-price Price), no discount, no promotion box, no shipping, no subscription and no buyer-currency
 *      conversion. Anything else is refused: the VAT on top must be known before the buyer pays. Then
 *      lib/eu-vat-lines.ts (applyEuVatLines) adds the VAT line, turns the creator's own automatic tax off for this sale
 *      and raises the platform's fee by the VAT and the cost of receiving it, so the tax never comes out of the share
 *      or of Marktmorgen's revenue (AGENTS.md, IV (b)).
 *
 * Unknown is never zero and never collects nothing: an unreadable gate answer, no sourced rate, an unknown cost of
 * receiving the VAT, or a body applyEuVatLines will not take each refuse the checkout before Stripe is asked
 * (EuVatCollectRefused). The cost of receiving the VAT is computed part by part in lib/eu-vat-collection-cost.ts
 * (unit 6), but its exchange-rate allowance until the return is paid is not reviewed yet: euVatCollectionCostCents
 * answers null, so even with the switch on, every sale would be refused until one is. It reads only euros and pounds,
 * so a sale in any other currency is refused too, while the euro or pound amount owed on it is not known at the sale.
 * Pure but for nothing: no IO.
 *
 * Unit 2 (coordinator C5-20261120-2130): the UK, the same way, with the "UK" record and UK_VAT_COLLECT_REVIEWED's whole
 * switch (ukVatCollectOn), decided by lib/uk-vat.ts ukCheckout (two agreeing items placing the buyer in GB, an
 * electronically supplied service, the rate read before UK_VAT_RATE_VALID_UNTIL) and collected at the UK rate on the
 * line's real amount, marked `uk_vat`, never `eu_vat`, so neither return reads the other's sale. Two more unknowns
 * refuse, never collect zero: whether the product is an e-publication (zero-rated in the UK; since unit 5a the
 * creator's own answer on each product, lib/catalog.ts Product.publication, read by notAPublication), and the sterling
 * rate of a sale in another currency (VAT Notice 700, 7.6). Since unit 7 that rate is HMRC's period rate for the
 * supply's month (lib/hmrc-period-rates.ts): with a row, a sale in another store currency written in hundredths is
 * collected at 20% in its own currency and its sterling VAT kept as `uk_vat_gbp`, only while the checkout cannot be paid
 * in another month, and only with a reviewed allowance for the gap between that period rate and the market rate on the
 * sale (lib/eu-vat-collection-cost.ts, `against: "gbp"`). HMRC's rates for November and December 2026 are read; what
 * keeps every such sale closed today is REVIEWED_VAT_FX_ALLOWANCES, empty, and the switches, off.
 */
import { EU_UK_REFUSED, consumerGate } from "@/lib/eu-vat-gate";
import { type EuSupplyFields, euSupplyOf } from "@/lib/eu-vat-supply";
import { checkoutEvidence } from "@/lib/eu-vat-evidence";
import { euCheckout } from "@/lib/eu-vat-checkout";
import { EU_VAT_RATES, type EuVatRate, type VatOnTop, vatOnTop } from "@/lib/eu-vat-amount";
import { applyEuVatLines } from "@/lib/eu-vat-lines";
import { euVatCollectionCostCents } from "@/lib/eu-vat-collection-cost";
import { UK_VAT_RATE_VALID_UNTIL, toPence, ukCheckout, ukVatOnTop } from "@/lib/uk-vat";
import { HMRC_PERIOD_RATES, type HmrcPeriodRate, hmrcPeriodRate } from "@/lib/hmrc-period-rates";
import { decimalsOf, isCurrency } from "@/lib/money";
import { type SwitchInput, vatCollecting } from "@/lib/vat-registrations";

/** What the checkout route does with the buyer before anything is held: go on, collect EU VAT, or refuse. */
export type EuSaleGate =
  | { ok: true; collect: null }
  | { ok: true; collect: { country: string } }
  | { ok: false; reason: "refused" | "billing"; message: string };

/** Refused before Stripe is asked: the EU VAT this sale needs could not be put on it (thrown by applyEuCollect). */
export class EuVatCollectRefused extends Error {
  constructor(why: string) {
    super(`EU VAT could not be collected on this checkout: ${why}`);
    this.name = "EuVatCollectRefused";
  }
}

/**
 * The cost of receiving one sale's EU or UK VAT through the platform's fee, in the charge's currency, part by part from
 * lib/receiving-costs.ts (lib/eu-vat-collection-cost.ts, 789 [IV1] step 3, unit 6). The exchange-rate movement until
 * the return is paid has no reviewed allowance yet, so it answers null, which refuses. Never zero.
 */
export { euVatCollectionCostCents };

/** Whether the EU may be collected now: the EU record says "collect" and the whole switch is on (lib/vat-registrations.ts, vatCollecting). */
function collectingEu(records: unknown, vatSwitch: Omit<SwitchInput, "now"> | undefined, now: Date): boolean {
  return vatCollecting("EU", records, { ...(vatSwitch ?? {}), now });
}

/** Whether the UK may be collected now: the UK record says "collect" and the UK's whole switch is on. */
function collectingUk(records: unknown, vatSwitch: Omit<SwitchInput, "now"> | undefined, now: Date): boolean {
  return vatCollecting("UK", records, { ...(vatSwitch ?? {}), now });
}

/**
 * Unit 5a (Claude 5 ibqho's LEVE on #5008): whether the creator answered, on the product itself, that it is not an
 * electronically supplied publication, and so did every member of a bundle. Anything else (not answered, answered that
 * it is one, a member missing) is false, so EU and UK VAT are never collected on a guess. Read per product, so a cart
 * holding an e-book beside a course is refused, and one answer never stands for another product.
 */
export function notAPublication(product: EuSupplyFields, members?: ReadonlyMap<string, EuSupplyFields>): boolean {
  if (!product || product.publication !== false) return false;
  if (product.bundle === null || product.bundle === undefined) return true;
  if (!Array.isArray(product.bundle) || product.bundle.length === 0 || !members) return false;
  return product.bundle.every((id) => typeof id === "string" && members.get(id)?.publication === false);
}

/**
 * The checkout route's EU and UK gate. `records`, `vatSwitch`, `now` and `rates` are for tests only: the route passes
 * none of them, so it reads DEEMED_SUPPLIER_RECORDS, the reviewed switches, the clock and the official rate table.
 * Whether the product is an e-publication is the creator's own answer on the product (and on every bundle member):
 * see notAPublication.
 */
export function euSaleGate(input: {
  product: EuSupplyFields;
  members?: ReadonlyMap<string, EuSupplyFields>;
  headers: Headers;
  form: URLSearchParams | FormData;
  records?: unknown;
  vatSwitch?: Omit<SwitchInput, "now">;
  now?: Date;
  rates?: readonly EuVatRate[];
}): EuSaleGate {
  const base = consumerGate({ product: input.product, members: input.members, headers: input.headers, form: input.form });
  const now = input.now ?? new Date();
  const eu = collectingEu(input.records, input.vatSwitch, now);
  const uk = collectingUk(input.records, input.vatSwitch, now);
  // Not collecting: exactly consumerGate, so the checkout is what it is today.
  if (!eu && !uk) return base.ok ? { ok: true, collect: null } : base;
  // A buyer consumerGate lets through is outside the EU and the UK; one with no billing country is asked for it.
  if (base.ok) return { ok: true, collect: null };
  if (base.reason === "billing") return base;
  // The same decision euCheckoutGate makes (lib/eu-vat-gate.ts), asked with this gate's own switch and clock: two
  // agreeing items of evidence, an electronically supplied service and a sourced rate. Only "collect" collects; every
  // other answer (the UK, evidence that disagrees or is missing, goods, a live service, no rate, the review) keeps
  // consumerGate's refusal, as today.
  const supply = euSupplyOf(input.product, input.members);
  const items = checkoutEvidence(input.headers, input.form);
  // Unit 4: the EU collects only for a product explicitly classified as not an e-publication (Directive 2006/112/EC
  // annex III, point 6, lets a Member State tax those at a reduced rate, and EU_VAT_RATES holds only the standard rate):
  // an e-publication or an unclassified product keeps the refusal, never the standard rate on a guess (TX policy).
  const answered = notAPublication(input.product, input.members);
  if (eu && answered) {
    const answer = euCheckout({ supply, priceCents: input.product.priceCents, items, rates: input.rates, records: input.records, vatSwitch: input.vatSwitch, now });
    if (answer.kind === "collect" && answer.vat.country === answer.place.country) return { ok: true, collect: { country: answer.place.country } };
  }
  // The UK (lib/uk-vat.ts ukCheckout): both items in GB, an electronically supplied service that is not an
  // e-publication, the switch and the rate's review date. Every other answer keeps consumerGate's refusal.
  if (uk) {
    const answer = ukCheckout({ supply, priceCents: input.product.priceCents, items, vatSwitch: input.vatSwitch, now, publication: answered ? false : undefined });
    if (answer.kind === "collect" && answer.place.evidence.ip === "GB") return { ok: true, collect: { country: "GB" } };
  }
  return base;
}

/**
 * The cart route's gate (app/api/store/cart/route.ts), one product at a time as euSaleGate decides each: the first
 * refusal is the cart's, exactly as the route's loop over consumerGate returns it today. A cart collects only when every
 * product that needs VAT names the same country; products that disagree refuse the cart. Test inputs as euSaleGate's.
 *
 * A bundle in a cart is refused for now, even when the same bundle bought alone would be collected (Claude 6's LEVE on
 * #5014): the cart route does not read the bundle's members, so notAPublication cannot see their answers and stays
 * false. Reading them would add a read to every cart checkout with a bundle, a cost change for its own reviewed unit;
 * until then a bundle in a cart is refused, never collected on a guess.
 */
export function euCartGate(input: {
  products: readonly EuSupplyFields[];
  headers: Headers;
  form: URLSearchParams | FormData;
  records?: unknown;
  vatSwitch?: Omit<SwitchInput, "now">;
  now?: Date;
  rates?: readonly EuVatRate[];
}): EuSaleGate {
  let collect: { country: string } | null = null;
  for (const product of input.products) {
    const gate = euSaleGate({ ...input, product });
    if (!gate.ok) return gate;
    if (gate.collect === null) continue;
    if (collect !== null && collect.country !== gate.collect.country) {
      return { ok: false, reason: "refused", message: EU_UK_REFUSED };
    }
    collect = gate.collect;
  }
  return collect === null ? { ok: true, collect: null } : { ok: true, collect };
}

/**
 * Puts the EU VAT on a built one-off checkout body, after the share is set and before Stripe is asked; throws
 * EuVatCollectRefused, with the body untouched, when it cannot. `costsCents`, `now` and `rates` are for tests only.
 */
export function applyEuCollect(
  body: URLSearchParams,
  input: {
    country: string;
    /** Set by createCheckout: the line is the creator's choose-your-price Price, whose amount is the buyer's to type. */
    chooseYourPrice: boolean;
    /** Set by createCheckout: lib/buyer-currency.ts BUYER_CURRENCY_LIVE, which would convert the amount after this. */
    buyerCurrencyLive: boolean;
    costsCents?: (vatCents: number, currency: string, returnCurrency?: string) => number | null;
    now?: Date;
    rates?: readonly EuVatRate[];
    /** Tests only: HMRC's period rates (lib/hmrc-period-rates.ts) instead of HMRC_PERIOD_RATES. */
    sterlingRates?: readonly HmrcPeriodRate[];
  },
): void {
  collectOn(body, input, false);
}

/**
 * Unit 3 (the owner's order to Claude 4 5BC, 21/11/2026 about 00h55 UTC, "faça vc o correto"; CLAIMED 7054618378):
 * the same VAT on a built cart checkout body (lib/cart-checkout.ts), after the share, the tax settings and the currency
 * are set and before Stripe is asked. Every line is one product at quantity one, in one currency, at an amount of
 * ours; the VAT is worked out once on their sum, at the one country's rate, and added as one line through one fee.
 * Anything else (a code or a code box, shipping, a currency conversion) refuses with the body untouched.
 */
export function applyEuCollectCart(
  body: URLSearchParams,
  input: {
    country: string;
    /** Set by createCartCheckout: lib/buyer-currency.ts BUYER_CURRENCY_LIVE, which would convert the amounts after this. */
    buyerCurrencyLive: boolean;
    costsCents?: (vatCents: number, currency: string, returnCurrency?: string) => number | null;
    now?: Date;
    rates?: readonly EuVatRate[];
    /** Tests only: HMRC's period rates (lib/hmrc-period-rates.ts) instead of HMRC_PERIOD_RATES. */
    sterlingRates?: readonly HmrcPeriodRate[];
  },
): void {
  collectOn(body, { ...input, chooseYourPrice: false }, true);
}

/** Both bodies: every check before anything is written, then applyEuVatLines writes the VAT line and the fee. */
function collectOn(
  body: URLSearchParams,
  input: {
    country: string;
    chooseYourPrice: boolean;
    buyerCurrencyLive: boolean;
    costsCents?: (vatCents: number, currency: string, returnCurrency?: string) => number | null;
    now?: Date;
    rates?: readonly EuVatRate[];
    /** Tests only: HMRC's period rates (lib/hmrc-period-rates.ts) instead of HMRC_PERIOD_RATES. */
    sterlingRates?: readonly HmrcPeriodRate[];
  },
  cart: boolean,
): void {
  const refuse = (why: string): never => {
    throw new EuVatCollectRefused(why);
  };
  if (!/^[A-Z]{2}$/.test(input.country)) refuse("country");
  if (input.chooseYourPrice) refuse("a price the buyer chooses");
  if (input.buyerCurrencyLive) refuse("a conversion to the buyer's currency");
  if (body.get("mode") !== "payment") refuse("not a one-off payment");
  const keys = [...body.keys()];
  // The lines, numbered from 0 with no gap: one on a one-off checkout, one to four in a cart.
  const indexes = new Set<number>();
  for (const key of keys) {
    const line = /^line_items\[(\d+)\]/.exec(key);
    if (line) indexes.add(Number(line[1]));
  }
  const count = indexes.size;
  if (count === 0 || [...indexes].some((index) => index >= count)) refuse("the lines");
  if (!cart && count !== 1) refuse("more than one line");
  if (cart && count > 4) refuse("more lines than a cart holds");
  if (keys.some((key) => key.startsWith("discounts[") || key === "allow_promotion_codes")) refuse("a discount or a promotion box");
  if (keys.some((key) => key.startsWith("shipping_") || key.startsWith("subscription_data["))) refuse("shipping or a subscription");
  // Stripe's conversion stays off as inTheCurrencyShown sets it (lib/instant-pay.ts); anything else changes the amount.
  if (body.get("adaptive_pricing[enabled]") !== "false") refuse("a conversion to the buyer's currency");
  let total = 0;
  let currency = "";
  for (let i = 0; i < count; i += 1) {
    if (body.get(`line_items[${i}][quantity]`) !== "1") refuse("a quantity other than one");
    if (body.has(`line_items[${i}][price]`)) refuse("a Stripe Price instead of an amount");
    const amount = body.get(`line_items[${i}][price_data][unit_amount]`) ?? "";
    const lineCurrency = body.get(`line_items[${i}][price_data][currency]`) ?? "";
    if (!/^(0|[1-9]\d{0,14})$/.test(amount) || !/^[a-z]{3}$/i.test(lineCurrency)) refuse("the line's amount or currency");
    if (i > 0 && lineCurrency.toLowerCase() !== currency.toLowerCase()) refuse("lines in different currencies");
    currency = lineCurrency;
    total += Number(amount);
  }
  if (!Number.isSafeInteger(total)) refuse("the lines' total");
  const now = input.now ?? new Date();
  const uk = input.country === "GB" ? ukVat(total, currency, now, input.sterlingRates ?? HMRC_PERIOD_RATES, body.get("expires_at")) : null;
  const vat = input.country === "GB" ? uk?.vat ?? null : vatOnTop(total, input.country, input.rates ?? EU_VAT_RATES, now);
  if (!vat || vat.country !== input.country) refuse("no sourced rate, or no sterling rate");
  // A UK sale is declared to HMRC in pounds whatever it was charged in, so its exchange-rate allowance is the pound's
  // (unit 7). An EU sale is declared in the non-Union scheme's return in euros (Directive 2006/112/EC art. 365: the
  // return is made out in euro, and a Member State of identification outside the euro area may require its own
  // currency; Ireland and Estonia are both in the euro area), so its return currency is the euro: a sale charged in
  // pounds or any other currency needs its own reviewed allowance against the euro for the gap to the period rate, and
  // without one it is refused (#5086, Claude 1 f9afa7's second point; coordinator's decision dad8, option 1). Not
  // re-read at the official source on 22 November 2026: eur-lex.europa.eu does not resolve from the session that wrote
  // this; to be read again, with its date, before opening. The refusal stands either way.
  const cost = (input.costsCents ?? euVatCollectionCostCents)(vat!.vatCents, currency, input.country === "GB" ? "gbp" : "eur");
  if (cost === null || !Number.isSafeInteger(cost) || cost < 0) refuse("the cost of receiving the VAT is unknown");
  const mark = input.country === "GB" ? "uk_vat" : "eu_vat";
  if (applyEuVatLines(body, { vat: vat!, recurring: false, vatCostsCents: cost, currency, mark }) !== "ok") refuse("the VAT line");
  // The sale's VAT in sterling at HMRC's period rate, kept on the payment beside `uk_vat` for the invoice and the VAT
  // Return (VAT Notice 700/21, 4.1: "expressed in sterling"): pence, the rate as HMRC wrote it, and its month.
  if (uk?.sterling) body.set("payment_intent_data[metadata][uk_vat_gbp]", `${uk.sterling.pence}:${uk.sterling.perPound}:${uk.sterling.month}`);
}

/**
 * The UK VAT on a line, at the rate read on gov.uk while it is not past UK_VAT_RATE_VALID_UNTIL; null otherwise. A sale
 * in pounds is itself in sterling. A sale in another store currency written in hundredths is charged at 20% in its own
 * currency, and its VAT stated in sterling at HMRC's period rate for the supply's month (VAT Notice 700, 7.6;
 * lib/hmrc-period-rates.ts): no row for that month and currency, or a currency not in hundredths, is null (unit 7).
 */
function ukVat(amountCents: number, currency: string, now: Date, table: readonly HmrcPeriodRate[], expiresAt: string | null): { vat: VatOnTop; sterling: { pence: number; perPound: string; month: string } | null } | null {
  if (!Number.isFinite(now.getTime())) return null;
  const today = now.toISOString().slice(0, 10);
  if (today > UK_VAT_RATE_VALID_UNTIL) return null;
  const vat = ukVatOnTop(amountCents);
  if (!vat) return null;
  const code = currency.toLowerCase();
  if (code === "gbp") return { vat: { ...vat, country: "GB" }, sterling: null };
  if (!isCurrency(code) || decimalsOf(code) !== 2) return null;
  // The rate is the one of the month the buyer pays in (Notice 700, 7.6: "current at the time of the supply"), and
  // the checkout is opened now: it is collected only while it cannot be paid in another month. Without its own
  // `expires_at`, a Stripe Checkout Session stays open 24 hours (Claude 1's LOW on #5032).
  const closes = expiresAt === null ? now.getTime() + 86_400_000 : /^[1-9]\d{0,11}$/.test(expiresAt) ? Number(expiresAt) * 1000 : Number.NaN;
  if (!Number.isFinite(closes) || closes < now.getTime()) return null;
  // The month is the UK's (Claude 2's LOW on #5032): in summer time the last hour of a UTC month is already the next
  // month in London. Both ends must fall in one month in London and in UTC alike, so the rate never depends on which.
  const opened = ukDay(now.getTime());
  const shut = ukDay(closes);
  if (!opened || !shut) return null;
  const month = opened.slice(0, 7);
  if (shut.slice(0, 7) !== month || today.slice(0, 7) !== month || new Date(closes).toISOString().slice(0, 7) !== month) return null;
  const rate = hmrcPeriodRate(code, opened, table);
  const pence = rate ? toPence(vat.vatCents, rate.perPound) : null;
  if (!rate || pence === null) return null;
  return { vat: { ...vat, country: "GB" }, sterling: { pence, perPound: rate.perPound, month } };
}

/** The calendar day in the UK (Europe/London) at an instant, as YYYY-MM-DD; null when it cannot be read. */
function ukDay(ms: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  } catch {
    return null;
  }
}
