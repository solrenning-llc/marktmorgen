/**
 * Test-only stand-in for "@/lib/contract-resource-window"
 * (tests/sg2-l1-outreach-order.test.ts): counts the paid windows reserved,
 * and reserves each. Production code never imports this module.
 */
export const reserveWorld = { reserved: 0 };

export async function reservePaidResourceWindow(): Promise<boolean> {
  reserveWorld.reserved += 1;
  return true;
}
