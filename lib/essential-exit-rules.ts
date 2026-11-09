/**
 * The figures of a member's way out past a store's own (lib/essential-exit.ts),
 * apart so the cost registry reads them without the counters
 * (tests/plan-cost-registry.ts, line member-exit).
 */

/** Presses on the way out from one connection to one store in a day, before the link is read. */
export const EXIT_PER_CONNECTION_DAY = 40;
/** What one member may do on the way out in a day once the store's own figure is used, of each kind. */
export const EXIT_PER_MEMBER_DAY = 5;
/** Presses and pages on the way out a store may have in its month once its window is used: priced (member-exit). */
export const EXIT_PRESSES_PER_STORE_MONTH = 12;
/** Links to manage a membership a store may send in its month once its access emails are used: priced (member-exit). */
export const EXIT_LINKS_PER_STORE_MONTH = 6;
