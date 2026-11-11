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

**The cost of paying one affiliate.** It is unknown and **never zero**, and it is not in the net above, so **no percentage is certified** by this table.

### What paying an affiliate costs: what was read (unit 2)

Each page was read on 11 November 2026. Quotes are as read.

**Stripe Connect, paying an affiliate who has their own connected account**
- Source: https://stripe.com/connect/pricing, read on 11 November 2026.
- When the platform sets the pricing:
  - "$2 per monthly active account" (a month with a payout);
  - "0.25% + 25¢ per payout sent";
  - for a payout to another country, "Starting at 0.25% of payout volume".
- A fee "starting at" a figure is not a ceiling, so the cross-border cost stays unknown. The worst cost per country is not on the page.
- Where it can pay: https://docs.stripe.com/connect/cross-border-payouts, read on 11 November 2026. "Platforms based in the US, UK, EEA, Canada, or Switzerland can transfer funds to connected accounts in any of those regions." Stripe "doesn’t support self-serve cross-border payouts to countries outside the listed regions".
- An affiliate in Brazil, or anywhere else outside those regions, cannot be paid this way.
- Each affiliate would also go through Stripe's own identity checks to open a connected account.

**Stripe Global Payouts, paying a person by bank, card or wire**
- Source: https://docs.stripe.com/global-payouts, read on 11 November 2026.
- Available to businesses in the US and the UK. It "requires Treasury". SR5 records that Stripe Treasury was mentioned only for whoever is eligible, not as a contract or a promise.
- The page gives no fee, so its cost is unknown.
- Recipients: https://docs.stripe.com/global-payouts/recipient-requirements, read on 11 November 2026. For a US sender and an individual recipient, the list of countries runs from Albania to Vietnam. **Brazil is not in the list**, so an affiliate in Brazil cannot be paid this way either.

**Not read here.** This session's network does not reach these sites, so each stays unknown, never zero:
- **PayPal** Payouts: its fee per payment and per country could not be read.
- **Wise**: its transfer fee could not be read. The creators' payout batch file is already shaped for it (\`lib/affiliate-payouts.ts\`).
- The IRS forms a US company collects before paying:
  - **W-9** for a US person could not be read;
  - **W-8BEN** for anyone else could not be read;
  - whether a **1099** is due, and from what amount, could not be read.

  Any withholding on a payment to a foreign person also stays unknown. TX point 8 (no US federal tax on the LLC's foreign-source income) is about the LLC's own income, not about what it pays others.

**What this means for the proposal.** No payout channel has a known worst cost per payment for every country an affiliate may live in. The next step is for a session that can reach paypal.com, wise.com and irs.gov to read them, dated, and add the dearest cost to the net. Until then, the programme can only be planned for affiliates in the regions Stripe Connect reaches, and still with that unknown cross-border fee.

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
