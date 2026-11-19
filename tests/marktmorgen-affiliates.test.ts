/**
 * 220 [HL1], unit 1: the largest recurring commission Marktmorgen's own
 * affiliate programme could pay on each plan and interval, as a PROPOSAL.
 *
 * Checked against the real code, with no figure typed:
 *   - each unit is the plan at its price in force, every right used in its
 *     worst month (tests/margin-alignment-table.ts planUnits), with the spend
 *     floor's room kept (roomKept);
 *   - receiving costs come from lib/receiving-costs.ts and the tax from TX's
 *     reading (MOST_CORRECT_READING: IRPF 15% and IOF 0.38% on a positive
 *     profit), as the owner's LC rule asks, outside the code's old 27.5% floor;
 *   - the largest commission keeps MR's positive net cent, and one basis point
 *     more does not;
 *   - the cost of paying an affiliate abroad is unknown, so it is never zero:
 *     the proposal certifies no percentage and every page says so;
 *   - docs/marktmorgen-affiliates.md is exactly what the renderer writes
 *     (node scripts/marktmorgen-affiliates.mjs), and nothing is in force.
 */
import { DISPUTE_DAYS } from "@/lib/refund-reserve-rules";
import { readFileSync, existsSync } from "node:fs";
import { PLAN_PRICES, TIERS } from "@/lib/plan";
import { POSITIVE_NET_CENTS } from "@/lib/receiving-costs";
import { PLANS_ON_SALE } from "@/lib/opening";
import * as table from "./marktmorgen-affiliates-table";
import { affiliateRows, netWithCommissionCents, renderMarktmorgenAffiliates } from "./marktmorgen-affiliates-table";
import { done, is, part } from "./check";

const rows = affiliateRows();

part("One row per plan and interval, at the prices in force");
is("six units", rows.map((row) => row.id), TIERS.flatMap((tier) => [`${tier}-month`, `${tier}-year`]));
is("each at its price in lib/plan.ts", rows.map((row) => row.priceCents), TIERS.flatMap((tier) => [PLAN_PRICES[tier].month, PLAN_PRICES[tier].year]));

part("The largest commission is the edge of MR's positive net");
for (const row of rows) {
  const max = row.maxCommissionBps;
  is(`${row.id}: at the largest commission, the net keeps a positive cent`, max === null || netWithCommissionCents(row, max) >= POSITIVE_NET_CENTS, true);
  is(`${row.id}: one basis point more does not`, max === null || max === 10_000 || netWithCommissionCents(row, max + 1) < POSITIVE_NET_CENTS, true);
  is(`${row.id}: with no commission, the net is the plan's own`, netWithCommissionCents(row, 0), row.netWithoutCommissionCents);
}
is("a plan whose net is not positive without a commission gets none", rows.every((row) => (row.netWithoutCommissionCents >= POSITIVE_NET_CENTS) === (row.maxCommissionBps !== null)), true);

part("What the record shows is what the net takes (review of #3756)");
const shown = renderMarktmorgenAffiliates();
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
for (const row of rows) {
  if (row.maxCommissionBps === null) continue;
  is(`${row.id}: the commission shown is the one rounded up that the net pays`, shown.includes(`${usd(Math.ceil((row.priceCents * row.maxCommissionBps) / 10_000))} |`), true);
}
is("a dispute after the commission was paid is named as a cost not yet covered (review of #3756)", /dispute[^.]*after[^.]*paid[^.]*unknown|unknown[^.]*dispute[^.]*after[^.]*paid/i.test(shown), true);
// Claude 7 on #3764 (MEDIUM): a yearly plan pays ahead, so its dispute window runs from the end of the year it paid
// for, not from the charge (lib/refund-reserve-rules.ts, DISPUTE_DAYS, Stripe's "Dispute timing").
is("the annual dispute example is a model assumption with no certified expiry date", shown.includes(`${DISPUTE_DAYS} days after the later of the payment and the end of the period it paid for`) && shown.includes(`${DISPUTE_DAYS + 365} days in the yearly example`) && shown.includes("Some card network rules allow more time") && shown.includes("the maximum dispute window has not been confirmed"), true);
is("never only 'after the charge', which would release a yearly commission about a year early", /about 120 days after the charge/.test(shown), false);

part("Nothing is in force");
is("plans are not on sale", PLANS_ON_SALE, false);
const doc = renderMarktmorgenAffiliates();
is("a PROPOSAL, said first", doc.split("\n").slice(0, 4).join("\n").includes("PROPOSAL"), true);
is("the payout cost abroad is unknown, never zero, and no percentage is certified", [/unknown/i.test(doc), /never zero/i.test(doc), /no percentage is certified/i.test(doc)], [true, true, true]);
is("the commission is owed only after payment and the 30-day refund window, and taken back on refund or dispute", [/30 days/.test(doc), /refund/i.test(doc), /dispute/i.test(doc)], [true, true, true]);
is("it has an Acessibilidade section", doc.includes("## Acessibilidade"), true);

part("Claude 5's review of #3756 (6910906486): the rules match the refund policy and the table prints what is paid");
// HIGH: a yearly plan is refunded at any time, less the months already started (app/refunds/page.tsx section 3,
// lib/plan-refund-rules.ts unstarted_months). Paid for the whole year at 30 days, the commission is cash already gone
// when the refund comes; owed per started month, the months refunded were never paid out.
is("a yearly plan's commission is owed per started month (a twelfth a month), never the whole year at once", /yearly plan[^.]*per started month/i.test(doc) && /never the whole year at once/i.test(doc), true);
// MEDIUM: the table's percentage holds for a full plan payment; a plan change's prorated charge is smaller while the
// fixed part of the fee and of the dispute reserve is not (lib/billing.ts, proration_behavior "always_invoice").
is("the commission is owed only on a full plan payment, never on a prorated charge", /only on a full plan payment/i.test(doc) && /prorated/i.test(doc), true);
// LEVE 1: the commission is rounded up to the cent (ceilBps); the "Per payment" column printed it rounded down.
const paidCents = (table as { commissionCents?: (row: { priceCents: number }, bps: number) => number }).commissionCents;
is("a commission-in-cents helper is exported", typeof paidCents, "function");
for (const row of rows) {
  if (row.maxCommissionBps === null || !paidCents) continue;
  const cents = paidCents(row, row.maxCommissionBps);
  const printed = `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  is(`${row.id}: "Per payment" prints the commission rounded up, as the net takes it`, doc.includes(`| ${(row.maxCommissionBps / 100).toFixed(2)}% | ${printed} |`), true);
}
// LEVE 2: the line under the table started its minimum at 100% and skipped the plans that cannot pay.
const lowestLine = (table as { lowestLine?: (rows: { name: string; maxCommissionBps: number | null }[]) => string }).lowestLine;
is("a lowest-line helper is exported", typeof lowestLine, "function");
if (lowestLine) {
  is("no plan can pay: it says so, never 100%", lowestLine([{ name: "A", maxCommissionBps: null }, { name: "B", maxCommissionBps: null }]).includes("100.00%"), false);
  is("one plan cannot pay: no single percentage for every plan is offered", /one percentage for every plan/i.test(lowestLine([{ name: "A", maxCommissionBps: 5000 }, { name: "B", maxCommissionBps: null }])), false);
  is("one plan cannot pay: it is named", lowestLine([{ name: "A", maxCommissionBps: 5000 }, { name: "B", maxCommissionBps: null }]).includes("B"), true);
  is("every plan can pay: the lowest is given", lowestLine([{ name: "A", maxCommissionBps: 5000 }, { name: "B", maxCommissionBps: 4000 }]).includes("**40.00%**"), true);
}

part("Paying an affiliate: what was read, with its date and source (unit 2)");
is("Stripe's own pages are cited, with the day they were read", ["https://stripe.com/connect/pricing", "https://docs.stripe.com/connect/cross-border-payouts", "https://docs.stripe.com/global-payouts", "https://docs.stripe.com/global-payouts/recipient-requirements"].every((url) => doc.includes(url)) && doc.includes("read on 11 November 2026"), true);
is("Connect's published payout fees are quoted as read", ["$2 per monthly active account", "0.25% + 25¢ per payout sent", "Starting at 0.25% of payout volume"].every((quote) => doc.includes(quote)), true);
is("a fee that only says where it starts is no ceiling, so it stays unknown", /starting at[^.]*is not a ceiling/i.test(doc), true);
is("Brazil is marked as private preview, with no assumption that the programme can use it", doc.includes("Brazil (BRL) is listed in private preview") && doc.includes("coverage for a US sender and an individual recipient remains unconfirmed"), true);
is("PayPal, Wise and the IRS forms could not be read here and stay unknown", ["PayPal", "Wise", "W-8BEN", "W-9"].every((name) => new RegExp(`${name}[^\n]*(could not be read|unknown)`).test(doc)), true);

part("The record is what the renderer writes");
const path = "docs/marktmorgen-affiliates.md";
is("docs/marktmorgen-affiliates.md is current (node scripts/marktmorgen-affiliates.mjs)", existsSync(path) ? readFileSync(path, "utf8") : "", doc);

done();
