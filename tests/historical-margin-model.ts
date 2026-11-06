/**
 * TEST/ARCHIVE ONLY. Reproduces the superseded18Oct60% target, never MR's live
 * release criterion. No production module may import this file. Supplier fees/reserves keep their original parameters; old percentage taxes,
 * target and base-surplus validation are frozen solely for dated history.
 * This prevents the MR change from silently proposing new prices/visible limits.
 */
export * from "./historical-receiving-model";
import { unitUnder as currentUnitUnder, taxOf, STRESS_PROFIT_TAX_BPS, SIZING_READING, type Reading, type UnitResult } from "./historical-receiving-model";
import {CUSTOMER_COST_CATEGORIES,type CustomerWorstCase} from "@/lib/net-margin-rules";
import type { CustomerBaseUnit, CustomerBaseReview, CustomerBaseAssessment } from "@/lib/customer-base-rules";
export const HISTORICAL_MARGIN_NOTICE = "> **Historical calculation — 18 October 2026, superseded by MR on 27 October 2026.** This archived analysis reproduces the former 60% target only. It is not a new price or limit proposal, a current sales floor, or permission to spend or sell. The [current MR rule](../AGENTS.md#mr--regra-de-margem-vigente-27-de-outubro-de-2026) requires positive unit profit with the existing spend-floor room and a calculated company break-even base; 60% is the actual monthly company target. Historical figures and quotations below are preserved.\n\n";
export const FLOOR_BPS = 6_000;
const MINIMUM_NET_MARGIN_BPS = FLOOR_BPS;
const pct = (cents: number, bps: number) => Math.ceil(cents * bps / 10_000);
const keeps = (revenue: number, cost: number, reading: Reading) =>
  revenue - cost - taxOf(revenue, revenue - cost, reading) >= pct(revenue, FLOOR_BPS);
export function costBudgetCents(revenueCents: number, reading: Reading): number {
  const profitBps = Math.max(reading.profitTaxBps, STRESS_PROFIT_TAX_BPS);
  const target = pct(revenueCents, FLOOR_BPS) + taxOf(revenueCents, 0, reading);
  let budget = revenueCents - Math.ceil(target * 10_000 / (10_000 - profitBps));
  while (budget > -revenueCents && !keeps(revenueCents, budget, reading)) budget -= 1;
  while (keeps(revenueCents, budget + 1, reading)) budget += 1;
  return budget;
}
export function unitUnder(priceCents: number, usageCents: number, reading: Reading = SIZING_READING, ownTransaction = true): UnitResult {
  const actual = currentUnitUnder(priceCents, usageCents, reading, ownTransaction);
  const floorCents = pct(actual.revenueCents, FLOOR_BPS);
  return { ...actual, floorCents, meetsFloor: actual.netCents >= floorCents,
    gapCents: Math.max(0, floorCents - actual.netCents),
    usageRoomCents: costBudgetCents(actual.revenueCents, reading) - actual.totalCents };
}
export function floorPriceCents(usageCents: number, room = 0): number {
  let lo = 1, hi = 100_000_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (unitUnder(mid, usageCents + room, SIZING_READING, true).meetsFloor) hi = mid;
    else lo = mid + 1;
  }
  let lowest = lo;
  for (let p = lo - 1; p >= Math.max(1, lo - 2_000); p -= 1) {
    if (unitUnder(p, usageCents + room, SIZING_READING, true).meetsFloor) lowest = p;
  }
  return lowest;
}
const stopped = (status: CustomerBaseAssessment["status"]): CustomerBaseAssessment =>
  ({ status, minimumCustomers: null, reviewedBaseSufficient: false });
const cents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
/** Freeze the old tax/amount validation only for reproducing the dated
 * documents. Production and current-evidence tests cannot import this module. */
function archivedAssessment(value:CustomerWorstCase|null):{approved:boolean;reason:string;netCents:number|null}{
 const stopped=(reason:string)=>({approved:false,reason,netCents:null});
 const own=(v:unknown,key:string):unknown=>{if(!v||typeof v!=='object'||Array.isArray(v))return undefined;const d=Object.getOwnPropertyDescriptor(v,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
 try{
  const gross=own(value,'collectedRevenueCents'),refunds=own(value,'refundableRevenueCents'),tax=own(value,'taxesCeilingCents'),costs=own(value,'costCeilings');
  const list=CUSTOMER_COST_CATEGORIES.map(key=>own(costs,key));
  if(!cents(gross)||!cents(refunds)||!cents(tax)||!list.every(cents)||refunds>gross)return stopped('unknown');
  if(own(value,'allCostsBounded')!==true||own(value,'allTaxesReviewed')!==true||own(value,'revenueCollected')!==true)return stopped('unknown');
  if(gross===0)return stopped('no_revenue');
  const pretax=BigInt(gross)-BigInt(refunds)-(list as number[]).reduce((sum,cost)=>sum+BigInt(cost),BigInt(0));
  const floor=pretax>BigInt(0)?(pretax*BigInt(STRESS_PROFIT_TAX_BPS)+BigInt(9999))/BigInt(10000):BigInt(0);
  if(BigInt(tax)<floor)return stopped('unknown');
  const net=pretax-BigInt(tax);if(net>BigInt(Number.MAX_SAFE_INTEGER)||net< -BigInt(Number.MAX_SAFE_INTEGER))return stopped('invalid');
  return {approved:net>=BigInt(1),reason:net>=BigInt(1)?'approved':'below_floor',netCents:Number(net)};
 }catch{return stopped('unknown');}
}
/** Archived60% consolidated-surplus calculation; no returned record is funding proof. */
export function assessMinimumCustomerBase(units: CustomerBaseUnit[], fixed: CustomerBaseReview | null): CustomerBaseAssessment {
  if (!fixed || !units.length || fixed.monthlyFixedCostsCeilingCents == null || fixed.monthlyFixedTaxesCeilingCents == null || fixed.reviewedPayingCustomers == null) return stopped('unknown');
  if (!cents(fixed.monthlyFixedCostsCeilingCents) || !cents(fixed.monthlyFixedTaxesCeilingCents) || !cents(fixed.reviewedPayingCustomers)) return stopped('invalid');
  if (fixed.allFixedCostsBounded !== true || fixed.allFixedTaxesReviewed !== true || typeof fixed.fixedCostsEvidence !== 'string' || !fixed.fixedCostsEvidence.trim() || typeof fixed.fixedTaxEvidence !== 'string' || !fixed.fixedTaxEvidence.trim()) return stopped('unknown');
  const fixedCents = BigInt(fixed.monthlyFixedCostsCeilingCents) + BigInt(fixed.monthlyFixedTaxesCeilingCents);
  let minimum = BigInt(1);
  for (const unit of units) {
    if (!unit || (unit.months !== 1 && unit.months !== 12)) return stopped('invalid');
    const result = archivedAssessment(unit.scenario);
    if (!result.approved) return stopped(result.reason === 'below_floor' || result.reason === 'no_revenue' ? 'below_unit_floor' : 'unknown');
    if (BigInt(result.netCents!) * BigInt(10000) < BigInt(unit.scenario!.collectedRevenueCents!) * BigInt(MINIMUM_NET_MARGIN_BPS)) return stopped('below_unit_floor');
    // Headroom in cents*basis-points for the full paid period. Keep months
    // in the denominator until integer ceiling division; never round revenue.
    const headroom = BigInt(result.netCents!) * BigInt(10000) - BigInt(unit.scenario!.collectedRevenueCents!) * BigInt(MINIMUM_NET_MARGIN_BPS);
    if (fixedCents > BigInt(0) && headroom === BigInt(0)) return stopped('no_finite_base');
    if (fixedCents === BigInt(0)) continue;
    const needed = fixedCents * BigInt(10000) * BigInt(unit.months);
    const count = (needed + headroom - BigInt(1)) / headroom;
    if (count > minimum) minimum = count;
  }
  if (minimum > BigInt(Number.MAX_SAFE_INTEGER)) return stopped('invalid');
  return {status:'calculated',minimumCustomers:Number(minimum),reviewedBaseSufficient:BigInt(fixed.reviewedPayingCustomers) >= minimum};
}

