import { HISTORICAL_MARGIN_NOTICE } from "./historical-margin-model";
/**
 * Where a usage pack's price comes from (18 October 2026): an ANALYSIS for
 * the owner, not a change. No price, limit, gate or tax assumption in code
 * changes with it, and nothing opens a sale.
 *
 * docs/pricing-usage-proposal-2026-10-18.md found that under the 60% rule a
 * unit of use has to sell at about twenty times what it costs (2,500 list
 * emails at $62, $24.80 a thousand, against HighLevel's $0.675). This file
 * takes that price apart, cent by cent, with the repository's own margin
 * code, and prices four structural options with the same code:
 *
 *   - every net, fee, reserve, tax and room is lib/receiving-costs.ts
 *     (unitUnder, receivingOf, costBudgetCents, the sizing reading);
 *   - every pack, its unit cost and its price is
 *     tests/pricing-usage-proposal-table.ts (PACKS, packPriceCents, atScale,
 *     linePriceCents), which reads the registry's unit costs;
 *   - the two supplier rates looked at again (Amazon SES for list email, R2
 *     for stored files) enter only as a pack's cost, through the same
 *     packPriceCents.
 *
 * Nothing here is margin arithmetic of its own: it only chooses what to take
 * apart, which sizes and credit amounts to look at, and the supplier rates
 * read on READ_ON, each with its page.
 *
 * `node scripts/pack-cost-decomposition.mjs` writes
 * docs/pack-cost-decomposition-2026-10-18.md from renderPackCostDecomposition();
 * tests/pack-cost-decomposition.test.ts fails when the file on disk is not
 * what this renders.
 */
import { R2_STORAGE_MICRO_USD_PER_GB_MONTH } from "@/lib/spend-cost-table";
import { ADD_ON_ROOM_CENTS } from "@/lib/store-assistant-rules";
import {
  DISPUTE_COUNTER_FEE_CENTS, DISPUTE_FEE_CENTS, DISPUTE_RESERVE_BPS, FLOOR_BPS, PROVIDER_FEES, REFUND_RESERVE_BPS, REMITTANCE_BPS,
  SIZING_READING, STRESS_PROFIT_TAX_BPS, STRIPE_TOTAL_BPS, costBudgetCents, receivingOf, unitUnder, type Reading, type UnitResult,
} from "./historical-margin-model";
import { CLOSING_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { PACKS, atScale, linePriceCents, packPriceCents, packUnit, type Pack } from "./pricing-usage-proposal-table";
import { PER_EMAIL, POLL_SEND_USD, STORAGE_PER_GB } from "./plan-cost-registry";

/** The day the supplier pages below were read and this analysis made. */
export const READ_ON = "18 October 2026";

/** A pack's usage in whole cents, rounded up, exactly as the proposal prices it. */
export const centsUp = (usd: number) => Math.ceil(Math.round(usd * 1e7) / 1e5);

// ------------------------------------------------------------- the decomposition

/** The buyer's tax on top taken away, used only to say how much of each fee is charged on that tax. */
const NO_TAX_ON_TOP: Reading = { ...SIZING_READING, id: "attribution-no-tax-on-top", label: "attribution only", salesTaxOnTopBps: 0 };

export type Decomposition = {
  pack: Pack;
  priceCents: number;
  unit: UnitResult;
  /** The fee's percentages, and the fixed part of the dearer provider's fee. */
  feePctCents: number;
  feeFixedCents: number;
  /** The dispute reserve's percentage of the amount charged, and its share of the two fixed dispute fees. */
  disputePctCents: number;
  disputeFixedCents: number;
  /** Of the fee and the dispute reserve, what is charged on the buyer's tax added on top. */
  onTaxOnTopCents: number;
  /** A pack carries no share of the stores that pay nothing (their share is in each plan's own payment). */
  freeShareCents: number;
  /** What the 60% floor and the profit tax leave for every cost (costBudgetCents). */
  budgetCents: number;
  /** Room the whole-dollar price leaves unused, the 25¢ kept for the add-on included. */
  unusedCents: number;
};

export function decompose(pack: Pack, priceCents = packPriceCents(pack)): Decomposition {
  const unit = unitUnder(priceCents, centsUp(pack.costUsd), SIZING_READING, true);
  const pctOnly = receivingOf(priceCents, SIZING_READING, false);
  const untaxed = receivingOf(priceCents, NO_TAX_ON_TOP, true);
  const budgetCents = costBudgetCents(unit.revenueCents, SIZING_READING);
  return {
    pack, priceCents, unit,
    feePctCents: pctOnly.feeCents,
    feeFixedCents: unit.feeCents - pctOnly.feeCents,
    disputePctCents: pctOnly.disputeReserveCents,
    disputeFixedCents: unit.disputeReserveCents - pctOnly.disputeReserveCents,
    onTaxOnTopCents: unit.feeCents + unit.disputeReserveCents - untaxed.feeCents - untaxed.disputeReserveCents,
    freeShareCents: 0,
    budgetCents,
    unusedCents: budgetCents - unit.totalCents - unit.usageCents,
  };
}

/**
 * The price over the cost of the use, as four factors that multiply back to
 * it exactly: what the 60% floor and the profit tax leave; what the fee's and
 * the reserves' percentages take of that; what their fixed cents take of the
 * rest; and what the whole-dollar price leaves unused.
 */
export type Ladder = { floorAndTax: number; percentages: number; fixed: number; rounding: number; total: number };
export function ladder(d: Decomposition): Ladder {
  const pctCents = receivingOf(d.priceCents, SIZING_READING, false).totalCents;
  const afterPct = d.budgetCents - pctCents;
  const room = d.unit.usageRoomCents;
  const floorAndTax = d.unit.revenueCents / d.budgetCents;
  const percentages = d.budgetCents / afterPct;
  const fixed = afterPct / room;
  const rounding = room / d.unit.usageCents;
  return { floorAndTax, percentages, fixed, rounding, total: d.unit.revenueCents / d.unit.usageCents };
}

/** The same model on $100 with nothing used: what the structure takes of a dollar, before any use. */
export function perHundred(): { unit: UnitResult; pctCents: number; budgetCents: number } {
  const unit = unitUnder(10_000, 0, SIZING_READING, true);
  return { unit, pctCents: receivingOf(10_000, SIZING_READING, false).totalCents, budgetCents: costBudgetCents(unit.revenueCents, SIZING_READING) };
}

// ------------------------------------------------------------- the supplier rates, read again

export type SupplierRate = { line: string; constant: string; inUse: string; source: string; url: string; read: string; finding: string; verdict: "kept" | "cheaper only if built" | "possibly low" | "not re-read" };

/** Amazon SES, its dearest listed outbound rate (the Enterprise plan, 0 to 10 million a month): $0.23 a thousand. */
export const SES_DEAREST_PER_EMAIL = 0.23 / 1_000;
/** Cloudflare R2 Standard storage, from the repository's own table (lib/spend-cost-table.ts, read 2026-10-17). */
export const R2_PER_GB = R2_STORAGE_MICRO_USD_PER_GB_MONTH / 1_000_000;

export const SUPPLIER_RATES: SupplierRate[] = [
  {
    line: "List emails (and the order pack's access and store emails)", constant: "PER_EMAIL (tests/plan-cost-registry.ts)", inUse: `$${(PER_EMAIL * 1_000).toFixed(2)} per 1,000`,
    source: "Resend pricing", url: "https://resend.com/pricing", read: READ_ON,
    finding: "Pro $20 a month for 50,000 and Scale $90 for 100,000; both: \"Extra emails: $0.90 / 1,000\"; overage \"Available to paid subscriptions\". The paid unit price at its most expensive tier is $0.90.",
    verdict: "kept",
  },
  {
    line: "List emails, the other sender (lib/ses.ts)", constant: "none: the registry prices every email at Resend's rate", inUse: "not used in any figure",
    source: "Amazon SES pricing", url: "https://aws.amazon.com/ses/pricing/", read: `${READ_ON} (page updated 2026-10-15)`,
    finding: "Outbound \"$0.10 / 1,000 emails\" à la carte; the plans charge $0.16 (Essentials), $0.22 (Pro), $0.23 (Enterprise) a thousand from 0 to 10 million; new accounts start on Essentials from 21 July 2026; attachments $0.12 a GB on top. The dearest listed rate is $0.23.",
    verdict: "cheaper only if built",
  },
  {
    line: "Storage", constant: "STORAGE_PER_GB (tests/plan-cost-registry.ts)", inUse: `$${STORAGE_PER_GB.toFixed(3)} per GB-month`,
    source: "Vercel pricing (Blob storage)", url: "https://vercel.com/pricing", read: READ_ON,
    finding: "Blob storage \"$0.023 per GB\": the dearest of the three stores a file may be in (R2 $0.015, Bunny Stream $0.01 a region).",
    verdict: "kept",
  },
  {
    line: "Storage, the store sold files are in (lib/vault.ts)", constant: "R2_STORAGE_MICRO_USD_PER_GB_MONTH (lib/spend-cost-table.ts)", inUse: `$${R2_PER_GB.toFixed(3)} per GB-month, not used by the storage line`,
    source: "Cloudflare R2 pricing", url: "https://developers.cloudflare.com/r2/pricing/", read: "not re-read: the fetch was refused on 18 October 2026; the repository's reading of 17 October 2026 is used",
    finding: "R2 Standard $0.015 per GB-month (lib/spend-cost-table.ts). Lower than $0.023 only for bytes the code proves are in R2.",
    verdict: "cheaper only if built",
  },
  {
    line: "Video hours watched", constant: "STREAM_DELIVERY_PER_GB (tests/plan-cost-registry.ts)", inUse: "$0.005 per GB",
    source: "Bunny Stream pricing", url: "https://bunny.net/docs/stream/pricing", read: READ_ON,
    finding: "Volume tier \"0 to 500 TB: $0.005\" a GB (its dearest volume tier); the Standard tier is billed by region, up to $0.060 a GB (Middle East & Africa). $0.005 holds only while the library is on the Volume tier, a library setting the code does not read.",
    verdict: "possibly low",
  },
  {
    line: "Visits (the host's share)", constant: "visitCost() (tests/traffic-cost.ts)", inUse: "$0.60 per million calls, $0.128 a CPU-hour, $0.0106 a GB-hour, $0.06 a GB origin transfer",
    source: "Vercel pricing", url: "https://vercel.com/pricing", read: READ_ON,
    finding: "The same four rates, each marked \"Starting at\" (regional pricing may be higher); CDN requests \"Included in Flat Rate CDN\", whose amount the page does not show.",
    verdict: "kept",
  },
  {
    line: "Visits and every request (the database)", constant: "UPSTASH_MICRO_USD_PER_MILLION_COMMANDS (lib/spend-cost-table.ts)", inUse: "$2.00 per million commands",
    source: "Upstash Redis pricing", url: "https://upstash.com/pricing/redis", read: READ_ON,
    finding: "\"$0.20 per 100K commands\"; storage $0.25 a GB past the first; bandwidth $0.03 a GB past 200 GB. Free quotas are not counted.",
    verdict: "kept",
  },
  {
    line: "AI writing jobs and answers", constant: "ANTHROPIC_RATES (lib/spend-cost-table.ts)", inUse: "Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50 a million tokens, +10% provider charges",
    source: "Anthropic pricing", url: "https://platform.claude.com/docs/en/about-claude/pricing", read: READ_ON,
    finding: "Sonnet 5.5 $2 in / $10 out; Haiku 5.5 $0.10 / $0.50 up to 100,000 prompt tokens, $0.50 / $2.50 above. The rates match; the unit is a hard bound (every byte a token, the whole max_tokens), which a price page cannot show too high.",
    verdict: "kept",
  },
  {
    line: "Receiving a payment", constant: "PROVIDER_FEES (lib/receiving-costs.ts)", inUse: `Stripe ${STRIPE_TOTAL_BPS / 100}% + ${PROVIDER_FEES.stripe.fixedCents}¢, Paddle ${PROVIDER_FEES.paddle.bps / 100}% + ${PROVIDER_FEES.paddle.fixedCents}¢, the dearer`,
    source: "Stripe pricing", url: "https://stripe.com/pricing", read: "not re-read: the fetch was refused on 18 October 2026; the repository's reading of 17 October 2026 is used",
    finding: "2.9% + 30¢, +1.5% international card, +1% currency conversion, +0.7% Billing, +0.5% Tax; dispute $15, and $15 to counter it (lib/receiving-costs.ts). A third-party page read today (checkoutpage.com) says the 1% applies only \"when the payment currency does not match your settlement currency\": not Stripe's own page, so nothing is changed on it.",
    verdict: "not re-read",
  },
];

// ------------------------------------------------------------- option 1: a line on the renewal invoice

export type LineOption = { pack: Pack; times: number; priceCents: number; unit: UnitResult; unpaidLossCents: number };
/** The same amount as a line on the store's next renewal invoice, used before it is paid, and what it loses when that invoice is never paid. */
export function lineOption(pack: Pack, times = 1): LineOption {
  const p = times === 1 ? pack : atScale(pack, times);
  const priceCents = linePriceCents(p);
  const unit = unitUnder(priceCents, centsUp(p.costUsd), SIZING_READING, false);
  // Never paid: nothing is collected and no fee is charged on a failed invoice; the use already happened.
  return { pack: p, times, priceCents, unit, unpaidLossCents: centsUp(p.costUsd) };
}

// ------------------------------------------------------------- option 2: larger packs

export const SIZES = [1, 4, 10, 40] as const;
export type SizeOption = { pack: Pack; times: number; priceCents: number; unit: UnitResult };
export function sizeOption(pack: Pack, times: number): SizeOption {
  const p = times === 1 ? pack : atScale(pack, times);
  return { pack: p, times, priceCents: packPriceCents(p), unit: packUnit(p) };
}

// ------------------------------------------------------------- option 3: prepaid credits

/** Credit amounts looked at, in cents: each bought on its own payment, before any of it is used. */
export const CREDIT_AMOUNTS = [5_000, 10_000, 25_000, 50_000, 100_000] as const;
export type CreditRate = { pack: Pack; centsPerDisplay: number; unitsBought: number; costCents: number };
export type CreditOption = { amountCents: number; roomCents: number; multiplier: number; rates: CreditRate[]; worst: UnitResult };
/**
 * A credit of this amount, spendable on any pack's resource at one rate each:
 * every rate is the resource's unit cost times the same multiplier (what the
 * amount's room for use, less the add-on's 25¢, allows), rounded up to the
 * cent per the unit the pack prints. However the credit is spent, its use
 * costs at most what spending it all on the dearest-to-serve resource costs,
 * which `worst` holds to 60%.
 */
export function creditOption(amountCents: number, listEmailVia: "resend" | "ses-only" = "resend"): CreditOption {
  const roomCents = unitUnder(amountCents, 0, SIZING_READING, true).usageRoomCents - ADD_ON_ROOM_CENTS;
  const multiplier = amountCents / roomCents;
  const rates = PACKS.map((pack) => {
    const costPerUnitUsd = pack.id === "list-email" && listEmailVia === "ses-only" ? SES_DEAREST_PER_EMAIL + POLL_SEND_USD : pack.costUsd / pack.units;
    const centsPerDisplay = Math.ceil(Math.round(costPerUnitUsd * pack.per * 100 * multiplier * 1e6) / 1e6);
    const unitsBought = Math.floor((amountCents * pack.per) / centsPerDisplay);
    return { pack, centsPerDisplay, unitsBought, costCents: centsUp(unitsBought * costPerUnitUsd) };
  });
  const worstCost = Math.max(...rates.map((r) => r.costCents));
  return { amountCents, roomCents, multiplier, rates, worst: unitUnder(amountCents, worstCost, SIZING_READING, true) };
}

// ------------------------------------------------------------- option 4: supplier rates

/** The list-email pack with every email sent by Amazon SES at its dearest listed rate, and the storage pack with every byte in R2. */
export function supplierVariant(id: "list-email" | "storage", times = 1): { pack: Pack; priceCents: number; unit: UnitResult } {
  const base = PACKS.find((p) => p.id === id)!;
  const scaled = times === 1 ? base : atScale(base, times);
  const costUsd = id === "list-email" ? scaled.units * (SES_DEAREST_PER_EMAIL + POLL_SEND_USD) : scaled.units * R2_PER_GB * (1 + (CLOSING_DAYS + WARN_WEEK_DAYS) / 30);
  const pack = { ...scaled, costUsd, basis: id === "list-email" ? "Amazon SES at $0.23 a thousand, and the most an email's poll adds (POLL_SEND_USD)" : "R2 at $0.015 a GB-month" };
  return { pack, priceCents: packPriceCents(pack), unit: packUnit(pack) };
}

// ------------------------------------------------------------- the document

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const usd2 = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctOf = (bps: number) => `${bps < 0 ? "−" : ""}${(Math.abs(bps) / 100).toFixed(2)}%`;
const share = (cents: number, of: number) => `${usd2(cents)} (${((cents / of) * 100).toFixed(2)}%)`;
const x = (n: number) => `${n.toFixed(2)}×`;
const num = (n: number) => n.toLocaleString("en-US");
const perUnit = (pack: Pack, cents: number) => `${usd2((cents / pack.units) * pack.per)} per ${pack.perName}`;
const EMAIL = () => PACKS.find((p) => p.id === "list-email")!;
const HIGHLEVEL_PER_THOUSAND_CENTS = 67.5;

export function renderPackCostDecomposition(): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);
  const h = perHundred();
  const email = decompose(EMAIL());
  const el = ladder(email);

  push("# Where a usage pack's price comes from, and four ways to lower it: 18 October 2026");
  push("");
  push("<!-- Generated by `node scripts/pack-cost-decomposition.mjs` from tests/pack-cost-decomposition-table.ts. Do not edit by hand: tests/pack-cost-decomposition.test.ts fails when this file is stale. -->");
  push("");
  push("**An analysis for the owner, not a change.** No price, limit, gate or tax assumption in code changes with it, and `PLANS_ON_SALE` stays false. Every figure is computed by the repository's own margin code (lib/receiving-costs.ts `unitUnder`, `receivingOf`, `costBudgetCents`, under the sizing reading; tests/pricing-usage-proposal-table.ts `PACKS`, `packPriceCents`, `atScale`, `linePriceCents`); none is typed. It takes apart the packs of docs/pricing-usage-proposal-2026-10-18.md.");
  push("");
  push("## The short answer");
  push("");
  push(`The list-email pack sells ${email.pack.what} for ${usd(email.priceCents)}: ${x(el.total)} the ${usd2(email.unit.usageCents)} the emails cost. That multiplier is four factors that multiply back to it exactly:`);
  push("");
  push("| Factor | What it is | List-email pack | Share of the multiplier (by logarithm) |");
  push("| --- | --- | --- | --- |");
  const logShare = (f: number) => `${((Math.log(f) / Math.log(el.total)) * 100).toFixed(0)}%`;
  push(`| 1. The 60% floor and the ${STRESS_PROFIT_TAX_BPS / 100}% profit tax | Net must be ${FLOOR_BPS / 100}% after a ${STRESS_PROFIT_TAX_BPS / 100}% tax, so pretax profit must be ${((FLOOR_BPS / (10_000 - STRESS_PROFIT_TAX_BPS)) * 100).toFixed(2)}% of revenue and every cost together at most ${((h.budgetCents / h.unit.revenueCents) * 100).toFixed(2)}% | ${x(el.floorAndTax)} | ${logShare(el.floorAndTax)} |`);
  push(`| 2. The fee's and the reserves' percentages | ${STRIPE_TOTAL_BPS / 100}% of the amount charged (the price plus the buyer's ${SIZING_READING.salesTaxOnTopBps / 100}% tax on top), ${REMITTANCE_BPS / 100}% remittance, ${REFUND_RESERVE_BPS / 100}% refund reserve, ${DISPUTE_RESERVE_BPS / 100}% of the amount charged as dispute reserve | ${x(el.percentages)} | ${logShare(el.percentages)} |`);
  push(`| 3. The fixed cents of one payment | the fee's ${PROVIDER_FEES.stripe.fixedCents}¢ and the dispute reserve's ${DISPUTE_RESERVE_BPS / 100}% of $${(DISPUTE_FEE_CENTS + DISPUTE_COUNTER_FEE_CENTS) / 100} | ${x(el.fixed)} | ${logShare(el.fixed)} |`);
  push(`| 4. A whole-dollar price and the add-on's ${ADD_ON_ROOM_CENTS}¢ of room | what the price leaves unused | ${x(el.rounding)} | ${logShare(el.rounding)} |`);
  push(`| **Price over cost** | | **${x(el.total)}** | 100% |`);
  push("");
  push(`Factors 1 and 2 together are ${x(el.floorAndTax * el.percentages)}: the "twenty times" of the proposal, and the floor no pack size can go under. Factor 1 alone is the owner's rule (60% after at least 27.5%): it makes any cost cost ${x(el.floorAndTax)} in price. Factor 2 is the receiving model shared with Hazelsong. **The email itself is ${((email.unit.usageCents / email.priceCents) * 100).toFixed(2)}% of the pack's price; the supplier's rate is not what makes the pack dear.**`);
  push("");
  push("## The structure, on $100 with nothing used");
  push("");
  push(`Under the sizing reading (the buyer's tax on top at ${SIZING_READING.salesTaxOnTopBps / 100}%, remittance ${SIZING_READING.remittanceBps / 100}%, at least ${SIZING_READING.profitTaxBps / 100}% on profit), a $100 payment on its own:`);
  push("");
  push("| Line | $100 payment |");
  push("| --- | --- |");
  push(`| Charged to the buyer (the price plus the tax on top) | ${usd2(h.unit.chargedCents)} |`);
  push(`| The dearer provider's fee | ${usd2(h.unit.feeCents)} |`);
  push(`| Remittance | ${usd2(h.unit.remittanceCents)} |`);
  push(`| Refund reserve | ${usd2(h.unit.refundReserveCents)} |`);
  push(`| Dispute reserve | ${usd2(h.unit.disputeReserveCents)} |`);
  push(`| Every cost the 60% floor and the profit tax allow | ${usd2(h.budgetCents)} |`);
  push(`| Left for the use itself | ${usd2(h.unit.usageRoomCents)} |`);
  push("");
  push(`So a dollar of use needs about ${usd2((h.unit.revenueCents / h.unit.usageRoomCents) * 100)} of price at this size, and about ${x(h.unit.revenueCents / (h.budgetCents - h.pctCents))} at any size once the fixed cents are spread thin.`);
  push("");
  push("## Every pack, taken apart");
  push("");
  push("Each pack of the proposal at its price, on its own payment, used in full. Every line is in dollars and as a share of the price (revenue: no tax is inside the price under the sizing reading).");
  push("");
  push("| Pack | Price | Use (cost) | Fee, percentages | Fee, fixed | Remittance | Refund reserve | Dispute reserve, % | Dispute reserve, fixed | Free-account share | Profit tax | Unused room | Net |");
  push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const all = PACKS.map((p) => decompose(p));
  for (const d of all) {
    const r = d.unit.revenueCents;
    push(`| ${d.pack.what} | **${usd(d.priceCents)}** | ${share(d.unit.usageCents, r)} | ${share(d.feePctCents, r)} | ${share(d.feeFixedCents, r)} | ${share(d.unit.remittanceCents, r)} | ${share(d.unit.refundReserveCents, r)} | ${share(d.disputePctCents, r)} | ${share(d.disputeFixedCents, r)} | ${share(d.freeShareCents, r)} | ${share(d.unit.taxCents, r)} | ${share(d.unusedCents, r)} | ${share(d.unit.netCents, r)} |`);
  }
  push("");
  push("Every column but the unused room adds up to the price: use, fee, remittance, reserves and tax are the unit's costs, and the net is what is left. The unused room is part of the net: what the whole-dollar price leaves above 60%, the add-on's 25¢ included.");
  push("");
  push(`- **Of the fee and the dispute reserve, what is charged on the buyer's tax added on top**: ${all.map((d) => `${d.pack.id} ${usd2(d.onTaxOnTopCents)}`).join(", ")}. The providers charge their percentages on the whole amount the buyer pays, ${SIZING_READING.salesTaxOnTopBps / 100}% more than the price at the worst.`);
  push("- **Free-account share: none.** A pack's own payment carries none of the stores that pay nothing; their share (line free-share, 1/40 of a free store's worst window) is in each plan's own payment. Selling packs to stores whose plan carries that share leaves it where it is.");
  push("- **Sales tax on top** is not revenue and not a cost of its own here: it is collected for the state and passed on; what it costs is the fee and dispute reserve charged on it, in the line above.");
  push("");
  push("The four factors, for every pack:");
  push("");
  push("| Pack | Floor and tax | Percentages | Fixed cents | Whole dollar and room | Price over cost |");
  push("| --- | --- | --- | --- | --- | --- |");
  for (const d of all) { const l = ladder(d); push(`| ${d.pack.what} | ${x(l.floorAndTax)} | ${x(l.percentages)} | ${x(l.fixed)} | ${x(l.rounding)} | **${x(l.total)}** |`); }
  push("");
  push("The smaller the cost of a pack's use, the larger factors 3 and 4: the video pack's use is so small that its fixed cents and its rounding nearly double its price.");
  push("");
  push("## The unit costs, read again");
  push("");
  push(`The owner's rule: never count a supplier's free quota as zero cost; use the paid unit price at its most expensive tier. Each rate a pack's cost rests on, read again on ${READ_ON} on the supplier's own page:`);
  push("");
  push("| Line | Constant | In use | Source | Read | What the page says | Verdict |");
  push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const s of SUPPLIER_RATES) push(`| ${s.line} | ${s.constant} | ${s.inUse} | [${s.source}](${s.url}) | ${s.read} | ${s.finding} | **${s.verdict}** |`);
  push("");
  push("No rate in use is shown too high by its own page at its dearest tier. Two are higher than they must be **only if something is built**: list email sent by Amazon SES alone (option 4), and stored bytes proven to be in R2. One may be **too low**: video delivery at $0.005 a GB holds only while Bunny Stream's library stays on the Volume tier; on the Standard tier the dearest region is twelve times that. That is an open item for the owner (the library's setting in Bunny's dashboard, which nothing here can read), not a reason to lower anything.");
  push("");
  push("## Option 1: a line on the renewal invoice (not offered)");
  push("");
  push(`Not offered, by the owner's rule of 18 October 2026: the customer always pays first, then receives, so every pack, credit and per-use service is prepaid and stops at zero. Billed after use it would save only a pack's own fixed cents (2,500 list emails at ${usd(lineOption(EMAIL()).priceCents)} instead of ${usd(email.priceCents)}) and create a non-payment exposure to fund; \`lineOption\` keeps the arithmetic for the record.`);
  push("");
  push("## Option 2: larger packs");
  push("");
  push("The same packs at one, four, ten and forty times their amount, each prepaid on its own payment and priced by the proposal's own `packPriceCents`:");
  push("");
  push("| Pack | " + SIZES.map((t) => `${t}×: price, per unit, price over cost`).join(" | ") + " |");
  push("| --- | " + SIZES.map(() => "---").join(" | ") + " |");
  for (const pack of PACKS) {
    push(`| ${pack.what} | ` + SIZES.map((t) => { const s = sizeOption(pack, t); return `${usd(s.priceCents)}, ${perUnit(s.pack, s.priceCents)}, ${x(s.priceCents / s.unit.usageCents)}`; }).join(" | ") + " |");
  }
  push("");
  push(`Factor 3 and factor 4 shrink toward 1 as the amount grows; factors 1 and 2 stay. A larger pack asks the buyer to commit a larger sum to one resource, and every pack is used in full only in the worst case the owner's rule prices: the buyer who uses less pays the same. Nothing new has to be built beyond the packs themselves.`);
  push("");
  push("## Option 3: prepaid credits bought in larger amounts");
  push("");
  push(`A credit balance bought on its own payment and spent on any of the six resources, each at one rate: its unit cost times the multiplier the amount allows (its room for use, less the add-on's ${ADD_ON_ROOM_CENTS}¢), rounded up to the cent. However it is spent, its use costs at most what spending it all on one resource costs, and that worst case is held to 60%.`);
  push("");
  push("| Credit bought | Price over cost | " + PACKS.map((p) => `Per ${p.perName}`).join(" | ") + " | Net, the whole credit on its dearest-to-serve resource |");
  push("| --- | --- | " + PACKS.map(() => "---").join(" | ") + " | --- |");
  for (const amount of CREDIT_AMOUNTS) {
    const c = creditOption(amount);
    push(`| ${usd(amount)} | ${x(c.multiplier)} | ` + c.rates.map((r) => usd2(r.centsPerDisplay)).join(" | ") + ` | ${pctOf(c.worst.netBps)} |`);
  }
  push("");
  push("Each rate column is per the unit its pack prints (per 1,000 visits, per order with its emails, per 1,000 list emails, per writing job with 5 answers, per GB of storage for a window and its closing days, per video hour watched).");
  push("");
  push("Credits do what larger packs do without asking the buyer to guess which resource they will need, and they stay prepaid: nothing is used before it is paid, and use stops automatically when the balance reaches zero. What they need besides the packs:");
  push("");
  push("- a balance per store, taken before each use the way the window's figures are taken today, and refused when empty (each meter would draw on the plan's figure first and the balance after);");
  push("- a fixed life for a credit (say twelve months), because an unused balance is an obligation; a refund only while none of it was used (Hazelsong's rule for packs), so the 14-day money-back refund's funded exposure (docs/funded-exposure-review.md) is unchanged in kind;");
  push("- an optional automatic top-up when the balance runs low (HighLevel's wallet does this), each top-up its own prepaid payment at the same rates;");
  push("- the AI ceiling's company total (`companyMicroUsd`) counting what credits buy, as the proposal already says for packs.");
  push("");
  push("## Option 4: the supplier rates that could be lower, if built");
  push("");
  const sesEmail = (t: number) => supplierVariant("list-email", t);
  push(`**List email through Amazon SES only.** lib/email.ts already sends through SES whenever Amazon allows it and falls back to Resend otherwise, which is why every email is priced at Resend's $0.90. \`sendBatch\` already takes \`only: "amazon"\` and answers "retry" when Amazon cannot take the batch. If emails bought in a pack went only through SES and waited when it is down, their cost would be SES's dearest listed rate, $0.23 a thousand (the Enterprise plan; à la carte is $0.10), not $0.90:`);
  push("");
  push("| List emails | At Resend's $0.90 (today): price, per 1,000 | At SES's $0.23, SES only: price, per 1,000 | Net at SES |");
  push("| --- | --- | --- | --- |");
  for (const t of SIZES) {
    const s = sizeOption(EMAIL(), t), v = sesEmail(t);
    push(`| ${num(s.pack.units)} | ${usd(s.priceCents)}, ${usd2((s.priceCents / s.pack.units) * 1_000)} | ${usd(v.priceCents)}, ${usd2((v.priceCents / v.pack.units) * 1_000)} | ${pctOf(v.unit.netBps)} |`);
  }
  push("");
  push("What must be built: the pack's emails sent with `only: \"amazon\"` and held, not handed to Resend, while Amazon is down or out of its day; the pack's figure counting only what SES took; no attachments on list emails, or their $0.12 a GB counted; and the page saying pack emails can wait. The order pack's access and store emails must not wait (a buyer is owed their access), so they stay at Resend's rate.");
  push("");
  const r2 = supplierVariant("storage");
  push(`**Storage in R2 only.** A storage pack that raises only the room for sold files (lib/vault.ts, R2 at $0.015) would cost ${usd(r2.priceCents)} for ${r2.pack.what} instead of ${usd(packPriceCents(PACKS.find((p) => p.id === "storage")!))} (net ${pctOf(r2.unit.netBps)}). It is honest only if the code proves those bytes are in R2; the storage figure today counts a store's files in every store they may be in, at the dearest.`);
  push("");
  push("No other unit cost can be lowered from its own page: visits, the database and AI are priced at their published rates, and video may be low (above).");
  push("");
  push("## The options side by side, per 1,000 list emails");
  push("");
  const best = creditOption(CREDIT_AMOUNTS[CREDIT_AMOUNTS.length - 1]);
  const bestEmail = best.rates.find((r) => r.pack.id === "list-email")!;
  const c250 = creditOption(25_000).rates.find((r) => r.pack.id === "list-email")!;
  const sesCredit = (amountCents: number) => creditOption(amountCents, "ses-only").rates.find((r) => r.pack.id === "list-email")!.centsPerDisplay;
  push("| How it is sold | Per 1,000 list emails | Against HighLevel's $0.675 |");
  push("| --- | --- | --- |");
  const rows: [string, number][] = [
    ["The proposal: 2,500 in a prepaid pack", (email.priceCents / EMAIL().units) * 1_000],
    ["Option 2: 100,000 in a prepaid pack", (sizeOption(EMAIL(), 40).priceCents / sizeOption(EMAIL(), 40).pack.units) * 1_000],
    ["Option 3: from a $250 prepaid credit", c250.centsPerDisplay],
    ["Option 3: from a $1,000 prepaid credit", bestEmail.centsPerDisplay],
    ["Option 4: 2,500 in a prepaid pack, SES only", (sesEmail(1).priceCents / sesEmail(1).pack.units) * 1_000],
    ["Options 3 and 4: from a $250 prepaid credit, SES only", sesCredit(25_000)],
    ["Options 3 and 4: from a $1,000 prepaid credit, SES only", sesCredit(100_000)],
  ];
  for (const [label, cents] of rows) push(`| ${label} | ${usd2(cents)} | ${x(cents / HIGHLEVEL_PER_THOUSAND_CENTS)} |`);
  push("");
  push("## The one structural option that does the most");
  push("");
  push(`**Prepaid credits bought in larger amounts (option 3).** It is the only option that lowers factors 3 and 4 for every resource at once while staying prepaid, as the owner's rule requires (bought before use, stopping at zero), and with no bet by the buyer on one resource (option 2). At $250 a credit buys list email at ${usd2(c250.centsPerDisplay)} a thousand, at $1,000 ${usd2(bestEmail.centsPerDisplay)}, against ${usd2((email.priceCents / EMAIL().units) * 1_000)} in the proposal's pack; every other resource falls the same way (table above). Its floor is factors 1 and 2, about ${x(el.floorAndTax * el.percentages)} a unit's cost, which no structure removes while the 60% rule and the receiving model stand.`);
  push("");
  push(`For email specifically the larger lever is the supplier, not the structure: sending what a credit buys through Amazon SES alone (option 4) takes the $1,000 credit's rate to ${usd2(sesCredit(100_000))} a thousand. Even so it stays ${x(sesCredit(100_000) / HIGHLEVEL_PER_THOUSAND_CENTS)} HighLevel's rate: a creator who sends a lot of email will still compare it with ClickFunnels' and Kajabi's allowances.`);
  push("");
  push("## What this does not decide");
  push("");
  push("- **The rule and the receiving model.** Factor 1 is the owner's 60% after at least 27.5%; factor 2 is the receiving model the two products share (lib/receiving-costs.ts, aligned with Hazelsong's). Neither is changed or questioned here; under the most-tax reading (the gate) no pack and no option keeps 60%, exactly as today.");
  push("- **Stripe's own page was not read today** (the fetch was refused), so nothing is said about which of its surcharges a pack's payment would really pay. The model keeps the dearer of Stripe's 6.6% + 30¢ and Paddle's 5% + 50¢ either way.");
  push("- **Demand.** Whether creators buy credits, at which amounts, and how much of what they buy they use: unknown until a sale is open. Every net above is at full use, the owner's rule.");
  push("- **The order of building.** Credits need the packs' machinery first (a Stripe charge, a balance, the meters drawing on it, the pages and terms); SES-only routing needs the pack's figure and the waiting path. Nothing here builds either.");
  push("");
  return HISTORICAL_MARGIN_NOTICE + out.join("\n");
}
