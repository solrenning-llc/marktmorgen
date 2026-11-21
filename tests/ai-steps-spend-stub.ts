/**
 * The money ledger as tests/ai-spend-regression-stub.ts plays it, with every
 * reservation counted, for tests/ai-steps.test.ts: a model call's money is
 * reserved right before it is sent (lib/ai.ts, askModel), so a step that
 * never started reserves none.
 */
export const isAiBudgetConfigured = () => true;
export const reservations = { count: 0 };
/** Refuse the reservation with this number (1 is the first ever made), as a spent ceiling would; 0 refuses none. */
export const refuse = { at: 0 };
/** Throw on the reservation with this number, as a ledger that cannot be reached would; 0 throws on none. */
export const fail = { at: 0 };
export const reserveAiSpend = async () => {
  if (fail.at > 0 && reservations.count + 1 === fail.at) {
    fail.at = 0;
    throw new Error("the ledger could not be reached");
  }
  if (refuse.at > 0 && reservations.count + 1 === refuse.at) {
    refuse.at = 0;
    return false;
  }
  reservations.count += 1;
  return true;
};
export const aiBudgetScopeFor = () => 'creator' as const;
