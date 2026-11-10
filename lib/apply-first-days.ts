/**
 * How long an approved applicant's buy link works (604 [WP3]), in whole days the creator chooses.
 * Kept apart from lib/apply-first-rules.ts, which needs the server's crypto, so the studio's page
 * can offer the same choices in the browser. lib/apply-first-rules.ts exports these too.
 */
/** The link's life when the creator chooses nothing. */
export const APPLY_LINK_DAYS_DEFAULT = 7;
/** The shortest and longest life the creator may choose, in whole days. */
export const APPLY_LINK_DAYS_MIN = 1;
export const APPLY_LINK_DAYS_MAX = 30;
