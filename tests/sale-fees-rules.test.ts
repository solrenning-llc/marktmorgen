/**
 * Fees and what the creator keeps, sale by sale (282 [HG1], unit 1;
 * lib/sale-fees-rules.ts). Synthetic Stripe balance transactions only, in
 * the shape the Stripe API documents (object "balance_transaction", amount,
 * fee, fee_details, net, type, reporting_category, source). Checked:
 *
 *   - a line is read only when it is whole and adds up (amount - fee = net,
 *     the fee is the sum of its details, every detail in its currency);
 *   - each kind of money lands in its column: Stripe's fee, tax on that fee,
 *     an application fee (the Marktmorgen commission), other fees, refunds,
 *     disputes and money given back;
 *   - refunds and disputes find their sale through the expanded source;
 *   - Stripe Tax fees and other account fees stay apart from sales;
 *   - currencies are never added together and nothing is converted;
 *   - anything unreadable, the same line twice or an incomplete reading
 *     makes the report unavailable, never a lower number or zero;
 *   - a refund of a sale outside the reading says the sale is unknown.
 */
import { readFeeLine, saleFees, type SaleFees } from "@/lib/sale-fees-rules";
import { done, is, part } from "./check";

const T0 = Date.UTC(2026, 9, 5, 12) / 1000;
let n = 0;

type Detail = { amount: number; currency?: string; type: string };
type Txn = Record<string, unknown>;

function txn(over: Partial<{
  id: string;
  type: string;
  reporting_category: string;
  amount: number;
  currency: string;
  details: Detail[];
  source: unknown;
  created: number;
}>): Txn {
  n += 1;
  const currency = over.currency ?? "usd";
  const details = (over.details ?? []).map((d) => ({ amount: d.amount, currency: d.currency ?? currency, type: d.type, description: "x", application: null }));
  const fee = details.reduce((s, d) => s + d.amount, 0);
  const amount = over.amount ?? 0;
  return {
    id: over.id ?? `txn_${n}`,
    object: "balance_transaction",
    amount,
    currency,
    fee,
    fee_details: details,
    net: amount - fee,
    type: over.type ?? "charge",
    reporting_category: over.reporting_category ?? "charge",
    source: over.source ?? null,
    created: over.created ?? T0 + n,
    status: "available",
  };
}

const sale = (charge: string, amount: number, stripeFee: number, more: Detail[] = [], currency = "usd", created?: number) =>
  txn({ type: "charge", reporting_category: "charge", amount, currency, source: charge, created, details: [{ amount: stripeFee, type: "stripe_fee" }, ...more] });
const refund = (charge: string, amount: number, currency = "usd") =>
  txn({ type: "refund", reporting_category: "refund", amount: -amount, currency, source: { id: `re_${n + 1}`, object: "refund", charge } });
const dispute = (charge: string, amount: number, disputeFee: number) =>
  txn({ type: "adjustment", reporting_category: "dispute", amount: -amount, source: { id: `du_${n + 1}`, object: "dispute", charge }, details: [{ amount: disputeFee, type: "stripe_fee" }] });
const disputeBack = (charge: string, amount: number) =>
  txn({ type: "adjustment", reporting_category: "dispute_reversal", amount, source: { id: `du_${n + 1}`, object: "dispute", charge } });

function rowsOf(report: SaleFees): unknown {
  return report.available ? report.rows : report.why;
}

function main(): void {
  part("A line is read only when it is whole");
  const ok = sale("ch_1", 5000, 175);
  is("a whole sale line is read", readFeeLine(ok), {
    id: ok.id, kind: "sale", sale: "ch_1", at: ok.created, currency: "usd", amount: 5000,
    stripeFee: 175, feeTax: 0, applicationFee: 0, otherFee: 0, net: 4825,
  });
  is("a payment (py_) is a sale too", (readFeeLine(txn({ type: "payment", source: "py_9", amount: 100, details: [{ amount: 3, type: "stripe_fee" }] })) as { sale?: string }).sale, "py_9");
  const broken: Array<[string, Txn]> = [
    ["not a balance transaction", { ...ok, object: "charge" }],
    ["an id that is not txn_", { ...ok, id: "ch_1" }],
    ["net that does not add up", { ...ok, net: 4826 }],
    ["fee unlike its details", { ...ok, fee: 170 }],
    ["a detail in another currency", { ...ok, fee_details: [{ amount: 175, currency: "eur", type: "stripe_fee" }] }],
    ["a negative detail", { ...ok, fee: -1, net: 5001, fee_details: [{ amount: -1, currency: "usd", type: "stripe_fee" }] }],
    ["a fraction of a cent", { ...ok, amount: 5000.5, net: 4825.5 }],
    ["an upper-case currency", { ...ok, currency: "USD", fee_details: [{ amount: 175, currency: "USD", type: "stripe_fee" }] }],
    ["no created time", { ...ok, created: undefined }],
    ["fee details missing", { ...ok, fee_details: undefined }],
    ["a sale with no source", { ...ok, source: null }],
    ["a sale whose source is not a charge", { ...ok, source: "re_1" }],
    ["a refund whose source was not expanded", { ...refund("ch_1", 100), source: "re_5" }],
    ["a refund whose charge is missing", { ...refund("ch_1", 100), source: { id: "re_5", object: "refund" } }],
    ["a dispute whose charge is not a charge id", { ...dispute("ch_1", 100, 1500), source: { id: "du_5", object: "dispute", charge: "txn_1" } }],
  ];
  for (const [what, raw] of broken) is(`unreadable: ${what}`, readFeeLine(raw), null);
  for (const bad of [null, undefined, 5, "txn_1", [], true]) is(`unreadable: ${JSON.stringify(bad) ?? "undefined"}`, readFeeLine(bad), null);
  is("a payout is not a sale and not a fee: other", readFeeLine(txn({ type: "payout", reporting_category: "payout", amount: -9000 })), "other");
  is("an adjustment that is not a dispute is other", readFeeLine(txn({ type: "adjustment", reporting_category: "other_adjustment", amount: -5 })), "other");
  is("a transfer is other", readFeeLine(txn({ type: "transfer", reporting_category: "transfer", amount: -10 })), "other");

  part("Each kind of money in its own column");
  const withAll = sale("ch_2", 10000, 320, [
    { amount: 64, type: "tax" },
    { amount: 0, type: "application_fee" },
    { amount: 25, type: "payment_method_passthrough_fee" },
    { amount: 7, type: "some_new_fee" },
  ]);
  const read = readFeeLine(withAll) as Record<string, number>;
  is("Stripe's fee, with pass-through fees", read.stripeFee, 345);
  is("tax on Stripe's fee apart", read.feeTax, 64);
  is("an application fee (commission) apart, here zero", read.applicationFee, 0);
  is("a fee of a kind not known yet is kept as other, never dropped", read.otherFee, 7);
  is("net is Stripe's own net", read.net, 10000 - 416);
  is("a Stripe Tax fee is an account fee, with no sale", readFeeLine(txn({ type: "tax_fee", reporting_category: "tax", amount: -50 })), {
    id: `txn_${n}`, kind: "tax_fee", sale: null, at: T0 + n, currency: "usd", amount: -50, stripeFee: 0, feeTax: 0, applicationFee: 0, otherFee: 0, net: -50,
  });
  is("another Stripe fee (Billing, Radar) is an account fee", (readFeeLine(txn({ type: "stripe_fee", reporting_category: "fee", amount: -30 })) as { kind?: string }).kind, "stripe_fee");

  part("Sale by sale");
  const s1 = sale("ch_a", 5000, 175, [], "usd", T0 + 10);
  const s2 = sale("ch_b", 3000, 117, [{ amount: 300, type: "application_fee" }], "usd", T0 + 20);
  const s3 = sale("ch_c", 4000, 140, [], "eur", T0 + 30);
  const list = [s1, s2, s3, refund("ch_a", 1000), dispute("ch_b", 3000, 1500), disputeBack("ch_b", 3000), refund("ch_c", 4000, "eur"), txn({ type: "tax_fee", reporting_category: "tax", amount: -12 }), txn({ type: "payout", reporting_category: "payout", amount: -2000 })];
  const report = saleFees(list, { complete: true });
  is("the report is available", report.available, true);
  is("one row per sale, newest first, each in its own currency", rowsOf(report), [
    { sale: "ch_c", currency: "eur", at: T0 + 30, saleRead: true, gross: 4000, stripeFee: 140, feeTax: 0, applicationFee: 0, otherFee: 0, refunds: -4000, disputes: 0, net: -140 },
    { sale: "ch_b", currency: "usd", at: T0 + 20, saleRead: true, gross: 3000, stripeFee: 1617, feeTax: 0, applicationFee: 300, otherFee: 0, refunds: 0, disputes: 0, net: 3000 - 417 - 1500 },
    { sale: "ch_a", currency: "usd", at: T0 + 10, saleRead: true, gross: 5000, stripeFee: 175, feeTax: 0, applicationFee: 0, otherFee: 0, refunds: -1000, disputes: 0, net: 3825 },
  ]);
  is("account fees stay apart, by currency", report.available ? report.accountFees : null, [{ currency: "usd", taxFees: -12, stripeFees: 0 }]);
  if (report.available) {
    const sums = report.rows.every((r) => r.net === (r.gross ?? 0) - r.stripeFee - r.feeTax - r.applicationFee - r.otherFee + r.refunds + r.disputes);
    is("every row adds up: gross - fees + refunds + disputes = net", sums, true);
  }
  is("a dispute lost stays lost", rowsOf(saleFees([s2, dispute("ch_b", 3000, 1500)], { complete: true })), [
    { sale: "ch_b", currency: "usd", at: T0 + 20, saleRead: true, gross: 3000, stripeFee: 1617, feeTax: 0, applicationFee: 300, otherFee: 0, refunds: 0, disputes: -3000, net: 3000 - 417 - 1500 - 3000 },
  ]);
  is("nothing sold: no rows, no account fees", saleFees([], { complete: true }), { available: true, rows: [], accountFees: [] });

  part("A refund of a sale outside the reading");
  const orphan = saleFees([refund("ch_old", 2500)], { complete: true });
  is("the sale is unknown: no gross, no net, never zero", rowsOf(orphan), [
    { sale: "ch_old", currency: "usd", at: null, saleRead: false, gross: null, stripeFee: 0, feeTax: 0, applicationFee: 0, otherFee: 0, refunds: -2500, disputes: 0, net: null },
  ]);

  part("Unavailable, never a lower number");
  is("an incomplete reading", rowsOf(saleFees([s1], { complete: false })), "incomplete");
  is("a line that cannot be read", rowsOf(saleFees([s1, { ...s2, net: 1 }], { complete: true })), "unreadable");
  is("the same line twice", rowsOf(saleFees([s1, s1], { complete: true })), "repeated");
  is("the same sale twice under two lines", rowsOf(saleFees([s1, { ...s1, id: "txn_other" }], { complete: true })), "repeated");
  is("not a list", rowsOf(saleFees("nope" as unknown as unknown[], { complete: true })), "unreadable");
  is("an unknown reading state", rowsOf(saleFees([s1], {} as { complete: boolean })), "incomplete");
  is("a list too long for one report", rowsOf(saleFees(Array.from({ length: 10_001 }, () => s1), { complete: true })), "too_large");

  done();
}

main();
