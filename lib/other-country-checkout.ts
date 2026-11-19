import { DEEMED_SUPPLIER_RECORDS, type DeemedSupplierJurisdiction } from "@/lib/deemed-supplier";
import { REFUSAL_WORDS, checkoutLocationDecision, type CheckoutLocationDecision, type LocationEvidence } from "@/lib/jurisdiction-refusal-rules";
import {
  PLACE_COUNTED_COUNTRIES, REVIEWED_COUNTRY_SCOPES, REVIEWED_FX_CEILINGS, assessSnapshot, otherCountrySnapshotUnder,
  otherCountryWindowStart, type OtherCountryReviews,
} from "@/lib/other-country-snapshot";
import { otherCountryRule } from "@/lib/other-country-thresholds";
import { TAX_THRESHOLD_RULES } from "@/lib/tax-threshold";

/**
 * Art. 9a lock 3, jurisdiction "other", unit 3: the "threshold" treatment at checkout, under the coordinator's four
 * conditions (C5-20261119-1625-9a-other), from the owner's TX point 17 ("count the sales per country; turn each
 * registration and collection on before the local threshold").
 *
 *   1. Before the threshold, not at it: a sale goes ahead only while the country's count, WITH THIS SALE RESERVED,
 *      stays below OTHER_COUNTRY_SAFETY_PERCENT of the local threshold. Refunds, sales in flight, timing and the
 *      exchange rate all move the count.
 *   2. The exchange rate is the reviewed, dated ceiling of lib/other-country-snapshot.ts, never a guess: no reviewed
 *      rate or scope is "unknown", which refuses.
 *   3. Reserve before Stripe: the sale is reserved in the per-place counter first and the totals are read after, so
 *      two sales at once each see the other. A reservation not confirmed as "reserved" refuses. Every refusal after
 *      reserving releases it (a release that fails leaves a reservation that only counts against later sales, the
 *      dearer side). The caller settles it on payment and releases it on failure, expiry or refund.
 *   4. Nothing opens: DEEMED_SUPPLIER_RECORDS stays empty, so production answers "not-recorded" before anything is
 *      counted; a "threshold" record is a reviewed step for the coordinator and the owner; PLANS_ON_SALE and
 *      OPENING_REQUESTED stay false.
 *
 * Only countries whose rule counts one place are sold to (Canada and Norway, PLACE_COUNTED_COUNTRIES). Switzerland
 * counts worldwide turnover, which no place counter shows, and every country without a reviewed rule is refused:
 * "universalization not authorized" (AGENTS.md, TX point 17).
 *
 * The counter is Claude 4's lib/place-sales.ts (shape of 7020577795), passed in as a port: this file adds no counter,
 * and nothing calls it yet. Not wired into any checkout.
 */

/** Condition 1: a sale goes ahead only while the count with it stays below this percent of the local threshold. */
export const OTHER_COUNTRY_SAFETY_PERCENT = 90;

/** The stores' sales, which these thresholds count; Marktmorgen's own plans are another ledger. */
export const OTHER_COUNTRY_LEDGER = "store-sales";
type Ledger = typeof OTHER_COUNTRY_LEDGER;
type Place = Readonly<{ country: string; state: null }>;

/** The three calls of lib/place-sales.ts this gate makes (7020577795). Nothing else is asked of the counter. */
export type PlaceSalesCounter = Readonly<{
  /** Idempotent per (ledger, ref). */
  reserve(sale: { ledger: Ledger; place: Place; currency: string; amountMinor: number; ref: string; at: number }): Promise<"reserved" | "refused" | "unknown">;
  /** `placeTotals`: whole UTC months from the month of `since`; null when it cannot say. */
  totals(ledger: Ledger, place: Place, since: number, now: number): Promise<unknown>;
  /** Idempotent: true when released now or already. */
  release(ledger: Ledger, ref: string): Promise<boolean>;
}>;

export type ThresholdCheckoutDecision =
  | Readonly<{ allowed: true; jurisdictions: readonly DeemedSupplierJurisdiction[]; reservation: Readonly<{ ledger: Ledger; ref: string }> | null }>
  | Readonly<{ allowed: false; reason: "not-recorded" | "location-unknown" | "refused-jurisdiction"; jurisdictions: readonly DeemedSupplierJurisdiction[]; buyerMessage: string }>;

const refused = (jurisdictions: readonly DeemedSupplierJurisdiction[]): ThresholdCheckoutDecision =>
  Object.freeze({ allowed: false, reason: "refused-jurisdiction", jurisdictions, buyerMessage: REFUSAL_WORDS["refused-jurisdiction"] });

const CODE = /^[A-Z]{3}$/;
const MAX_REF = 255;
type Sale = { currency: string; amountMinor: number; ref: string };

/** The sale's own data fields, read once; null for anything else (a getter, an inherited field, a bad value). */
function ownSale(value: unknown): Sale | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const read: Record<string, unknown> = Object.create(null);
    for (const key of ["currency", "amountMinor", "ref"]) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !Object.hasOwn(field, "value")) return null;
      read[key] = field.value;
    }
    const { currency, amountMinor, ref } = read;
    if (typeof currency !== "string" || !CODE.test(currency)) return null;
    if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
    if (typeof ref !== "string" || ref.length === 0 || ref.length > MAX_REF) return null;
    return { currency, amountMinor, ref };
  } catch {
    return null;
  }
}

const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);

/**
 * Whether `country`'s count, from `totals` plus `sale`, assesses "below-threshold" under its own rule AND stays below
 * the safety margin, compared exactly in the threshold's minor units. Anything else (unknown, invalid, at or above
 * the margin) is false.
 */
function belowSafety(country: string, reviews: OtherCountryReviews, totals: unknown, sale: { currency: string; amountMinor: number }, now: number): boolean {
  const rule = otherCountryRule(country);
  if (!rule) return false;
  const assessment = assessSnapshot(country, otherCountrySnapshotUnder(reviews, country, totals, sale, now), now);
  if (assessment.status !== "below-threshold" || assessment.projectedApplicableMinor === null) return false;
  const threshold = BigInt(TAX_THRESHOLD_RULES[rule.ruleId].thresholdMinor);
  return BigInt(assessment.projectedApplicableMinor) * BigInt(100) < threshold * BigInt(OTHER_COUNTRY_SAFETY_PERCENT);
}

/** Release, never throwing: a reservation left behind only counts against later sales. */
async function release(counter: PlaceSalesCounter, ref: string): Promise<void> {
  try {
    await counter.release(OTHER_COUNTRY_LEDGER, ref);
  } catch {
    // Left reserved: the dearer side.
  }
}

/**
 * Sell or refuse, from the buyer's location, the sale, the per-place counter, the deemed-supplier records and the
 * reviewed rates and scopes given. Production uses thresholdCheckoutDecision, which takes this repository's own
 * records and reviews; this form exists so the gate can be tested with synthetic ones.
 *
 * A sale the pure gate allows (every jurisdiction collects) goes ahead with no reservation. A "count-needed" sale is
 * checked first WITHOUT the counter (the sale alone, against an empty window), so a country that can only be refused
 * costs no counter call; then reserved, counted, and allowed with its reservation, or released and refused.
 */
export async function thresholdCheckoutDecisionUnder(
  reviews: OtherCountryReviews,
  evidence: LocationEvidence,
  sale: unknown,
  counter: PlaceSalesCounter,
  records: unknown = DEEMED_SUPPLIER_RECORDS,
  now = Date.now(),
): Promise<ThresholdCheckoutDecision> {
  const decision: CheckoutLocationDecision = checkoutLocationDecision(evidence, records);
  if (decision.allowed) return Object.freeze({ allowed: true, jurisdictions: decision.jurisdictions, reservation: null });
  if (decision.reason !== "count-needed") return decision;
  const no = refused(decision.jurisdictions);
  const country = decision.country;
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) return no;
  const rule = otherCountryRule(country);
  if (!rule || !(PLACE_COUNTED_COUNTRIES as readonly string[]).includes(country)) return no;
  const ruleId = rule.ruleId;
  if (ruleId !== "ca-specified-supplies" && ruleId !== "no-remote-services") return no;
  const own = ownSale(sale);
  if (!own) return no;
  const place: Place = Object.freeze({ country, state: null });
  const since = otherCountryWindowStart(ruleId, now);

  // Before the counter: this sale alone, over a fully counted empty window. A missing rate or scope, or a sale that
  // alone reaches the margin, can only be refused, so the counter is never asked for it.
  const empty = { place, fromMonth: monthOf(since), toMonth: monthOf(now), countingSince: monthOf(since), complete: true, currencies: {} };
  if (!belowSafety(country, reviews, empty, { currency: own.currency, amountMinor: own.amountMinor }, now)) return no;

  // Reserve first, then count: the totals then hold this sale and every other one in flight.
  let reservation: unknown;
  try {
    reservation = await counter.reserve({ ledger: OTHER_COUNTRY_LEDGER, place, currency: own.currency, amountMinor: own.amountMinor, ref: own.ref, at: now });
  } catch {
    // It may or may not exist: release it (idempotent) and refuse.
    await release(counter, own.ref);
    return no;
  }
  if (reservation !== "reserved") return no;
  let totals: unknown;
  try {
    totals = await counter.totals(OTHER_COUNTRY_LEDGER, place, since, now);
  } catch {
    await release(counter, own.ref);
    return no;
  }
  // The sale is already in the totals as reserved, so nothing more is proposed.
  if (!belowSafety(country, reviews, totals, { currency: own.currency, amountMinor: 0 }, now)) {
    await release(counter, own.ref);
    return no;
  }
  return Object.freeze({ allowed: true, jurisdictions: decision.jurisdictions, reservation: Object.freeze({ ledger: OTHER_COUNTRY_LEDGER, ref: own.ref }) });
}

/** The gate with this repository's own records and reviewed rates and scopes: "not-recorded" while the records are empty. */
export function thresholdCheckoutDecision(
  evidence: LocationEvidence,
  sale: unknown,
  counter: PlaceSalesCounter,
  now = Date.now(),
): Promise<ThresholdCheckoutDecision> {
  return thresholdCheckoutDecisionUnder({ fx: REVIEWED_FX_CEILINGS, scopes: REVIEWED_COUNTRY_SCOPES }, evidence, sale, counter, DEEMED_SUPPLIER_RECORDS, now);
}
