import { MINIMUM_NET_PROFIT_CENTS } from './net-margin-rules';

/** Exact arithmetic on an explicit absolute tax reserve, not a tax rate or
 * proof of legal facts. Unknown tax stays null; no percentage floor applies. */
export function maximumPretaxCostCents(revenueCents: number, taxesCeilingCents: number | null): number | null {
  if (!Number.isSafeInteger(revenueCents) || revenueCents <= 0 ||
      taxesCeilingCents === null || !Number.isSafeInteger(taxesCeilingCents) || taxesCeilingCents < 0) return null;
  const available = BigInt(revenueCents) - BigInt(taxesCeilingCents) - BigInt(MINIMUM_NET_PROFIT_CENTS);
  return available < BigInt(0) ? null : Number(available);
}

/** Every cost and tax must be explicitly supplied, even when zero. A bound
 * is never evidence of prepaid supplier funds or permission to sell. */
export function remainingResourceCostCents(
  revenueCents: number,
  taxesCeilingCents: number | null,
  otherCostCeilings: readonly (number | null)[],
): number | null {
  try {
    const maximum = maximumPretaxCostCents(revenueCents, taxesCeilingCents);
    if (maximum === null || !Array.isArray(otherCostCeilings)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(otherCostCeilings, 'length');
    const length = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    if (!Number.isSafeInteger(length) || length <= 0) return null;
    const keys = Reflect.ownKeys(otherCostCeilings);
    if (keys.length !== length + 1 || keys.some(key => typeof key !== 'string')) return null;
    const present = new Set(keys);
    let remaining = BigInt(maximum);
    for (let index = 0; index < length; index += 1) {
      if (!present.has(String(index))) return null;
      const entry = Object.getOwnPropertyDescriptor(otherCostCeilings, String(index));
      if (!entry || !Object.hasOwn(entry, 'value')) return null;
      const cost = entry.value;
      if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0) return null;
      remaining -= BigInt(cost);
      if (remaining < BigInt(0)) return null;
    }
    return Number(remaining);
  } catch { return null; }
}
