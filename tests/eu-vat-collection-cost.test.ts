/**
 * 789 [IV1] step 3, unit 6 (coordinator, 21/11/2026 06:17 UTC: unit A, the dearest reading): what receiving one sale's
 * EU or UK VAT through the platform's fee costs Marktmorgen (lib/eu-vat-collection-cost.ts), read by
 * lib/eu-vat-collect.ts as euVatCollectionCostCents. It holds that:
 *   - every part is a percentage of the VAT taken from lib/receiving-costs.ts, rounded up; no figure is typed here;
 *   - the fee carries the VAT and Marktmorgen's own costs of receiving it, never the processing fee on the VAT part:
 *     in a direct charge Stripe already takes that from the creator's account, so the fee would charge it twice
 *     (coordinator, 06:20 UTC); it is a separate part, counted only in Marktmorgen's worst case;
 *   - the exchange-rate movement until the return is paid has no reviewed allowance, so with the real values the cost
 *     is unknown (null) and every collection is refused, never collected at zero;
 *   - with a reviewed allowance injected here only, the cost is the sum of its parts and never zero on a positive VAT;
 *     an allowance not in force, without an https source or out of range is never read; two in force: the dearer;
 *   - only euros and pounds are read; any other currency, or a VAT amount that is not a whole cent count, is unknown.
 * Synthetic data only.
 */
import { DISPUTE_RESERVE_BPS, PROVIDER_FEES, REFUND_RESERVE_BPS, REMITTANCE_BPS } from "@/lib/receiving-costs";
import { REVIEWED_VAT_FX_ALLOWANCES, type VatFxAllowance, euVatCollectionCostCents as fromModule, vatCollectionCostOf } from "@/lib/eu-vat-collection-cost";
import { applyEuCollect, euVatCollectionCostCents } from "@/lib/eu-vat-collect";
import { vatOnTop } from "@/lib/eu-vat-amount";
import { euVatOnRefund } from "@/lib/eu-vat-refund";
import { done, is, part } from "./check";

const NOW = new Date("2026-12-01T12:00:00Z");
const RATES = [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-20" }];
const EUR: VatFxAllowance = { currency: "eur", bps: 300, source: "https://example.invalid/fx-eur", checkedOn: "2026-11-20", validThrough: "2027-03-31" };
const GBP: VatFxAllowance = { ...EUR, currency: "gbp", bps: 400, source: "https://example.invalid/fx-gbp" };
const up = (cents: number, bps: number) => Math.ceil((cents * bps) / 10_000);
const s = PROVIDER_FEES.stripe;
const processing = (vat: number) => Math.max(up(vat, s.cardBps) + up(vat, s.internationalBps) + up(vat, s.conversionBps) + up(vat, s.billingBps) + up(vat, s.taxBps), up(vat, PROVIDER_FEES.paddle.bps));
/** What the fee carries beside the VAT: the conversion, the exchange-rate allowance, paying the return, the reserves. */
const expected = (vat: number, fxBps: number) => up(vat, s.conversionBps) + up(vat, fxBps) + up(vat, REMITTANCE_BPS) + up(vat, REFUND_RESERVE_BPS) + up(vat, DISPUTE_RESERVE_BPS);

function main(): void {
  part("Today: no reviewed allowance, so unknown and refused");
  is("no allowance is reviewed", REVIEWED_VAT_FX_ALLOWANCES.length, 0);
  is("the EU VAT on a sale: unknown, never zero", euVatCollectionCostCents(551, "eur"), null);
  is("the UK VAT on a sale: unknown, never zero", euVatCollectionCostCents(480, "gbp"), null);
  is("the checkout reads this module's figure, the same function", euVatCollectionCostCents === fromModule, true);

  part("With a reviewed allowance, injected here only: the sum of its parts");
  const eu = vatCollectionCostOf(551, "eur", [EUR], NOW);
  is("the fee's part: each part from lib/receiving-costs.ts, rounded up", eu?.feeCents, expected(551, EUR.bps));
  is("the fee's parts add up", eu ? eu.conversionCents + eu.fxCents + eu.returnPaymentCents + eu.refundReserveCents + eu.disputeReserveCents : null, eu?.feeCents);
  is("the processing fee on the VAT part: the dearer provider's percentages, no fixed fee", eu?.processingCents, processing(551));
  is("never in the fee: the creator's account already pays it to Stripe", eu ? eu.feeCents + eu.processingCents === eu.worstCaseCents && eu.processingCents > 0 : null, true);
  is("Marktmorgen's worst case counts it, as if it gave it back", eu?.worstCaseCents, expected(551, EUR.bps) + processing(551));
  const fee = (cost: (vat: number, currency: string) => number | null) => {
    const body = new URLSearchParams({ mode: "payment", "adaptive_pricing[enabled]": "false", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "eur", "line_items[0][price_data][unit_amount]": "2900", "line_items[0][price_data][product_data][name]": "Pack" });
    applyEuCollect(body, { country: "DE", chooseYourPrice: false, buyerCurrencyLive: false, costsCents: cost, now: NOW, rates: RATES });
    return Number(body.get("payment_intent_data[application_fee_amount]"));
  };
  const vat = vatOnTop(2900, "DE", RATES, NOW)!.vatCents;
  is("the checkout's fee: the VAT and the fee's part, never the processing part", fee((v, c) => vatCollectionCostOf(v, c, [EUR], NOW)?.feeCents ?? null), vat + expected(vat, EUR.bps));
  is("and the checkout's own figure is the fee's part", fee((v, c) => vatCollectionCostOf(v, c, [EUR], NOW)?.feeCents ?? null) < vat + (vatCollectionCostOf(vat, "eur", [EUR], NOW)?.worstCaseCents ?? 0), true);
  is("the currency is read in any case", vatCollectionCostOf(551, "EUR", [EUR], NOW)?.feeCents, expected(551, EUR.bps));
  is("pounds read the pound allowance", vatCollectionCostOf(480, "gbp", [EUR, GBP], NOW)?.feeCents, expected(480, GBP.bps));
  is("never zero on a positive VAT, even one cent", (vatCollectionCostOf(1, "eur", [EUR], NOW)?.feeCents ?? 0) > 0, true);
  is("a large VAT stays a whole cent count", Number.isSafeInteger(vatCollectionCostOf(9_000_000_000, "eur", [EUR], NOW)?.worstCaseCents), true);
  is("two allowances in force: the dearer", vatCollectionCostOf(551, "eur", [EUR, { ...EUR, bps: 500 }], NOW)?.feeCents, expected(551, 500));

  part("Never read: an allowance not in force or malformed");
  const refused: [string, VatFxAllowance][] = [
    ["not yet in force", { ...EUR, checkedOn: "2026-12-02" }],
    ["past its last day", { ...EUR, validThrough: "2026-11-30" }],
    ["no https source", { ...EUR, source: "http://example.invalid/fx" }],
    ["zero", { ...EUR, bps: 0 }],
    ["above the whole VAT", { ...EUR, bps: 10_001 }],
    ["not a whole number", { ...EUR, bps: 2.5 }],
    ["a day that is not a day", { ...EUR, validThrough: "2027-02-31x" }],
    ["another currency's", { ...EUR, currency: "gbp" }],
  ];
  for (const [label, allowance] of refused) is(`${label}: unknown`, vatCollectionCostOf(551, "eur", [allowance], NOW), null);

  part("Unknown currency or amount");
  for (const currency of ["usd", "chf", "", "euro"]) is(`currency "${currency}": unknown`, vatCollectionCostOf(551, currency, [EUR, GBP], NOW), null);
  for (const vat of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) is(`VAT ${String(vat)}: unknown`, vatCollectionCostOf(vat, "eur", [EUR], NOW), null);
  is("an unreadable clock: unknown", vatCollectionCostOf(551, "eur", [EUR], new Date(Number.NaN)), null);

  part("Rounding and refunds (coordinator, 06:47 UTC)");
  const feeOf = (vat: number) => vatCollectionCostOf(vat, "eur", [EUR], NOW)!;
  let sub = true, monotonic = true, split = true;
  for (let vat = 1; vat <= 3_000; vat += 1) {
    const c = feeOf(vat);
    // A VAT below one cent of each part still costs one whole cent of each: rounded up, never to zero.
    if ([c.conversionCents, c.fxCents, c.returnPaymentCents, c.refundReserveCents, c.disputeReserveCents, c.processingCents].some((cents) => cents < 1)) sub = false;
    if (vat > 1 && c.feeCents < feeOf(vat - 1).feeCents) monotonic = false;
    // Two parts of a VAT never cost less, together, than the whole: what one sale takes is never short of its pieces.
    const half = Math.floor(vat / 2);
    if (half > 0 && feeOf(half).feeCents + feeOf(vat - half).feeCents < c.feeCents) split = false;
  }
  is("a VAT of 1 to 3,000 cents: every part at least one cent", sub, true);
  is("a larger VAT never costs less", monotonic, true);
  is("a VAT split in two never costs less than the whole", split, true);
  const sale = { priceCents: 2900, vatCents: 551, totalCents: 3451 };
  let covered = true, back = 0, refunded = 0;
  for (const refundCents of [1, 500, 1200, 1750]) {
    const refund = euVatOnRefund(sale, { refundCents, refundedBeforeCents: refunded, vatBackBeforeCents: back, kind: "refund" });
    if (!refund) { covered = false; break; }
    back += refund.vatBackCents;
    refunded += refundCents;
    // After each partial refund the VAT still held costs no more than what the sale's fee already took.
    if (feeOf(sale.vatCents - back).feeCents > feeOf(sale.vatCents).feeCents) covered = false;
  }
  is("partial refunds, down to the last cent: the VAT left never needs more than the sale took", [covered, back, refunded], [true, 551, 3451]);
  is("a lost dispute gives no VAT back, so the VAT held stays covered by the sale's fee", euVatOnRefund(sale, { refundCents: 3451, refundedBeforeCents: 0, vatBackBeforeCents: 0, kind: "dispute-lost" })?.vatBackCents, 0);

  done();
}

main();
