/**
 * The margin alignment of 18 October 2026, as numbers: every plan, interval
 * and add-on at full use under the one receiving model of
 * lib/receiving-costs.ts, and the document that prints them
 * (docs/margin-alignment-2026-10-18.md).
 *
 * Nothing in the document is typed: `node scripts/margin-alignment.mjs`
 * writes it from renderMarginAlignment(), and tests/margin-alignment.test.ts
 * fails when the file on disk is not what this renders, so a change to a
 * price, a limit, a fee or a reading that is not regenerated is caught.
 */
import { MOST_TAX_READING } from "./historical-receiving-model";
const gateReading=()=>MOST_TAX_READING;
export const HISTORICAL_TAX_NOTICE='> **Historical tax model — superseded by TX.** These dated sizing/most-tax figures are retained for history. Current profit and capacity require complete scoped annual books, exchange operations, FX and applicable component facts through the real reviewed model; missing evidence is unknown, never a zero cost or permission to sell.\n\n';
import { PLAN_PRICES, PLAN_TITLES, TIERS, type Cycle, type Tier } from "@/lib/plan";
import { ADD_ON_ROOM_CENTS, ASSISTANT_MESSAGES_MONTHLY, ASSISTANT_PRICE_CENTS, assistantMonthWorst } from "@/lib/store-assistant-rules";
import { MAX_AUTO_LANGUAGES, MAX_AUTO_MINUTES, autoCaptionCents } from "@/lib/auto-captions-rules";
import { unitUnder, type Reading, type UnitResult } from "./historical-receiving-model";
import { renderLlcFixedCostStatus } from "../lib/llc-fixed-costs";
import { COST_LINES, perPaymentCost } from "./plan-cost-registry";

/** The lines of the worst month whose figure is printed on the pricing and plan pages: visits, orders, video hours, storage, AI drafts and emails. */
export const PRINTED_CORE_LINES = ["storage", "video", "visits", "orders", "list-email", "transactional-email", "store-email", "ai"] as const;

const months = (cycle: Cycle) => (cycle === "year" ? 12 : 1);
const centsUp = (usd: number) => Math.ceil(Math.round(usd * 1e7) / 1e5);

export type Unit = {
  id: string;
  name: string;
  priceCents: number;
  /** Every line of the worst month for every window the payment reaches, and what it leaves after its plan ends, in cents. */
  usageCents: number;
  /** The same with every line but the printed core at zero: the most any cut to a hidden limit could ever save. */
  coreUsageCents: number;
  ownTransaction: boolean;
  /** Whether this unit can be bought today. */
  onSale: boolean;
};

function monthlyLines(tier: Tier, only?: readonly string[]): number {
  return COST_LINES.filter((line) => !only || only.includes(line.id)).reduce((sum, line) => sum + line.monthlyUsd(tier), 0);
}

/**
 * The base plans at a list of prices, the commission on sales counted as
 * zero: the price list in force (lib/plan.ts, since 18 October 2026 one list)
 * unless another is given, such as one published before that day.
 */
export function planUnits(plansOnSale: boolean, prices: Record<Tier, Record<Cycle, number>> = PLAN_PRICES, tag = "list"): Unit[] {
  return TIERS.flatMap((tier) =>
    (["month", "year"] as const).map((cycle) => ({
      id: `${tier}-${cycle}-${tag}`,
      name: `${PLAN_TITLES[tier]} ${cycle === "year" ? "yearly" : "monthly"} ($${(prices[tier][cycle] / 100).toLocaleString("en-US")})`,
      priceCents: prices[tier][cycle],
      usageCents: centsUp(months(cycle) * monthlyLines(tier) + perPaymentCost(tier)),
      coreUsageCents: centsUp(months(cycle) * monthlyLines(tier, PRINTED_CORE_LINES)),
      ownTransaction: true,
      onSale: plansOnSale,
    })),
  );
}

/** The room the spend floor test keeps under a unit when it is on sale (tests/spend-floor.test.ts, ADD_ON_ROOM_CENTS). */
export function roomKept(unit: Unit): number {
  if (unit.id === "store-assistant") return ADD_ON_ROOM_CENTS;
  if (unit.id.startsWith("captions")) return 0;
  return unit.id.includes("-year-") ? 100 : 25;
}

/** Internal exact threshold test under the binding reading, with room when asked; never a price proposal. */
export function floorPriceCents(usageCents: number, room = 0, reading: Reading = gateReading()): number {
  let lo = 1, hi = 100_000_000;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const u = unitUnder(mid, usageCents + room, reading, true); if (u.meetsFloor) hi = mid; else lo = mid + 1; }
  // The fee and the reserves round up by the cent, so the net is not monotone in the price near the edge: the lowest
  // price that keeps is looked for over the twenty dollars below the bisection's answer.
  let lowest = lo;
  for (let p = lo - 1; p >= Math.max(1, lo - 2_000); p -= 1) if (unitUnder(p, usageCents + room, reading, true).meetsFloor) lowest = p;
  return lowest;
}

/** The Store assistant add-on, every reply of its month used at its worst. */
export function assistantUnit(onSale: boolean): Unit {
  const month = assistantMonthWorst();
  return { id: "store-assistant", name: `Store assistant add-on ($${ASSISTANT_PRICE_CENTS / 100}/mo, ${ASSISTANT_MESSAGES_MONTHLY} replies)`, priceCents: ASSISTANT_PRICE_CENTS, usageCents: month.aiCents, coreUsageCents: month.aiCents, ownTransaction: true, onSale };
}

/** AI captions at their dearest per charge: the service's ten cents a minute a language, and a dime more for the spoken language counted apart. */
export function captionUnits(onSale: boolean, reading: Reading = gateReading()): Unit[] {
  const worst: Unit[] = [];
  for (let languages = 1; languages <= MAX_AUTO_LANGUAGES; languages += 1) {
    let lowest: Unit | null = null;
    let lowestBps = Infinity;
    for (let minutes = 1; minutes <= MAX_AUTO_MINUTES; minutes += 1) {
      const priceCents = autoCaptionCents(minutes * 60, languages);
      const usageCents = minutes * (languages + 1) * 10;
      const bps = unitUnder(priceCents, usageCents, reading, true).netBps;
      if (bps < lowestBps) {
        lowestBps = bps;
        lowest = { id: `captions-${languages}`, name: `AI captions, ${languages} language${languages > 1 ? "s" : ""} (${minutes} min, $${(priceCents / 100).toFixed(2)})`, priceCents, usageCents, coreUsageCents: usageCents, ownTransaction: true, onSale };
      }
    }
    worst.push(lowest!);
  }
  return worst;
}

export function allUnits(plansOnSale: boolean, assistantOnSale: boolean): Unit[] {
  // AI captions are charged only to a store with an active subscription (lib/auto-captions.ts), so they are sold only while the plans are.
  return [...planUnits(plansOnSale), assistantUnit(assistantOnSale), ...captionUnits(plansOnSale)];
}

export function evaluate(unit: Unit, reading: Reading = gateReading()): UnitResult {
  return unitUnder(unit.priceCents, unit.usageCents, reading, unit.ownTransaction);
}

const usd = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctOf = (bps: number) => `${bps < 0 ? "−" : ""}${(Math.abs(bps) / 100).toFixed(2)}%`;

/** Current-price arithmetic only; a computed threshold is never a price proposal. */
export function currentPriceMarginRows(plansOnSale: boolean, assistantOnSale: boolean): string[] {
  return allUnits(plansOnSale, assistantOnSale).map(unit => {
    const actual = evaluate(unit), room = roomKept(unit);
    const buffered = unitUnder(unit.priceCents, unit.usageCents + room, gateReading(), unit.ownTransaction);
    return `| ${unit.name} | ${usd(unit.priceCents)} | ${usd(actual.revenueCents)} | ${usd(actual.totalCents)} | ${usd(unit.usageCents)} | ${usd(actual.taxCents)} | ${usd(actual.netCents)} | ${pctOf(actual.netBps)} | ${usd(room)} | ${buffered.meetsFloor ? "positive" : "fails"} | ${unit.onSale ? "yes" : "no"} |`;
  });
}
export function renderMarginAlignment(plansOnSale: boolean, assistantOnSale: boolean): string {
  const out: string[] = [];
  const reading = gateReading();
  out.push("# Margin alignment — current prices, MR27 October2026");
  out.push("");
  out.push("<!-- Generated by node scripts/margin-alignment.mjs from tests/margin-alignment-table.ts. No figures are edited by hand. -->");
  out.push("");
  out.push("Owner27/10/2026 07h42Fortaleza: every unit must retain positive net profit at100%of rights in its worst month, monthly and annual, with the existing spend-floor room. The company needs a calculated break-even paying base covering100%of fixed costs and funded exposures.60%is the actual monthly company target, not a sales floor. Historical decisions/quotes remain in AGENTS.md and the dated analyses.");
  out.push("");
  out.push("These are registered-model calculations, not certified actual costs or an approved commercial review. Unknown supplier coverage, retention, tax treatment, fixed cost or exposure fails approval; it is never entered as zero. Current prices and visible allowances are unchanged. No new price is proposed.");
  out.push("");
  out.push(`Binding reading: ${reading.id}; ${reading.label}. Profit tax ${reading.profitTaxBps / 100}%; revenue tax ${reading.revenueTaxBps / 100}%; sales tax inside ${reading.salesTaxInsideBps / 100}%; sales tax on top ${reading.salesTaxOnTopBps / 100}%.`);
  out.push("The receiving model remains lib/receiving-costs.ts: dearer provider per charge, remittance, full refund/dispute reserves, the most onerous tax reading and ISS5%. No free supplier quota is treated as free usage. Annual usage includes12full monthly windows and retained post-plan records.");
  out.push("");
  out.push("## Each current unit at full registered use");
  out.push("");
  out.push("Room is the unchanged extra non-tax cost held by the spend-floor tests:25cents monthly,100cents yearly,25cents for the assistant; captions retain their existing zero extra room. The last model column requires positive net after charging that room too.");
  out.push("");
  out.push("| Unit | Current price | Revenue | Receiving and reserves | Full usage | Taxes | Net profit | Net margin | Cost room | With room | On sale |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  out.push(...currentPriceMarginRows(plansOnSale, assistantOnSale));
  out.push("");
  out.push("Caption rows select their worst modeled net share under the binding reading across all allowed lengths for each language count. They are not a claim of independently verified provider bills.");
  out.push("");
  out.push(renderLlcFixedCostStatus());
  out.push("SR3 must additionally establish the official costs and acceptance of ITIN/acceptance-agent work if applicable, a US-resident legal representative and a real US business address. Existing registered-agent/mailbox/GDPR quotations do not prove these requirements. Complete company costs and the actual minimum paying base remain unknown.");
  out.push("");
  out.push("## Closed conditions and actual monthly reporting");
  out.push("");
  out.push("PLANS_ON_SALE and OPENING_REQUESTED remain false. The commercial review is absent; contract/exposure coverage and the other existing funding gates remain incomplete; art9a treatments are not recorded. The tax reading is not lowered, EU hosting is not confirmed, and SR2 still requires a dated proved US-company Stripe platform account eligible for the required direct-charge regions. A positive modeled unit never opens a sale.");
  out.push("");
  out.push("The internal monthly report calculator accepts only complete reconciled actual accounting for the previous UTC month and outputs aggregates without personal data. Its actual dataset is still null. Ingestion, automatic scheduling and owner presentation are not delivered by that calculator; no actual60%achievement, company margin or finite customer base is asserted.");
  out.push("");
  return HISTORICAL_TAX_NOTICE+out.join("\n");
}

/**
 * The net share under the model each unit was held to before this change, at
 * 27.5% on profit: a plan at 2.9% + 0.7% + 30 cents on the price with no
 * reserve; the add-on at 6.6% + 30 cents on the price with its reserves; AI
 * captions at the card's 2.9% + 30 cents.
 */
export function wasNetBps(unit: Unit): number {
  const p = unit.priceCents;
  const up = (cents: number, bps: number) => Math.ceil((cents * bps) / 10_000);
  const receiving = unit.id === "store-assistant"
    ? up(p, 660) + 30 + up(p, 150) + up(p, 100) + up(p + 3000, 100)
    : unit.id.startsWith("captions") ? up(p, 290) + 30 : up(p, 360) + 30;
  const pretax = p - receiving - unit.usageCents;
  const net = pretax - up(Math.max(0, pretax), 2750);
  return Math.floor((net * 10_000) / p);
}
