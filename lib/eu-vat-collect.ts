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
 * (EuVatCollectRefused). The cost of receiving the VAT (the conversion of the fee, the exchange-rate ceiling until the
 * return, the remittance) has no reviewed figure yet (789 [IV1] step 2): euVatCollectionCostCents answers null, so
 * even with the switch on, every sale would be refused until that figure is reviewed. Pure but for nothing: no IO.
 *
 * Unit 2 (coordinator C5-20261120-2130): the UK, the same way, with the "UK" record and UK_VAT_COLLECT_REVIEWED's whole
 * switch (ukVatCollectOn), decided by lib/uk-vat.ts ukCheckout (two agreeing items placing the buyer in GB, an
 * electronically supplied service, the rate read before UK_VAT_RATE_VALID_UNTIL) and collected at the UK rate on the
 * line's real amount, marked `uk_vat`, never `eu_vat`, so neither return reads the other's sale. Two more unknowns
 * refuse, never collect zero: whether the product is an e-publication (zero-rated in the UK; no product carries that
 * classification yet, so ukCheckout refuses every UK sale), and the sterling rate of a sale in another currency (HMRC's
 * rate at the time of the supply, VAT Notice 700, 7.6, is not read here), so only a sale in pounds can collect.
 */
import { EU_UK_REFUSED, consumerGate } from "@/lib/eu-vat-gate";
import { type EuSupplyFields, euSupplyOf } from "@/lib/eu-vat-supply";
import { checkoutEvidence } from "@/lib/eu-vat-evidence";
import { euCheckout } from "@/lib/eu-vat-checkout";
import { EU_VAT_RATES, type EuVatRate, type VatOnTop, vatOnTop } from "@/lib/eu-vat-amount";
import { applyEuVatLines } from "@/lib/eu-vat-lines";
import { recordedTreatment } from "@/lib/deemed-supplier";
import { UK_VAT_RATE_VALID_UNTIL, ukCheckout, ukVatOnTop } from "@/lib/uk-vat";
import { type SwitchInput, euVatCollectOn, ukVatCollectOn } from "@/lib/vat-registrations";

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
 * The cost of receiving one sale's EU VAT through the platform's fee, in the charge's currency: the conversion of the
 * fee, the exchange-rate ceiling until the OSS return and the remittance. No reviewed figure yet (789 [IV1] step 2):
 * null, which refuses. Never zero.
 */
export const euVatCollectionCostCents: (vatCents: number, currency: string) => number | null = () => null;

/** Whether the EU may be collected now: the EU record says "collect" and the whole switch (lib/vat-registrations.ts) is on. */
function collectingEu(records: unknown, vatSwitch: Omit<SwitchInput, "now"> | undefined, now: Date): boolean {
  return recordedTreatment("EU", records) === "collect" && euVatCollectOn({ ...(vatSwitch ?? {}), now }) === true;
}

/** Whether the UK may be collected now: the UK record says "collect" and the UK's whole switch is on. */
function collectingUk(records: unknown, vatSwitch: Omit<SwitchInput, "now"> | undefined, now: Date): boolean {
  return recordedTreatment("UK", records) === "collect" && ukVatCollectOn({ ...(vatSwitch ?? {}), now }) === true;
}

/**
 * The checkout route's EU and UK gate. `records`, `vatSwitch`, `now`, `rates` and `publication` are for tests only: the
 * route passes none of them, so it reads DEEMED_SUPPLIER_RECORDS, the reviewed switches, the clock and the official
 * rate table, and no product is classified as an e-publication or not (so no EU or UK sale collects).
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
  /**
   * Whether the product is an e-publication (zero-rated in the UK, possibly reduced-rated in a Member State): only an
   * explicit `false` lets EU or UK VAT be collected. No product carries the classification yet, so nothing collects.
   */
  publication?: boolean;
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
  if (eu && input.publication === false) {
    const answer = euCheckout({ supply, priceCents: input.product.priceCents, items, rates: input.rates, records: input.records, vatSwitch: input.vatSwitch, now });
    if (answer.kind === "collect" && answer.vat.country === answer.place.country) return { ok: true, collect: { country: answer.place.country } };
  }
  // The UK (lib/uk-vat.ts ukCheckout): both items in GB, an electronically supplied service that is not an
  // e-publication, the switch and the rate's review date. Every other answer keeps consumerGate's refusal.
  if (uk) {
    const answer = ukCheckout({ supply, priceCents: input.product.priceCents, items, vatSwitch: input.vatSwitch, now, publication: input.publication });
    if (answer.kind === "collect" && answer.place.evidence.ip === "GB") return { ok: true, collect: { country: "GB" } };
  }
  return base;
}

/**
 * The cart route's gate (app/api/store/cart/route.ts), one product at a time as euSaleGate decides each: the first
 * refusal is the cart's, exactly as the route's loop over consumerGate returns it today. A cart collects only when every
 * product that needs VAT names the same country; products that disagree refuse the cart. Test inputs as euSaleGate's.
 */
export function euCartGate(input: {
  products: readonly EuSupplyFields[];
  headers: Headers;
  form: URLSearchParams | FormData;
  records?: unknown;
  vatSwitch?: Omit<SwitchInput, "now">;
  now?: Date;
  rates?: readonly EuVatRate[];
  publication?: boolean;
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
    costsCents?: (vatCents: number, currency: string) => number | null;
    now?: Date;
    rates?: readonly EuVatRate[];
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
    costsCents?: (vatCents: number, currency: string) => number | null;
    now?: Date;
    rates?: readonly EuVatRate[];
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
    costsCents?: (vatCents: number, currency: string) => number | null;
    now?: Date;
    rates?: readonly EuVatRate[];
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
  const vat = input.country === "GB" ? ukVat(total, currency, now) : vatOnTop(total, input.country, input.rates ?? EU_VAT_RATES, now);
  if (!vat || vat.country !== input.country) refuse("no sourced rate, or no sterling rate");
  const cost = (input.costsCents ?? euVatCollectionCostCents)(vat!.vatCents, currency);
  if (cost === null || !Number.isSafeInteger(cost) || cost < 0) refuse("the cost of receiving the VAT is unknown");
  const mark = input.country === "GB" ? "uk_vat" : "eu_vat";
  if (applyEuVatLines(body, { vat: vat!, recurring: false, vatCostsCents: cost, currency, mark }) !== "ok") refuse("the VAT line");
}

/**
 * The UK VAT on a line, at the rate read on gov.uk while it is not past UK_VAT_RATE_VALID_UNTIL; null otherwise, and
 * null for a sale in any currency but pounds: its VAT must be stated in sterling at HMRC's rate at the time of the
 * supply (VAT Notice 700, 7.6), which is not read here.
 */
function ukVat(amountCents: number, currency: string, now: Date): VatOnTop | null {
  if (currency.toLowerCase() !== "gbp") return null;
  if (!Number.isFinite(now.getTime()) || now.toISOString().slice(0, 10) > UK_VAT_RATE_VALID_UNTIL) return null;
  const vat = ukVatOnTop(amountCents);
  return vat ? { ...vat, country: "GB" } : null;
}
