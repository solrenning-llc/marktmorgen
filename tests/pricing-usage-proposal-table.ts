import { HISTORICAL_MARGIN_NOTICE } from "./historical-margin-model";
/**
 * A PROPOSAL, not a change (18 October 2026): a HighLevel-style price list
 * for Marktmorgen. Each plan at an entry price near the competitor plan a
 * buyer will set it beside, a smaller INCLUDED amount of the resources that
 * cost money per use, and everything above it sold in prepaid packs, each
 * pack keeping 60% on its own after every fee and tax. No price, limit or
 * gate in code is changed by any of this, and nothing opens a sale.
 *
 * Nothing here is margin arithmetic of its own. Every net, floor and room is
 * lib/receiving-costs.ts (unitUnder, the sizing reading and the most-tax
 * reading); a plan's usage at full use is tests/limits-proposal-table.ts
 * (usageCents, figures, tidy), which reads tests/plan-cost-registry.ts; the
 * lowest price that keeps 60% is tests/margin-alignment-table.ts
 * (floorPriceCents, roomKept); a pack's unit costs are the registry's own
 * (visitCost, ORDER_COST, PER_EMAIL, UNIT_COST, hourCost, STORAGE_PER_GB)
 * and the AI cost table's (WRITING_JOB_MICRO_USD, ANSWER_MICRO_USD). This
 * file only chooses: which prices to look at, which sizes a pack comes in,
 * and the rule for the recommended point, all stated in the document.
 *
 * `node scripts/pricing-usage-proposal.mjs` writes
 * docs/pricing-usage-proposal-2026-10-18.md from renderPricingUsageProposal();
 * tests/pricing-usage-proposal.test.ts fails when the file on disk is not
 * what this renders.
 */
import { PLAN_PRICES, PLAN_TITLES, TIERS, type Cycle, type Tier } from "@/lib/plan";
import { REQUESTS_PER_VISIT } from "@/lib/traffic-rules";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { CLOSING_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { ANSWER_MICRO_USD, WRITING_JOB_MICRO_USD } from "@/lib/spend-cost-table";
import { ADD_ON_ROOM_CENTS } from "@/lib/store-assistant-rules";
import { PIPELINES_BY_TIER } from "@/lib/crm-rules";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { MAX_LESSONS } from "@/lib/course";
import { MAX_FORMS } from "@/lib/forms";
import { MAX_TEAM } from "@/lib/team";
import {
  FLOOR_BPS, MOST_TAX_READING, PROVIDER_FEES, SIZING_READING, STRIPE_TOTAL_BPS, unitUnder, type UnitResult,
} from "./historical-margin-model";
import { ORDER as PRINTED, figures, tidy, usageCents, type Printed } from "./limits-proposal-table";
import { floorPriceCents } from "./historical-margin-model";
import { COMMAND, GB, NOT_A_COST, ORDER_COST, PER_EMAIL, REQUEST_COMMANDS, STORAGE_PER_GB, UNIT_COST, hourCost } from "./plan-cost-registry";
import { visitCost } from "./traffic-cost";

/** The day the competitors below were read, and this proposal made. */
export const READ_ON = "18 October 2026";

// ------------------------------------------------------------- the figures before

/**
 * The printed figures before PR #553 (merged 18 October 2026): the same as
 * today's except the three it raised (Store visits 3,000 → 3,400, Studio list
 * emails 5,000 → 7,000, Scale 8,000 → 10,000; docs/value-presentation-2026-10-18.md).
 * tests/pricing-usage-proposal.test.ts holds every other figure equal to the code.
 */
export const RAISED_BY_553: Partial<Record<Tier, Partial<Record<Printed, number[]>>>> = {
  creator: { visits: [3_000] },
  pro: { "list-email": [5_000] },
  scale: { "list-email": [8_000] },
};
/** The prices before PR #553 (the price list without a share of each sale, lib/plan.ts LEGACY_PLAN_PRICES[0]). */
export const PRICES_BEFORE_553: Record<Tier, Record<Cycle, number>> = {
  creator: { month: 2_900, year: 30_000 },
  pro: { month: 9_900, year: 94_800 },
  scale: { month: 24_900, year: 238_800 },
};
export function figuresBefore553(tier: Tier): Record<Printed, number[]> {
  return { ...figures(tier), ...(RAISED_BY_553[tier] ?? {}) } as Record<Printed, number[]>;
}

// ------------------------------------------------------------- the plans

/** The monthly prices looked at for each plan, in cents; the year is always ten monthly payments, Marktmorgen's convention. */
export const PRICE_POINTS: Record<Tier, number[]> = {
  // 7_900 to 19_900 since 4 November 2026 (C4-4): with the private calendar feed's and the store readings' own cost lines, no point up to $69 reaches the share; looked at only, nothing proposed is in force.
  creator: [2_900, 3_500, 3_900, 4_900, 5_900, 6_900, 7_900, 8_900, 9_900, 12_900, 14_900, 16_900, 19_900],
  pro: [9_900, 12_900, 14_900, 19_900, 24_900, 29_900, 44_900],
  scale: [19_900, 24_900, 29_900, 34_900, 39_900, 49_900, 99_900],
};
/** The year at ten monthly payments. */
export const yearOf = (monthCents: number) => monthCents * 10;
/** The room the spend floor test keeps under a plan on sale: 25¢ a month, $1 a year (tests/margin-alignment-table.ts roomKept). */
const PLAN_ROOM: Record<Cycle, number> = { month: 25, year: 100 };

/**
 * The recommendation rule, stated in the document: the lowest price point at
 * which the plan includes at least this share of every #553 figure that costs
 * money per use, on both intervals. Below it the included amounts are too
 * small to read as a plan at all; above it every dollar of price buys more
 * included use and a higher card price beside the competitor's.
 */
export const MIN_INCLUDED_SHARE = 0.1;

/** A printed figure at a share of today's, rounded down the way a page prints it; a share of 1 keeps today's. Zero stays zero. */
function figureAt(id: Printed, today: number, share: number): number {
  if (today === 0) return 0;
  if (share >= 1) return today;
  if (share <= 0) return 0;
  return Math.min(today, tidy(id, today * share));
}
/**
 * Kept in full at every price: video hours, the cheapest per-use line by far
 * (hourCost(), about a cent and a half an hour watched) and what a course
 * seller looks at first. Every other per-use figure takes the plan's share.
 */
export const KEPT_IN_FULL: readonly Printed[] = ["video"];
export function includedAt(tier: Tier, share: number): Record<Printed, number[]> {
  const today = figures(tier);
  return Object.fromEntries(PRINTED.map((id) => [id, today[id].map((n) => figureAt(id, n, KEPT_IN_FULL.includes(id) ? 1 : share))])) as Record<Printed, number[]>;
}
/** The share of today's each line is at, read from the figures (the first non-zero one of a line). */
function sharesOf(tier: Tier, included: Record<Printed, number[]>): Partial<Record<Printed, number>> {
  const today = figures(tier);
  const out: Partial<Record<Printed, number>> = {};
  for (const id of PRINTED) {
    const i = today[id].findIndex((n) => n > 0);
    if (i >= 0) out[id] = included[id][i] / today[id][i];
  }
  return out;
}
/** A plan unit at its price, every included figure used in full, under a reading. */
export function planAt(tier: Tier, cycle: Cycle, monthCents: number, included: Record<Printed, number[]>, reading = SIZING_READING): UnitResult {
  const price = cycle === "year" ? yearOf(monthCents) : monthCents;
  return unitUnder(price, usageCents(tier, cycle, sharesOf(tier, included)), reading, true);
}
function keepsWithRoom(tier: Tier, monthCents: number, included: Record<Printed, number[]>): boolean {
  return (["month", "year"] as const).every((cycle) => {
    const u = planAt(tier, cycle, monthCents, included);
    return u.meetsFloor && u.usageRoomCents - u.usageCents >= PLAN_ROOM[cycle];
  });
}

export type PlanPoint = {
  tier: Tier;
  monthCents: number;
  /** The largest share of every #553 figure the plan can include at this price, on both intervals with the room; null when even none can. */
  share: number | null;
  included: Record<Printed, number[]> | null;
  month: UnitResult | null;
  year: UnitResult | null;
};
/** At a monthly price: the largest uniform share of every #553 per-use figure that keeps 60% with room on the month and the year at ten. */
export function pointAt(tier: Tier, monthCents: number): PlanPoint {
  const none = includedAt(tier, 0);
  if (!keepsWithRoom(tier, monthCents, none)) return { tier, monthCents, share: null, included: null, month: null, year: null };
  let lo = 0, hi = 1;
  if (keepsWithRoom(tier, monthCents, includedAt(tier, 1))) lo = 1;
  else for (let i = 0; i < 30; i += 1) { const mid = (lo + hi) / 2; if (keepsWithRoom(tier, monthCents, includedAt(tier, mid))) lo = mid; else hi = mid; }
  const included = includedAt(tier, lo);
  return { tier, monthCents, share: lo, included, month: planAt(tier, "month", monthCents, included), year: planAt(tier, "year", monthCents, included) };
}
const grids = new Map<Tier, PlanPoint[]>();
export function grid(tier: Tier): PlanPoint[] {
  if (!grids.has(tier)) grids.set(tier, PRICE_POINTS[tier].map((p) => pointAt(tier, p)));
  return grids.get(tier)!;
}
/** The recommended point: the lowest price at which every per-use figure is at least MIN_INCLUDED_SHARE of #553's. */
export function recommended(tier: Tier): PlanPoint {
  const point = grid(tier).find((p) => p.share !== null && p.share >= MIN_INCLUDED_SHARE);
  if (!point) throw new Error(`No price point for ${tier} includes ${MIN_INCLUDED_SHARE} of today's figures`);
  return point;
}
/** The lowest monthly price, in cents, at which the plan keeps 60% with room including NOTHING that costs per use: what the features alone cost to keep open. */
export function featuresOnlyFloor(tier: Tier, cycle: Cycle): number {
  return floorPriceCents(usageCents(tier, cycle, Object.fromEntries(PRINTED.map((id) => [id, 0]))), PLAN_ROOM[cycle]);
}

// ------------------------------------------------------------- the packs

/** Access emails and store emails go with orders: a pack of orders carries them in the ratio of the plan that carries the most of them per order. */
const accessPerOrder = Math.max(...TIERS.map((t) => STORE_ALLOWANCES[t].transactional / ORDERS_INCLUDED[t]));
const storeEmailPerOrder = Math.max(...TIERS.map((t) => STORE_ALLOWANCES[t].email / ORDERS_INCLUDED[t]));
/** Months a stored gigabyte is paid for by one payment: its window and what is kept after the plan ends (tests/plan-cost-registry.ts, retained-files). */
const STORAGE_MONTHS_PER_PAYMENT = 1 + (CLOSING_DAYS + WARN_WEEK_DAYS) / 30;

export type Pack = {
  id: string;
  /** What one pack adds to one billing window. */
  what: string;
  /** Which printed lines it raises. */
  raises: Printed[];
  units: number;
  /** How a price per unit is printed: per this many units, and what one is called. */
  per: number;
  perName: string;
  /** One pack used in full, in dollars, from the registry's own unit costs. */
  costUsd: number;
  basis: string;
};
/** Pack sizes: chosen so one pack is a round amount and its price lands between about $10 and $50. */
export const PACKS: Pack[] = [
  {
    id: "visits", what: "5,000 visits", raises: ["visits"], units: 5_000, per: 1_000, perName: "1,000 visits",
    costUsd: 5_000 * (visitCost() + REQUESTS_PER_VISIT * REQUEST_COMMANDS * COMMAND),
    basis: "visitCost() (tests/traffic-cost.ts, the heavy visitor) and the REQUESTS_PER_VISIT public requests each visit opens (line public-requests)",
  },
  {
    id: "orders", what: "250 orders, with their access and store emails", raises: ["orders", "transactional-email", "store-email"], units: 250, per: 1, perName: "order",
    costUsd: 250 * (ORDER_COST + accessPerOrder * UNIT_COST.transactional + storeEmailPerOrder * UNIT_COST.email),
    basis: `ORDER_COST, and ${accessPerOrder.toFixed(2)} access and ${storeEmailPerOrder.toFixed(2)} store emails an order (the most any plan carries per order), at UNIT_COST`,
  },
  {
    id: "list-email", what: "2,500 list emails", raises: ["list-email"], units: 2_500, per: 1_000, perName: "1,000 emails",
    costUsd: 2_500 * PER_EMAIL,
    basis: "PER_EMAIL (line list-email)",
  },
  {
    id: "ai", what: "20 AI writing jobs and 100 answers", raises: ["ai"], units: 20, per: 1, perName: "writing job with 5 answers",
    costUsd: (20 * WRITING_JOB_MICRO_USD + 100 * ANSWER_MICRO_USD) / 1_000_000,
    basis: "WRITING_JOB_MICRO_USD and ANSWER_MICRO_USD (lib/spend-cost-table.ts), the units of the AI ceiling (line ai)",
  },
  {
    id: "storage", what: "25 GB of storage", raises: ["storage"], units: 25, per: 1, perName: "GB",
    costUsd: 25 * STORAGE_PER_GB * STORAGE_MONTHS_PER_PAYMENT,
    basis: `STORAGE_PER_GB for the window and the ${CLOSING_DAYS + WARN_WEEK_DAYS} days kept after a plan ends (line retained-files)`,
  },
  {
    id: "video", what: "20 video hours watched", raises: ["video"], units: 20, per: 1, perName: "hour",
    costUsd: 20 * hourCost(),
    basis: "hourCost() (line video)",
  },
];
const centsUp = (usd: number) => Math.ceil(Math.round(usd * 1e7) / 1e5);
/** The lowest whole-dollar price at which a pack, bought on its own payment and used in full, keeps 60% with the add-on's room. */
export function packPriceCents(pack: Pack, ownTransaction = true): number {
  const usage = centsUp(pack.costUsd);
  let price = Math.ceil(floorPriceCents(usage, ADD_ON_ROOM_CENTS) / 100) * 100;
  for (;;) { const u = unitUnder(price, usage, SIZING_READING, ownTransaction); if (u.meetsFloor && u.usageRoomCents - usage >= ADD_ON_ROOM_CENTS) return price; price += 100; }
}
/** The same pack a hundred times larger: what a unit can be sold at, at the least, however large a pack is. */
export function atScale(pack: Pack, times = 100): Pack {
  return { ...pack, units: pack.units * times, costUsd: pack.costUsd * times };
}
/** A pack on its own payment at its price, used in full. */
export function packUnit(pack: Pack, reading = SIZING_READING, ownTransaction = true): UnitResult {
  return unitUnder(packPriceCents(pack), centsUp(pack.costUsd), reading, ownTransaction);
}
/** The lowest whole-dollar price for the same amount carried as a line on the next renewal invoice (the percentages only): billed after use, so not recommended until the exposure is reviewed. */
export function linePriceCents(pack: Pack): number {
  const usage = centsUp(pack.costUsd);
  let price = 100;
  for (;;) { const u = unitUnder(price, usage, SIZING_READING, false); if (u.meetsFloor && u.usageRoomCents - usage >= ADD_ON_ROOM_CENTS) return price; price += 100; }
}

// ------------------------------------------------------------- a whole customer

/** One customer at the recommended price, every included figure and one of every pack used in full: the sums of the units, under a reading. */
export function wholeCustomer(tier: Tier, cycle: Cycle, reading = SIZING_READING): { revenueCents: number; netCents: number; netBps: number } {
  const point = recommended(tier);
  const plan = planAt(tier, cycle, point.monthCents, point.included!, reading);
  const packs = PACKS.filter((p) => figures(tier)[p.raises[0]].some((n) => n > 0) || p.id === "orders").map((p) => packUnit(p, reading));
  // A yearly payment's packs are bought in each of its twelve windows.
  const times = cycle === "year" ? 12 : 1;
  const revenueCents = plan.revenueCents + times * packs.reduce((s, u) => s + u.revenueCents, 0);
  const netCents = plan.netCents + times * packs.reduce((s, u) => s + u.netCents, 0);
  return { revenueCents, netCents, netBps: Math.floor((netCents * 10_000) / revenueCents) };
}

// ------------------------------------------------------------- competitors

export type Source = { name: string; url: string; read: string; figures: string };
/** Read on READ_ON with the page named; every figure is what that page showed. Nothing else is asserted. */
export const COMPETITORS: Source[] = [
  { name: "Stan", url: "https://stan.store/blog/stan-store-pricing/", read: "18 October 2026 (page updated 22 July 2026)", figures: "Creator $29 a month or $300 a year; Creator Pro $99 a month or $948 a year; 0% transaction fee; \"unlimited products to unlimited customers\"; Creator Pro lists \"unlimited emails\"; no figure for contacts or storage." },
  { name: "Beacons", url: "https://help.beacons.ai/en/articles/4695681", read: "18 October 2026 (article edited 14 November 2025)", figures: "Free $0 (9% transaction fee, 50 email sends a month); Creator $10 or $100 a year (9% on sales, 500 email sends a month); Creator Plus $30 or $300 (0% fees, \"Unlimited Marketing Emails\"); Creator Max $90 or $900 (\"unlimited AI generations\")." },
  { name: "Kajabi", url: "https://kajabi.com/pricing", read: "18 October 2026", figures: "Basic $179, Growth $249, Pro $499 a month ($143, $199, $399 a month billed yearly); contacts 2,500 / 25,000 / 100,000; products 5 / 50 / unlimited; AI credits 0 / 500 / 1,000; marketing emails unlimited. Usage above: \"Contacts come in blocks of 25,000 for $125 a month\"; AI credits \"$15/mo for 500\" as a top-up, marked \"coming end of cycle\"." },
  { name: "ClickFunnels", url: "https://support.myclickfunnels.com/docs/clickfunnels-pricing/", read: "18 October 2026 (page updated 12 October 2026)", figures: "Launch $97 or $970, Scale $197 or $1,970, Optimize $297 or $2,970, Dominate $5,997 a year; contacts 10K / 75K / 150K / 400K; emails a month 50K / 300K / 750K / 1.2M; visitors unlimited. The page states no add-on or overage price." },
  { name: "HighLevel", url: "https://www.gohighlevel.com/pricing", read: "18 October 2026", figures: "Starter $97 or $970, Unlimited $297 or $2,970, Agency Pro $497 or $4,970; unlimited contacts and users; email, SMS, calling and AI marked \"Usage based charges apply\", with no rate on the page; AI Employee $50 or $97 a month per sub-account." },
  { name: "HighLevel pricing guide", url: "https://help.gohighlevel.com/support/solutions/articles/155000001156-highlevel-", read: "18 October 2026 (article modified 22 August 2026)", figures: "\"Email usage is $0.675 per 1,000 emails across all plans.\" Pay-per-use AI billed at token cost, with no unit price published." },
];

// ------------------------------------------------------------- the document

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const usd2 = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctOf = (bps: number) => `${bps < 0 ? "−" : ""}${(Math.abs(bps) / 100).toFixed(2)}%`;
const num = (n: number) => n.toLocaleString("en-US");
const NAMES: Record<Printed, string> = {
  visits: "Visits a month", orders: "Orders a month", "list-email": "List emails a month", ai: "AI writing jobs + answers a month",
  storage: "Storage", video: "Video hours watched a month", "transactional-email": "Access emails a month", "store-email": "Store emails a month",
};
const ROW_ORDER: Printed[] = ["visits", "orders", "list-email", "ai", "storage", "video", "transactional-email", "store-email"];
function show(id: Printed, values: number[]): string {
  if (id === "storage") return `${num(values[0] / GB)} GB`;
  if (id === "ai") return `${num(values[0])} + ${num(values[1])}`;
  return values.map(num).join(" / ");
}

/** Deal pipelines are proposed raised only while the registry lists them as not a cost. */
function pipelinesNotACost(): string {
  if (!("PIPELINES_BY_TIER" in NOT_A_COST)) throw new Error("PIPELINES_BY_TIER is no longer listed under NOT_A_COST: the raise proposed for it must be priced first");
  return "";
}

export function renderPricingUsageProposal(): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);
  push("# Entry prices with usage packs: a proposal, 18 October 2026");
  push("");
  push("<!-- Generated by `node scripts/pricing-usage-proposal.mjs` from tests/pricing-usage-proposal-table.ts. Do not edit by hand: tests/pricing-usage-proposal.test.ts fails when this file is stale. -->");
  push("");
  push("**A proposal for the owner, not a change.** No price, limit or gate in code changes with it; `PLANS_ON_SALE` stays false behind the tax gate (most-tax reading), the EU art. 9a gate and the commercial review. Every figure below is computed by the repository's own margin code (lib/receiving-costs.ts `unitUnder`, tests/limits-proposal-table.ts `usageCents`, tests/margin-alignment-table.ts `floorPriceCents`, the unit costs of tests/plan-cost-registry.ts); none is typed.");
  push("");
  push("## What it changes, in one paragraph");
  push("");
  push(`Today (PR #553) each plan is priced so that every allowance used in full keeps 60%: Store ${usd(PLAN_PRICES.creator.month)}, Studio ${usd(PLAN_PRICES.pro.month)}, Scale ${usd(PLAN_PRICES.scale.month)} a month, two to four and a half times the competitor plan a buyer sets it beside. The model proposed here, after HighLevel's (a base price, usage charged on top): each plan at an entry price, a smaller included amount of the eight resources that cost money per use (visits, orders, list emails, AI, storage, video hours, access emails, store emails), and every unit above it sold in prepaid packs, each of which keeps 60% on its own. Every limit that costs nothing per use (products, lessons, forms, team, pipelines, 0% of a sale) is kept. **The included amounts are cut, which the owner's rule of 18 October 2026 (\"não remover limites visíveis\") does not allow without his decision**: the limit is not removed (a pack raises it in the same window), but the figure printed as included is lower than #553's.`);
  push("");
  push("## The structure that decides every figure");
  push("");
  const r29 = unitUnder(2_900, 0, SIZING_READING, true);
  push(`Under the one receiving model (the dearer of Stripe ${STRIPE_TOTAL_BPS / 100}% + ${PROVIDER_FEES.stripe.fixedCents}¢ and Paddle ${PROVIDER_FEES.paddle.bps / 100}% + ${PROVIDER_FEES.paddle.fixedCents}¢ on the price plus the buyer's tax on top at ${SIZING_READING.salesTaxOnTopBps / 100}%, remittance, refund and dispute reserves, at least ${SIZING_READING.profitTaxBps / 100}% on profit), the ${FLOOR_BPS / 100}% floor leaves about 17.24% of revenue for every cost, and receiving one payment takes about 12% of it plus about 60¢ fixed. So:`);
  push("");
  push(`- **A unit of use must be sold at about twenty times what it costs.** A $${(2_900 / 100).toFixed(0)} payment leaves ${usd2(r29.usageRoomCents)} for all of its use (${usd2(r29.totalCents)} goes to receiving it). This holds for a plan and for a pack alike, so a pack can never be priced near cost the way HighLevel rebills email.`);
  push("- **Every plan carries a cost before anything is included**: the studio, the API, webhooks, imports, workflows, team scheduling, the data room and what a store leaves after it closes, all at their enforced ceilings (none of them printed). This proposal keeps all of them, so they set the lowest price a plan can have:");
  push("");
  push("| Plan | Lowest price with nothing per-use included, monthly | The same, yearly | Today's price |");
  push("| --- | --- | --- | --- |");
  for (const t of TIERS) push(`| ${PLAN_TITLES[t]} | ${usd2(featuresOnlyFloor(t, "month"))} | ${usd2(featuresOnlyFloor(t, "year"))} | ${usd(PLAN_PRICES[t].month)} / ${usd(PLAN_PRICES[t].year)} |`);
  push("");
  push(`Store cannot be sold at Stan Creator's $29 without cutting those unprinted ceilings too, which this proposal does not do.`);
  push("");
  push("## Every price point looked at");
  push("");
  push(`For each monthly price (the year at ten monthly payments), the largest share of every #553 per-use figure (video hours apart: they are kept in full at every price, being the cheapest per-use line, about a cent and a half an hour watched) the plan can include and keep 60% at full use on both intervals, with the room the spend floor test keeps (25¢ a month, $1 a year). Figures are rounded down as a page prints them. "Net a customer" is the monthly payment's net at full included use; "to equal one #553 customer" is how many customers at this price give the net of one at today's price, each at full use: it is the demand the lower price must bring to break even, and **nobody knows whether it would**, because no sale has ever been open.`);
  push("");
  for (const t of TIERS) {
    const today = planAt(t, "month", PLAN_PRICES[t].month, figures(t));
    push(`### ${PLAN_TITLES[t]}`);
    push("");
    push("| Monthly / yearly price | Share of #553's per-use figures included | Net, monthly | Net, yearly | Net a customer, a month | To equal one #553 customer |");
    push("| --- | --- | --- | --- | --- | --- |");
    for (const p of grid(t)) {
      if (p.share === null) { push(`| ${usd(p.monthCents)} / ${usd(yearOf(p.monthCents))} | cannot keep 60% with only the video hours included | — | — | — | — |`); continue; }
      push(`| ${usd(p.monthCents)} / ${usd(yearOf(p.monthCents))}${p.monthCents === recommended(t).monthCents ? " **(recommended)**" : ""} | ${(p.share * 100).toFixed(1)}% | ${pctOf(p.month!.netBps)} | ${pctOf(p.year!.netBps)} | ${usd2(p.month!.netCents)} | ${(today.netCents / p.month!.netCents).toFixed(2)} |`);
    }
    push("");
  }
  push(`**The rule for the recommended point**: the lowest price on the list at which every per-use figure is at least ${MIN_INCLUDED_SHARE * 100}% of #553's (before rounding down) on both intervals. A lower price wins the comparison beside the competitor's card; below ${MIN_INCLUDED_SHARE * 100}% the plan includes too little to read as a plan; everything above the included amount is sold in packs at 60% or more, so a heavy user pays for what they use. This is a rule, not a measurement: the price that maximizes profit depends on how many creators buy at each price, which is unknown until sales open. The table above gives the owner the figure to judge it by (customers needed to equal one #553 customer).`);
  push("");
  const anchor: Record<Tier, number> = { creator: 3_500, pro: 9_900, scale: 24_900 };
  push(`At the competitor's own price instead (Store ${usd(anchor.creator)}, the lowest that keeps 60% at all, Stan being $29; Studio ${usd(anchor.pro)}, Stan Creator Pro's; Scale ${usd(anchor.scale)}, Kajabi Growth's), each plan would include ${TIERS.map((t) => `${PLAN_TITLES[t]} ${((pointAt(t, anchor[t]).share ?? 0) * 100).toFixed(1)}%`).join(", ")} of #553's per-use figures: nearly everything would be bought in packs, which is HighLevel's own shape (its plans include no email at all).`);
  push("");
  push("## The proposed plans");
  push("");
  push("| | " + TIERS.map((t) => PLAN_TITLES[t]).join(" | ") + " |");
  push("| --- | " + TIERS.map(() => "---").join(" | ") + " |");
  push("| Price, monthly / yearly | " + TIERS.map((t) => { const p = recommended(t); return `**${usd(p.monthCents)} / ${usd(yearOf(p.monthCents))}**`; }).join(" | ") + " |");
  push("| Today (#553) | " + TIERS.map((t) => `${usd(PLAN_PRICES[t].month)} / ${usd(PLAN_PRICES[t].year)}`).join(" | ") + " |");
  push("| Before #553 | " + TIERS.map((t) => `${usd(PRICES_BEFORE_553[t].month)} / ${usd(PRICES_BEFORE_553[t].year)}`).join(" | ") + " |");
  for (const id of ROW_ORDER) {
    push(`| ${NAMES[id]}: included · #553 · before #553 | ` + TIERS.map((t) => { const p = recommended(t); return `**${show(id, p.included![id])}** · ${show(id, figures(t)[id])} · ${show(id, figuresBefore553(t)[id])}`; }).join(" | ") + " |");
  }
  push("| Net at full included use, monthly (sizing reading) | " + TIERS.map((t) => pctOf(recommended(t).month!.netBps)).join(" | ") + " |");
  push("| Net at full included use, yearly (sizing reading) | " + TIERS.map((t) => pctOf(recommended(t).year!.netBps)).join(" | ") + " |");
  push("| Net at full use, monthly, under the most-tax reading (the gate) | " + TIERS.map((t) => pctOf(planAt(t, "month", recommended(t).monthCents, recommended(t).included!, MOST_TAX_READING).netBps)).join(" | ") + " |");
  push("| Net a customer, a month, at full included use | " + TIERS.map((t) => usd2(recommended(t).month!.netCents)).join(" | ") + " |");
  push("| The same at #553's price | " + TIERS.map((t) => usd2(planAt(t, "month", PLAN_PRICES[t].month, figures(t)).netCents)).join(" | ") + " |");
  push("");
  push("Every limit that costs nothing per use is **kept** as in #553 and on every plan: " + `${num(MAX_PRODUCTS)} products, ${num(MAX_LESSONS)} lessons a course, ${MAX_FORMS} forms, a team of ${MAX_TEAM}, 0% of a sale, and every feature of the plan. One could be **raised** at no modelled cost: deal pipelines (${TIERS.map((t) => `${PLAN_TITLES[t]} ${PIPELINES_BY_TIER[t]}`).join(", ")}), which tests/plan-cost-registry.ts lists under NOT_A_COST${pipelinesNotACost()} as a setting in a record the data room already prices; the proposal is ${Math.max(...TIERS.map((t) => PIPELINES_BY_TIER[t]))} on every plan. No other visible figure is raised, because every other one is read by a priced line of the registry.`);
  push("");
  push("## The packs");
  push("");
  push(`Each pack adds its amount to one billing window of the store's plan, is charged on its own payment before it counts (prepaid: nothing is used before it is paid), and is priced at the lowest whole dollar at which the pack, used in full, keeps 60% on its own with the add-on's ${ADD_ON_ROOM_CENTS}¢ of room. Its cost is the registry's own unit cost, named in the last column. The same packs serve every plan (a pack's cost does not depend on the plan).`);
  push("");
  push("| Pack | Price | Per unit | Cost used in full | Net, sizing reading | Net, most-tax reading | The least a unit can cost at any pack size | Billed on the next invoice instead | Cost basis |");
  push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const perUnit = (pack: Pack, cents: number) => `${usd2((cents / pack.units) * pack.per)} per ${pack.perName}`;
  for (const pack of PACKS) {
    const u = packUnit(pack);
    const price = packPriceCents(pack);
    const big = atScale(pack);
    push(`| ${pack.what} | **${usd(price)}** | ${perUnit(pack, price)} | ${usd2(centsUp(pack.costUsd))} | ${pctOf(u.netBps)} | ${pctOf(packUnit(pack, MOST_TAX_READING).netBps)} | ${perUnit(big, packPriceCents(big))} | ${usd(linePriceCents(pack))} | ${pack.basis} |`);
  }
  push("");
  const email = PACKS.find((p) => p.id === "list-email")!;
  push(`**Beside the competitors:** ${email.what} cost ${usd(packPriceCents(email))} here, ${usd2((packPriceCents(email) / email.units) * 1_000)} a thousand, against HighLevel's $0.675 a thousand (its pricing guide) — about ${Math.round((packPriceCents(email) / email.units) * 1_000 / 67.5)} times as much. That is the twenty-times rule above, plus a pack's own fixed fee; a creator who sends a lot of email will compare it with ClickFunnels Launch (50,000 a month in $97) and Kajabi (marketing emails unlimited) and not buy it. A visit pack works out at ${usd2((packPriceCents(PACKS[0]) / PACKS[0].units) * 1_000)} a thousand visits, where ClickFunnels advertises visitors as unlimited. A larger pack spreads the fixed fees thinner, but no size can go below the column "the least a unit can cost": that is the twenty-times rule alone.`);
  push("");
  push(`"Billed on the next invoice instead" is the price of the same amount as a line on the renewal invoice, which pays only the fee's percentages: lower, but used before it is paid, so it is a non-payment exposure that docs/funded-exposure-review.md would have to bound and fund first. The proposal is the prepaid pack.`);
  push("");
  push("## One customer, alone, at full use of everything bought");
  push("");
  push("Each plan at its recommended price with every included figure used, plus one of every pack it can use, each used in full (a yearly payment buys them in each of its twelve windows). Because each unit keeps 60% on its own, the customer does; the sums below are the units' own, added.");
  push("");
  push("| Plan | Monthly: revenue, net | Yearly: revenue, net |");
  push("| --- | --- | --- |");
  for (const t of TIERS) {
    const m = wholeCustomer(t, "month"), y = wholeCustomer(t, "year");
    push(`| ${PLAN_TITLES[t]} | ${usd2(m.revenueCents)}, ${pctOf(m.netBps)} | ${usd2(y.revenueCents)}, ${pctOf(y.netBps)} |`);
  }
  push("");
  push("## How it would be enforced, and what is not built");
  push("");
  push("- **The ceilings exist.** Each of the eight figures is already counted and refused past the plan's figure, automatically, before the cost is incurred: visits (lib/traffic.ts, public pages rest), orders (lib/order-admission.ts), list emails and store and access emails (lib/email.ts), AI (lib/ai-spend.ts, the automatic ceiling), storage (lib/storage-quota.ts) and video (lib/video-admission-rules.ts). A pack would add its amount to that window's figure; nothing else would change in how a limit stops.");
  push("- **Not built:** buying a pack (a Stripe charge on its own payment), crediting it to the window, the pages that sell it, and its terms. The AI ceiling's company total (`companyMicroUsd`) would have to count packs. A pack's refund would need Hazelsong's rule (refunded only while none of it was used), and the 14-day money-back refund is a funded exposure already bounded by docs/funded-exposure-review.md, which would have to be recomputed at the lower prices.");
  push("- **The minimum paying base rises.** Fixed costs are covered by the net each customer keeps above 60%; a customer at a lower price keeps fewer dollars above it, so more customers are needed before the company as a whole keeps 60% (AGENTS.md, \"Garantir a partir da base mínima\").");
  push("- **Nothing opens.** Under the most-tax reading, the gate, no plan and no pack keeps 60% (rows above), exactly as today.");
  push("");
  push("## What is not known");
  push("");
  push("- **Demand.** How many creators would buy at each price, how many would buy packs, and how much of each allowance they would use: none of it is known, because no sale has been open. Every net above is at full use, the owner's rule; real use will be lower, and margins higher.");
  push("- **Whether a creator reads a smaller included amount plus packs as more value than #553's larger allowances at the higher price.** The competitors read below show both models: Kajabi and ClickFunnels print large allowances in a higher price; HighLevel prints a base price and charges usage on top with no rate on its pricing page.");
  push("- Gumroad and Podia were not read (their pricing pages refused the fetch on 18 October 2026 in PR #553's reading); nothing is asserted about them.");
  push("");
  push("## Competitors, as read");
  push("");
  push("| Competitor | Source | Read | What the page shows |");
  push("| --- | --- | --- | --- |");
  for (const c of COMPETITORS) push(`| ${c.name} | [${c.url}](${c.url}) | ${c.read} | ${c.figures} |`);
  push("");
  push("| Proposed plan | The competitor plan it would be set beside | Its price |");
  push("| --- | --- | --- |");
  const beside: Record<Tier, string> = {
    creator: "Stan Creator ($29 / $300); Beacons Creator Plus ($30 / $300)",
    pro: "Stan Creator Pro ($99 / $948); ClickFunnels Launch ($97 / $970); HighLevel Starter ($97 / $970); Kajabi Basic ($179)",
    scale: "Kajabi Growth ($249, $199 a month yearly); HighLevel Unlimited ($297 / $2,970); ClickFunnels Optimize ($297 / $2,970)",
  };
  for (const t of TIERS) push(`| ${PLAN_TITLES[t]} at ${usd(recommended(t).monthCents)} / ${usd(yearOf(recommended(t).monthCents))} | ${beside[t]} | ${usd(recommended(t).monthCents)} a month here |`);
  push("");
  push("## For the owner to decide");
  push("");
  push("1. Whether to replace #553's prices with entry prices and packs at all: it cuts the printed included figures, which his rule of 18 October 2026 forbids without his decision.");
  push(`2. If so, the price points (the rule above picks the lowest with at least ${MIN_INCLUDED_SHARE * 100}% of #553's figures included; the tables show every other point and what it includes).`);
  push("3. The pack sizes, and whether packs are offered at all for visits and orders (they are what a link-in-bio store sells through; when a window's figure is reached today, public pages rest and new orders stop).");
  push("");
  return HISTORICAL_MARGIN_NOTICE + out.join("\n");
}
