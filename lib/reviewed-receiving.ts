import { captureCustomerTaxInput, customerTaxCeiling, type CustomerTaxInput } from './customer-tax-review';
import { MOST_CORRECT_READING, POSITIVE_NET_CENTS, receivingOf, type UnitResult } from './receiving-costs';

const cents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const safe = (value: bigint): number | null => value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;

/** Complete non-receiving usage is an explicit ceiling, never a default zero.
 * A supplied scoped tax ceiling is reserved whole, even when its reviewed
 * pretax base exceeds this unit's actual pretax amount. Increasing usage never
 * earns an estimated tax credit. This is arithmetic over supplied evidence,
 * not a real review, resource authorization or release gate.
 */
export function reviewedUnitUnder(priceCents: number, usageCents: number, input: CustomerTaxInput | null, ownTransaction = true): UnitResult | null {
  if (!cents(priceCents) || priceCents <= 0 || !cents(usageCents) || typeof ownTransaction !== 'boolean') return null;
  const captured = captureCustomerTaxInput(input);
  if (!captured) return null;
  const received = receivingOf(priceCents, MOST_CORRECT_READING, ownTransaction);
  if (!Object.values(received).every(cents) || received.revenueCents <= 0) return null;
  const cost = BigInt(received.totalCents) + BigInt(usageCents);
  const pretax = BigInt(received.revenueCents) - cost;
  const taxCents = customerTaxCeiling(captured.taxReview, captured.taxContext, {
    revenueCents: received.revenueCents, refundableCents: 0, pretaxCents: pretax,
  });
  if (!cents(taxCents)) return null;
  const net = pretax - BigInt(taxCents);
  const floor = BigInt(POSITIVE_NET_CENTS);
  const costCents = safe(cost), pretaxCents = safe(pretax), netCents = safe(net);
  const gapCents = safe(net < floor ? floor - net : BigInt(0));
  const usageRoomCents = safe(BigInt(received.revenueCents) - BigInt(taxCents) - floor - BigInt(received.totalCents));
  // BigInt division truncates toward zero; round a negative ratio down too.
  const scaled = net * BigInt(10_000), revenue = BigInt(received.revenueCents);
  const ratio = scaled >= BigInt(0) ? scaled / revenue : -((-scaled + revenue - BigInt(1)) / revenue);
  const netBps = safe(ratio);
  if (costCents === null || pretaxCents === null || netCents === null || gapCents === null || usageRoomCents === null || netBps === null) return null;
  return { ...received, usageCents, costCents, pretaxCents, taxCents, netCents, netBps,
    floorCents: POSITIVE_NET_CENTS, meetsFloor: net >= floor, gapCents, usageRoomCents };
}
