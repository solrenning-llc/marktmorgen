/**
 * docs/marktmorgen-affiliates.md (220 [HL1], unit 1): the largest recurring
 * commission Marktmorgen's own affiliate programme could pay on each plan and
 * interval, as a PROPOSAL. Every figure comes from the code; none is typed.
 *
 * - The unit: the plan at its price in force, every right used in its worst
 *   month for every window the payment reaches (planUnits), plus the room the
 *   spend floor keeps (roomKept).
 * - Receiving: lib/receiving-costs.ts receivingOf under TX's reading
 *   (MOST_CORRECT_READING): the dearer provider's fee on the amount charged
 *   with the buyer's tax on top, remittance, refund and dispute reserves.
 * - The commission: a share of the plan's price (the buyer's tax on top is
 *   never shared), rounded up to the cent.
 * - Tax: IRPF 15% and IOF 0.38% on a positive profit (the owner's LC rule;
 *   the IOF base approximated by that profit, as tests/paid-themes-study-table.ts
 *   does), outside the old 27.5% floor the code still carries until 472 [TX2].
 * - MR: the net keeps a positive cent (POSITIVE_NET_CENTS).
 *
 * Unknown, so never zero: the cost of paying one affiliate abroad. It is not
 * in the net, so no percentage is certified here.
 */
import { PLAN_PRICES, PLAN_TITLES, TIERS, type Tier } from "@/lib/plan";
import { MOST_CORRECT_READING, POSITIVE_NET_CENTS, receivingOf } from "@/lib/receiving-costs";
import { planUnits, roomKept } from "./margin-alignment-table";

const ceilBps = (cents: number, bps: number) => Math.ceil((cents * bps) / 10_000);
const taxOf = (pretaxCents: number) =>
  pretaxCents > 0 ? ceilBps(pretaxCents, MOST_CORRECT_READING.profitTaxBps) + ceilBps(pretaxCents, MOST_CORRECT_READING.incomingExchangeIofBps) : 0;

export type AffiliateRow = {
  id: string;
  name: string;
  tier: Tier;
  cycle: "month" | "year";
  priceCents: number;
  usageCents: number;
  roomCents: number;
  receivingCents: number;
  netWithoutCommissionCents: number;
  /** The largest commission, in basis points of the price, that keeps MR's positive net cent; null when none does. */
  maxCommissionBps: number | null;
};

/** The net of one payment after paying `commissionBps` of its price to an affiliate. */
export function netWithCommissionCents(row: Pick<AffiliateRow, "priceCents" | "usageCents" | "roomCents">, commissionBps: number): number {
  const receiving = receivingOf(row.priceCents, MOST_CORRECT_READING, true);
  const commission = ceilBps(row.priceCents, commissionBps);
  const pretax = receiving.revenueCents - receiving.totalCents - row.usageCents - row.roomCents - commission;
  return pretax - taxOf(pretax);
}

export function affiliateRows(): AffiliateRow[] {
  return planUnits(false).map((unit) => {
    const [tier, cycle] = unit.id.split("-") as [Tier, "month" | "year"];
    const base = { priceCents: unit.priceCents, usageCents: unit.usageCents, roomCents: roomKept(unit) };
    const netWithoutCommissionCents = netWithCommissionCents(base, 0);
    let maxCommissionBps: number | null = null;
    for (let bps = 0; bps <= 10_000; bps += 1) {
      if (netWithCommissionCents(base, bps) >= POSITIVE_NET_CENTS) maxCommissionBps = bps;
      else break;
    }
    return {
      id: `${tier}-${cycle}`,
      name: `${PLAN_TITLES[tier]} ${cycle === "year" ? "yearly" : "monthly"}`,
      tier,
      cycle,
      ...base,
      receivingCents: receivingOf(unit.priceCents, MOST_CORRECT_READING, true).totalCents,
      netWithoutCommissionCents,
      maxCommissionBps,
    };
  });
}

const usd = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

export function renderMarktmorgenAffiliates(): string {
  const rows = affiliateRows();
  const table = rows.map((row) => {
    const max = row.maxCommissionBps;
    const share = max === null ? "none" : pct(max);
    const amount = max === null ? "—" : usd(Math.floor((row.priceCents * max) / 10_000));
    return `| ${row.name} | ${usd(row.priceCents)} | ${usd(row.usageCents)} | ${usd(row.receivingCents)} | ${usd(row.roomCents)} | ${usd(row.netWithoutCommissionCents)} | ${share} | ${amount} |`;
  });
  const lowest = rows.reduce((min, row) => (row.maxCommissionBps === null ? min : Math.min(min, row.maxCommissionBps)), 10_000);
  const prices = TIERS.map((tier) => `${PLAN_TITLES[tier]} ${usd(PLAN_PRICES[tier].month)} / ${usd(PLAN_PRICES[tier].year)}`).join("; ");
  return `# Marktmorgen's own affiliate programme: the largest commission (PROPOSAL, 220 [HL1], unit 1)

**PROPOSAL.** No percentage is in force, nothing is built, and nothing changes a price, a limit, a commission on sales, a flag or a gate. Paid plans are not on sale (\`PLANS_ON_SALE\` is false). The owner decides any percentage.

Queue item 220 [HL1] asks for a programme where anyone, a customer or not, tells people about Marktmorgen and earns a recurring share of the plan payments of the customers they bring. This unit answers its first question: **the largest share each plan and interval can pay on its own, in the worst case, without a loss.**

## How it is computed

Generated by \`node scripts/marktmorgen-affiliates.mjs\` from \`tests/marktmorgen-affiliates-table.ts\`. \`tests/marktmorgen-affiliates.test.ts\` fails when this file and the code differ. No figure is typed.

- **The customer:** the plan at its price in force (${prices}). Every right of the plan is used in its worst month, for every month the payment covers (\`planUnits\` in \`tests/margin-alignment-table.ts\`). The room the spend floor keeps is added (\`roomKept\`).
- **Receiving the payment:** \`lib/receiving-costs.ts\`. This is the dearer provider's fee on the amount charged, with the buyer's tax on top, plus remittance and the refund and dispute reserves.
- **The commission:** a share of the plan's price, rounded up to the cent. The buyer's tax on top is never shared.
- **Tax:** the TX reading the owner's LC rule asks for. IRPF is 15% of the profit and IOF is 0.38% of what is brought to Brazil, taken here on the same profit. This is outside the old 27.5% floor that the code still carries until 472 [TX2].
- **The rule:** MR. The customer alone, at full use, keeps a positive net cent after the commission. The item's own 60% floor is history, replaced by MR on 27 October 2026.

## The largest commission per plan and interval

| Plan | Price | Worst-case use | Receiving | Spend-floor room | Net with no commission | Largest commission | Per payment |
| --- | --- | --- | --- | --- | --- | --- | --- |
${table.join("\n")}

The lowest of them is **${pct(lowest)}**. One percentage for every plan, as most programmes publish, could not go higher than that.

**This is the edge of a loss, not a recommendation.** At the largest commission, the customer leaves the company one cent: nothing towards the fixed costs, nothing towards the 60% target of the monthly report (MR item 3), and no room for the payout cost above. Choosing a percentage that maximizes profit (the owner's rule of 18 October 2026) needs that cost and the programme's expected sales, and it belongs to a later unit and to the owner.

## What is unknown, and so never zero

**The cost of paying one affiliate.** It is unknown and **never zero**, and it is not in the net above, so **no percentage is certified** by this table. The candidates:
- PayPal Payouts;
- Stripe Connect payouts to the affiliate;
- Wise, through the batch file the creators' affiliate payouts already build (\`lib/affiliate-payouts.ts\`).

Their fees per payment and per country, their minimums, and the tax forms each needs were not read from dated official sources here:
- W-9 for a US person and W-8BEN for anyone else, which a US company collects before paying;
- whether a 1099 is due.

That is the next unit. Until it is done, the largest commission that keeps MR is lower than the table by that unknown cost, and none can be proposed as final.

**The company's fixed costs and funded exposures** stay outside the unit, as MR says: they are covered from the minimum base of paying customers, not by any one customer.

## Rules the programme would keep (from the item)

- **When it is owed.** Only after the customer has paid and the **30 days** of the money-back refund have passed. Each later renewal is owed the same way.
- **Taken back.** The commission is taken back on a **refund** or a **dispute** of that payment.
- **Fraud and self-referral.** No commission when the affiliate and the customer are the same person, card, device or address. Nothing is paid for a sign-up without a payment.
- **Reuse, no second system.** The creators' affiliate links (\`?via=\`), the book of who brought whom, and the payout batch file (\`lib/affiliates.ts\`, \`lib/affiliate-payouts.ts\`). The difference is that here Marktmorgen itself pays, from the company's account.
- **Coordination with 216 [OP2].** That item is a creator's credit on their own plan for bringing another creator, never cash. Both would read the same record of who brought whom, so one customer is never rewarded twice for the same referral.

## Acessibilidade

A document only: no page, component or email changes. Steps and decisions of the main task: 0 → 0. The programme's pages, when built, follow AX274 in their own units.
`;
}
