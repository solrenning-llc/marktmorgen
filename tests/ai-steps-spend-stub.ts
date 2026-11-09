/**
 * The money ledger as tests/ai-spend-regression-stub.ts plays it, with every
 * reservation counted, for tests/ai-steps.test.ts: a model call's money is
 * reserved right before it is sent (lib/ai.ts, askModel), so a step that
 * never started reserves none.
 */
export const isAiBudgetConfigured = () => true;
export const reservations = { count: 0 };
export const reserveAiSpend = async () => {
  reservations.count += 1;
  return true;
};
export const aiBudgetScopeFor = () => 'creator' as const;
