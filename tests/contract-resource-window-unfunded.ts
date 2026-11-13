/**
 * For a route test whose world replaces the store and Redis modules: its stores are never in a funded period, so the
 * paid cohort is never asked. Answers false, so a funded period reaching it by mistake is refused, never let through.
 */
export const reservePaidResourceWindow = async (): Promise<boolean> => false;
