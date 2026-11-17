/**
 * The cost lines the owner lets use the dollar between US$65 and US$66 of the Store's refunded first year
 * (BROADCAST-262: "sim, US$66", 16 November 2026 02h15 Fortaleza, for the picture uploads). Every other line keeps the
 * year under US$65; all of them together keep it under US$66 (tests/read-ceilings.test.ts,
 * tests/email-logo-region.test.ts, tests/plan-margin.test.ts).
 *
 * One list, the same in every pull request that needs it, so two of them never conflict over it.
 */
export const CEILING_SHARED_DOLLAR_LINES: readonly { id: string; why: string }[] = [
  // A HubSpot deals check is priced in the imports line (#2048). Owner, 17 November 2026: "Usar o dólar 65–66".
  { id: "clickfunnels", why: "imports, with the HubSpot check (#2048); owner, 17/11/2026" },
  // The invite-credit job, platform-wide, charged whole on every plan (#4514). Owner, 17 November 2026: "Usar o dólar 65–66".
  { id: "invite-credit-reads", why: "the invite-credit job (#4514); owner, 17/11/2026" },
  // Page readings counted apart from the requests (#2571). Owner, 17 November 2026: "Usar o dólar 65–66".
  { id: "page-readings", why: "page readings (#2571); owner, 17/11/2026" },
  // Every picture upload's Blob operations (#2803). Owner, 16 November 2026 02h15: "sim, US$66" (BROADCAST-262).
  { id: "picture-uploads", why: "picture uploads (#2803); BROADCAST-262" },
];

/** What those lines cost a month on `tier`, from the registry's own lines (a line not in this tree counts nothing). */
export function sharedDollarMonthlyUsd(lines: readonly { id: string; monthlyUsd: (tier: never) => number }[], tier: string): number {
  return CEILING_SHARED_DOLLAR_LINES.reduce((sum, { id }) => sum + (lines.find((l) => l.id === id)?.monthlyUsd(tier as never) ?? 0), 0);
}
