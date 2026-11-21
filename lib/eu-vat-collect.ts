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
 */
import { consumerGate } from "@/lib/eu-vat-gate";
import { type EuSupplyFields, euSupplyOf } from "@/lib/eu-vat-supply";
import { checkoutEvidence } from "@/lib/eu-vat-evidence";
import { euCheckout } from "@/lib/eu-vat-checkout";
import { EU_VAT_RATES, type EuVatRate, vatOnTop } from "@/lib/eu-vat-amount";
import { applyEuVatLines } from "@/lib/eu-vat-lines";
import { recordedTreatment } from "@/lib/deemed-supplier";
import { type SwitchInput, euVatCollectOn } from "@/lib/vat-registrations";

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

/**
 * The checkout route's EU gate. `records`, `vatSwitch`, `now` and `rates` are for tests only: the route passes none of
 * them, so it reads DEEMED_SUPPLIER_RECORDS, the reviewed switch, the clock and the official rate table.
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
  // Not collecting: exactly consumerGate, so the checkout is what it is today.
  if (!collectingEu(input.records, input.vatSwitch, now)) return base.ok ? { ok: true, collect: null } : base;
  // A buyer consumerGate lets through is outside the EU and the UK; one with no billing country is asked for it.
  if (base.ok) return { ok: true, collect: null };
  if (base.reason === "billing") return base;
  // The same decision euCheckoutGate makes (lib/eu-vat-gate.ts), asked with this gate's own switch and clock: two
  // agreeing items of evidence, an electronically supplied service and a sourced rate. Only "collect" collects; every
  // other answer (the UK, evidence that disagrees or is missing, goods, a live service, no rate, the review) keeps
  // consumerGate's refusal, as today.
  const answer = euCheckout({
    supply: euSupplyOf(input.product, input.members),
    priceCents: input.product.priceCents,
    items: checkoutEvidence(input.headers, input.form),
    rates: input.rates,
    records: input.records,
    vatSwitch: input.vatSwitch,
    now,
  });
  if (answer.kind === "collect" && answer.vat.country === answer.place.country) return { ok: true, collect: { country: answer.place.country } };
  return base;
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
  const refuse = (why: string): never => {
    throw new EuVatCollectRefused(why);
  };
  if (!/^[A-Z]{2}$/.test(input.country)) refuse("country");
  if (input.chooseYourPrice) refuse("a price the buyer chooses");
  if (input.buyerCurrencyLive) refuse("a conversion to the buyer's currency");
  if (body.get("mode") !== "payment") refuse("not a one-off payment");
  const keys = [...body.keys()];
  if (keys.some((key) => /^line_items\[[1-9]\d*\]/.test(key))) refuse("more than one line");
  if (body.get("line_items[0][quantity]") !== "1") refuse("a quantity other than one");
  if (body.has("line_items[0][price]")) refuse("a Stripe Price instead of an amount");
  if (keys.some((key) => key.startsWith("discounts[") || key === "allow_promotion_codes")) refuse("a discount or a promotion box");
  if (keys.some((key) => key.startsWith("shipping_") || key.startsWith("subscription_data["))) refuse("shipping or a subscription");
  // Stripe's conversion stays off as inTheCurrencyShown sets it (lib/instant-pay.ts); anything else changes the amount.
  if (body.get("adaptive_pricing[enabled]") !== "false") refuse("a conversion to the buyer's currency");
  const amount = body.get("line_items[0][price_data][unit_amount]") ?? "";
  const currency = body.get("line_items[0][price_data][currency]") ?? "";
  if (!/^(0|[1-9]\d{0,14})$/.test(amount) || !/^[a-z]{3}$/i.test(currency)) refuse("the line's amount or currency");
  const now = input.now ?? new Date();
  const vat = vatOnTop(Number(amount), input.country, input.rates ?? EU_VAT_RATES, now);
  if (!vat || vat.country !== input.country) refuse("no sourced rate");
  const cost = (input.costsCents ?? euVatCollectionCostCents)(vat!.vatCents, currency);
  if (cost === null || !Number.isSafeInteger(cost) || cost < 0) refuse("the cost of receiving the VAT is unknown");
  if (applyEuVatLines(body, { vat: vat!, recurring: false, vatCostsCents: cost, currency }) !== "ok") refuse("the VAT line");
}
