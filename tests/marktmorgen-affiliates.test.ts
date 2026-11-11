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
import { readFileSync, existsSync } from "node:fs";
import { PLAN_PRICES, TIERS } from "@/lib/plan";
import { POSITIVE_NET_CENTS } from "@/lib/receiving-costs";
import { PLANS_ON_SALE } from "@/lib/opening";
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

part("Nothing is in force");
is("plans are not on sale", PLANS_ON_SALE, false);
const doc = renderMarktmorgenAffiliates();
is("a PROPOSAL, said first", doc.split("\n").slice(0, 4).join("\n").includes("PROPOSAL"), true);
is("the payout cost abroad is unknown, never zero, and no percentage is certified", [/unknown/i.test(doc), /never zero/i.test(doc), /no percentage is certified/i.test(doc)], [true, true, true]);
is("the commission is owed only after payment and the 30-day refund window, and taken back on refund or dispute", [/30 days/.test(doc), /refund/i.test(doc), /dispute/i.test(doc)], [true, true, true]);
is("it has an Acessibilidade section", doc.includes("## Acessibilidade"), true);

part("Paying an affiliate: what was read, with its date and source (unit 2)");
is("Stripe's own pages are cited, with the day they were read", ["https://stripe.com/connect/pricing", "https://docs.stripe.com/connect/cross-border-payouts", "https://docs.stripe.com/global-payouts", "https://docs.stripe.com/global-payouts/recipient-requirements"].every((url) => doc.includes(url)) && doc.includes("read on 11 November 2026"), true);
is("Connect's published payout fees are quoted as read", ["$2 per monthly active account", "0.25% + 25¢ per payout sent", "Starting at 0.25% of payout volume"].every((quote) => doc.includes(quote)), true);
is("a fee that only says where it starts is no ceiling, so it stays unknown", /starting at[^.]*is not a ceiling/i.test(doc), true);
is("Brazil is not among Global Payouts' recipient countries for a US sender, as read", doc.includes("Brazil is not in the list"), true);
is("PayPal, Wise and the IRS forms could not be read here and stay unknown", ["PayPal", "Wise", "W-8BEN", "W-9"].every((name) => new RegExp(`${name}[^\n]*(could not be read|unknown)`).test(doc)), true);

part("The record is what the renderer writes");
const path = "docs/marktmorgen-affiliates.md";
is("docs/marktmorgen-affiliates.md is current (node scripts/marktmorgen-affiliates.mjs)", existsSync(path) ? readFileSync(path, "utf8") : "", doc);

done();
