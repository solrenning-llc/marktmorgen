/**
 * Whether plans are on sale, as a plain constant browser code may read without running the commercial
 * review behind lib/opening.ts (PLANS_ON_SALE). It decides only words in the studio
 * (lib/studio-messages.ts); every gate, route and checkout reads PLANS_ON_SALE itself.
 * tests/opening-published.test.ts fails the moment the two differ, so the day plans open this
 * constant changes in the same pull request, or nothing merges.
 */
export const PLANS_ON_SALE_PUBLISHED: boolean = false;
