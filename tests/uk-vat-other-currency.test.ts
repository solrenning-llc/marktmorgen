/**
 * 789 [IV1] step 3, unit 7 (coordinator, 21/11/2026 12:24 UTC, option b): a UK sale in another currency than pounds.
 * Its VAT is charged on top in the sale's currency, but the invoice and the VAT Return need it in sterling at HMRC's
 * period rate for the supply's month (VAT Notice 700, 7.6), read from lib/hmrc-period-rates.ts. It holds that:
 *   - a month with no row in HMRC's table refuses a UK sale in euros or dollars exactly as before, the body untouched,
 *     never collected without a sterling figure (the table holds only the months downloaded from HMRC);
 *   - a row is read only for the supply's month and currency, with a rate as HMRC writes it (units per £1), an https
 *     source with a host and a real read-on day no later than the supply; two rows that disagree are unknown;
 *   - with a row injected HERE ONLY, the sale is collected in its own currency at 20%, its sterling VAT kept on the
 *     payment as `uk_vat_gbp` (pence, rate, month), and the cost of receiving it reads the POUND allowance, the
 *     return's currency, never the sale's; an EU sale keeps reading its own currency's;
 *   - a currency not written in hundredths (yen) is refused: toPence reads hundredths only.
 * Synthetic data only.
 */
import { EuVatCollectRefused, applyEuCollect } from "@/lib/eu-vat-collect";
import { HMRC_PERIOD_RATES, type HmrcPeriodRate, hmrcPeriodRate } from "@/lib/hmrc-period-rates";
import { vatCollectionCostOf, type VatFxAllowance } from "@/lib/eu-vat-collection-cost";
import { toPence } from "@/lib/uk-vat";
import { done, is, part } from "./check";

const NOW = new Date("2026-12-01T12:00:00Z");
const ROW: HmrcPeriodRate = { month: "2026-12", currency: "EUR", perPound: "1.1834", source: "https://example.invalid/hmrc/2026-12", readOn: "2026-11-27" };
const USD: HmrcPeriodRate = { ...ROW, currency: "USD", perPound: "1.2713", source: "https://example.invalid/hmrc/2026-12-usd" };
const JPY: HmrcPeriodRate = { ...ROW, currency: "JPY", perPound: "190.12" };
const SWITCH = {
  reviewed: true,
  seller: { legalName: "Synthetic Seller LLC", address: "1 Test Street, Wilmington, DE 19801, United States" },
  uk: { vatNumber: "123456789", effectiveFrom: "2026-11-01" },
  reviews: [{ jurisdiction: "UK", registration: "123456789", reviewedOn: "2026-11-15", reviewer: "owner" }],
};
void SWITCH;
const body = (currency: string, cents = 2900) =>
  new URLSearchParams({
    mode: "payment",
    "adaptive_pricing[enabled]": "false",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": currency,
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": "Pattern pack",
  });
const calls: unknown[][] = [];
const cost = (...args: unknown[]) => {
  calls.push(args);
  return 12;
};
const tryCollect = (b: URLSearchParams, extra: Record<string, unknown> = {}) => {
  try {
    applyEuCollect(b, { country: "GB", chooseYourPrice: false, buyerCurrencyLive: false, costsCents: cost, now: NOW, ...extra } as Parameters<typeof applyEuCollect>[1]);
    return "collected";
  } catch (error) {
    return error instanceof EuVatCollectRefused ? "refused" : `threw ${String(error)}`;
  }
};

function main(): void {
  part("A month with no HMRC row: a UK sale in another currency is refused as before");
  is("no row for January 2027 in the real table", HMRC_PERIOD_RATES.some((r) => r.month === "2027-01"), false);
  const euros = body("eur");
  const untouched = euros.toString();
  is("a UK sale in euros in a month with no row: refused, the body untouched", [tryCollect(euros, { sterlingRates: [] }), euros.toString() === untouched], ["refused", true]);
  is("a UK sale in pounds: collected as before", tryCollect(body("gbp")), "collected");

  part("A row is read only when it fits the supply");
  is("the month's row for the currency", hmrcPeriodRate("EUR", "2026-12-01", [ROW]), { perPound: "1.1834", basis: "hmrc-period", day: "2026-12-01", source: ROW.source });
  is("lower-case currency reads the same row", hmrcPeriodRate("eur", "2026-12-31", [ROW])?.perPound, "1.1834");
  for (const [label, table, currency, day] of [
    ["another month", [ROW], "EUR", "2026-11-30"],
    ["another currency", [ROW], "USD", "2026-12-01"],
    ["pounds themselves", [{ ...ROW, currency: "GBP" }], "GBP", "2026-12-01"],
    ["a rate that does not read", [{ ...ROW, perPound: "1,18" }], "EUR", "2026-12-01"],
    ["a zero rate", [{ ...ROW, perPound: "0" }], "EUR", "2026-12-01"],
    ["no https source", [{ ...ROW, source: "http://example.invalid/x" }], "EUR", "2026-12-01"],
    ["an https prefix without a host", [{ ...ROW, source: "https://" }], "EUR", "2026-12-01"],
    ["a month that is not a month", [{ ...ROW, month: "2026-13" }], "EUR", "2026-12-01"],
    ["read after the supply", [{ ...ROW, readOn: "2026-12-02" }], "EUR", "2026-12-01"],
    ["a read-on day that does not exist", [{ ...ROW, readOn: "2026-11-31" }], "EUR", "2026-12-01"],
    ["two rows that disagree", [ROW, { ...ROW, perPound: "1.1900" }], "EUR", "2026-12-01"],
    ["a supply day that does not exist", [ROW], "EUR", "2026-12-32"],
  ] as const) is(`${label}: unknown`, hmrcPeriodRate(currency, day, table as readonly HmrcPeriodRate[]), null);
  is("the same row twice: read once", hmrcPeriodRate("EUR", "2026-12-01", [ROW, { ...ROW }])?.perPound, "1.1834");

  part("With a row injected here only: collected in the sale's currency, its sterling VAT kept");
  calls.length = 0;
  const eurSale = body("eur");
  is("a UK sale in euros: collected", tryCollect(eurSale, { sterlingRates: [ROW] }), "collected");
  is("the VAT line is 20% of the euro amount", eurSale.get("line_items[1][price_data][unit_amount]"), "580");
  is("marked uk_vat, never eu_vat", [eurSale.get("payment_intent_data[metadata][uk_vat]"), eurSale.has("payment_intent_data[metadata][eu_vat]")], ["GB:2000:580", false]);
  is("its sterling VAT kept: pence, the rate and its month", eurSale.get("payment_intent_data[metadata][uk_vat_gbp]"), `${toPence(580, "1.1834")}:1.1834:2026-12`);
  is("the fee is the VAT and the cost of receiving it", eurSale.get("payment_intent_data[application_fee_amount]"), String(580 + 12));
  is("the cost reads the pound allowance, the return's currency", calls.at(-1), [580, "eur", "gbp"]);
  const usdSale = body("usd", 10_000);
  is("a UK sale in dollars: collected at its own row", [tryCollect(usdSale, { sterlingRates: [ROW, USD] }), usdSale.get("payment_intent_data[metadata][uk_vat_gbp]")], ["collected", `${toPence(2000, "1.2713")}:1.2713:2026-12`]);
  is("a UK sale in pounds keeps no sterling line: it is sterling", (() => { const b = body("gbp"); tryCollect(b, { sterlingRates: [ROW] }); return b.has("payment_intent_data[metadata][uk_vat_gbp]"); })(), false);
  const yen = body("jpy", 3000);
  is("yen, not written in hundredths: refused, untouched", [tryCollect(yen, { sterlingRates: [JPY] }), yen.has("line_items[1][quantity]")], ["refused", false]);
  is("a month with no row: refused", tryCollect(body("eur"), { sterlingRates: [ROW], now: new Date("2026-11-30T12:00:00Z") }), "refused");

  part("The sterling month is the month the buyer pays in (Claude 1's LOW on #5032)");
  const NOV: HmrcPeriodRate = { ...ROW, month: "2026-11", perPound: "1.1930", readOn: "2026-11-21" };
  const lateNov = new Date("2026-11-30T23:50:00Z");
  const crossing = body("eur");
  is("RED: a checkout opened on 30/11 at 23:50 that stays open into December: refused, untouched", [tryCollect(crossing, { sterlingRates: [NOV, ROW], now: lateNov }), crossing.has("line_items[1][quantity]")], ["refused", false]);
  const closesInMonth = body("eur");
  closesInMonth.set("expires_at", String(Date.parse("2026-11-30T23:59:59Z") / 1000));
  is("the same checkout closing before December: collected at November's rate", [tryCollect(closesInMonth, { sterlingRates: [NOV, ROW], now: lateNov }), closesInMonth.get("payment_intent_data[metadata][uk_vat_gbp]")], ["collected", `${toPence(580, "1.1930")}:1.1930:2026-11`]);
  const unreadable = body("eur");
  unreadable.set("expires_at", "soon");
  is("an expiry that does not read: refused", tryCollect(unreadable, { sterlingRates: [NOV, ROW], now: lateNov }), "refused");
  is("a sale in pounds is not held to the month", tryCollect(body("gbp"), { now: lateNov }), "collected");

  part("The month is the UK's month, not UTC's (Claude 2's LOW on #5032, 7068670312)");
  // 2026 summer time ends on 25/10: on 30/09 London is UTC+1, so 23:10 UTC is already 01/10 00:10 in the UK.
  const SEP: HmrcPeriodRate = { ...ROW, month: "2026-09", perPound: "1.1700", readOn: "2026-09-01", source: "https://example.invalid/hmrc/2026-09" };
  const OCT: HmrcPeriodRate = { ...ROW, month: "2026-10", perPound: "1.1800", readOn: "2026-09-01", source: "https://example.invalid/hmrc/2026-10" };
  const at = (now: string, closes: string) => {
    const b = body("eur");
    b.set("expires_at", String(Date.parse(closes) / 1000));
    return { b, result: tryCollect(b, { sterlingRates: [SEP, OCT], now: new Date(now) }) };
  };
  const ukOctober = at("2026-09-30T23:10:00Z", "2026-09-30T23:41:00Z");
  is("RED: 30/09 23:10 UTC is 01/10 in the UK: never September's rate; refused, untouched", [ukOctober.result, ukOctober.b.has("line_items[1][quantity]")], ["refused", false]);
  const ukSeptember = at("2026-09-30T22:10:00Z", "2026-09-30T22:40:00Z");
  is("30/09 22:10 UTC is still 30/09 in the UK: September's rate", [ukSeptember.result, ukSeptember.b.get("payment_intent_data[metadata][uk_vat_gbp]")], ["collected", `${toPence(580, "1.1700")}:1.1700:2026-09`]);
  const ukOctoberBoth = at("2026-10-01T00:10:00Z", "2026-10-01T00:40:00Z");
  is("01/10 00:10 UTC, 01:10 in the UK: October's rate", [ukOctoberBoth.result, ukOctoberBoth.b.get("payment_intent_data[metadata][uk_vat_gbp]")], ["collected", `${toPence(580, "1.1800")}:1.1800:2026-10`]);
  const closesIntoUkOctober = at("2026-09-30T22:10:00Z", "2026-09-30T23:30:00Z");
  is("opened on 30/09 in the UK, payable until 01/10 00:30 UK time: refused", closesIntoUkOctober.result, "refused");

  part("The cost of receiving reads the return's currency");
  const allowances: VatFxAllowance[] = [
    { currency: "eur", bps: 300, source: "https://example.invalid/fx-eur", checkedOn: "2026-11-20", validThrough: "2027-03-31" },
    { currency: "gbp", bps: 500, source: "https://example.invalid/fx-gbp", checkedOn: "2026-11-20", validThrough: "2027-03-31" },
  ];
  // Claude 1's MEDIUM on #5032: the VAT owed in pounds is fixed at HMRC's period rate, but the euros collected buy
  // pounds at the market rate. That gap is its own exposure, priced by its own reviewed allowance (`against: "gbp"`).
  is("RED: the pound allowance alone does not let a euro sale collect", vatCollectionCostOf(580, "eur", allowances, NOW, "gbp"), null);
  const gap: VatFxAllowance = { currency: "eur", against: "gbp", bps: 250, source: "https://example.invalid/period-gap-eur", checkedOn: "2026-11-20", validThrough: "2027-03-31" };
  const eurToGbp = vatCollectionCostOf(580, "eur", [...allowances, gap], NOW, "gbp");
  is("a euro sale whose return is in pounds: the pound allowance", eurToGbp?.fxCents, Math.ceil((580 * 500) / 10_000));
  is("and its own allowance for the gap to HMRC's period rate", eurToGbp?.periodGapCents, Math.ceil((580 * 250) / 10_000));
  is("a gap allowance for another currency does not count", vatCollectionCostOf(2000, "usd", [...allowances, gap], NOW, "gbp"), null);
  is("a gap allowance against another return currency does not count", vatCollectionCostOf(580, "eur", [...allowances, { ...gap, against: "eur" }], NOW, "gbp"), null);
  is("a sale in its return currency has no gap to price", vatCollectionCostOf(580, "gbp", allowances, NOW, "gbp")?.periodGapCents, 0);
  is("an EU sale in euros: its own currency's, as before", vatCollectionCostOf(580, "eur", allowances, NOW)?.fxCents, Math.ceil((580 * 300) / 10_000));
  is("a dollar sale whose return is in pounds: priced with its own gap allowance", vatCollectionCostOf(2000, "usd", [...allowances, { ...gap, currency: "usd" }], NOW, "gbp") !== null, true);
  is("a dollar sale with no return currency named: unknown, as before", vatCollectionCostOf(2000, "usd", allowances, NOW), null);
  is("a yen sale: unknown, whatever the return", vatCollectionCostOf(2000, "jpy", allowances, NOW, "gbp"), null);
  is("a return in any other currency: unknown", vatCollectionCostOf(2000, "eur", allowances, NOW, "usd"), null);

  done();
}

main();
