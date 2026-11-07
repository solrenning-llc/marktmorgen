/**
 * A ceiling on the calls one piece of work makes to a creator's Stripe
 * account, for a door that paid for a set number of them before it reads
 * (lib/course-audio.ts, 298 [H5-1]). The ceiling is kept with the work, as
 * lib/fetch-timeout.ts keeps a cutoff, so code deep inside it needs no
 * counter passed down: lib/stripe-account.ts (onAccount) spends one before
 * every request it sends and, past the ceiling, throws StripeCallsSpent
 * instead of sending. Outside such work nothing is counted or refused.
 *
 * A caller inside the work may catch that throw (a door that reads a failed
 * dispute check as "not lost", lib/refunds.ts, rethrows it, so an answer cut
 * short is never kept as if whole). Whoever set the ceiling is told by the
 * result, never by what the work returned: a work that met the ceiling gives
 * no answer, and the door refuses rather than guesses.
 */

type Budget = { remaining: number; refused: boolean; closed: boolean };
type BudgetStore = { getStore(): Budget | undefined; run<R>(store: Budget, fn: () => R): R };

/**
 * Found when it runs, as lib/fetch-timeout.ts finds its own: the one Next.js
 * puts on globalThis, or Node's. With neither there is no way to hold a
 * ceiling, and withStripeCalls refuses.
 */
const budgets: BudgetStore | null = (() => {
  const g = globalThis as { AsyncLocalStorage?: new () => BudgetStore };
  if (typeof g.AsyncLocalStorage === "function") return new g.AsyncLocalStorage();
  const node = typeof process === "undefined" ? undefined : (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const hooks = node?.("node:async_hooks") as { AsyncLocalStorage?: new () => BudgetStore } | undefined;
  return hooks?.AsyncLocalStorage ? new hooks.AsyncLocalStorage() : null;
})();

/** Thrown, instead of sending, by a Stripe call past the ceiling of the work it runs in. */
export class StripeCallsSpent extends Error {
  constructor() {
    super("The Stripe calls paid for this work are spent");
    this.name = "StripeCallsSpent";
  }
}

export function isStripeCallsSpent(error: unknown): error is StripeCallsSpent {
  return error instanceof StripeCallsSpent;
}

/**
 * Spends one call of the work this runs in, before it is sent: throws
 * StripeCallsSpent when none is left, or when the work has already ended
 * (something it left running). Synchronous between the check and the spend,
 * so calls sent together never overdraw. Outside such work, nothing.
 */
export function spendStripeCall(): void {
  const budget = budgets?.getStore();
  if (!budget) return;
  if (budget.closed || budget.remaining <= 0) {
    budget.refused = true;
    throw new StripeCallsSpent();
  }
  budget.remaining -= 1;
}

export type HeldToCalls<T> = { ok: true; value: T } | { ok: false };

/**
 * Runs `work` with at most `calls` Stripe calls. `ok` false when a call past
 * them was refused (whatever the work did with the refusal), when the count is
 * not a whole number of calls, or when no ceiling can be held here. A work run
 * inside another one spends from that one's calls and adds none.
 */
export async function withStripeCalls<T>(calls: number, work: () => Promise<T>): Promise<HeldToCalls<T>> {
  if (!budgets || !Number.isSafeInteger(calls) || calls < 0) return { ok: false };
  const outer = budgets.getStore();
  const budget = outer ?? { remaining: calls, refused: false, closed: false };
  try {
    const value = outer ? await work() : await budgets.run(budget, work);
    return budget.refused ? { ok: false } : { ok: true, value };
  } catch (error) {
    if (budget.refused) return { ok: false };
    throw error;
  } finally {
    if (!outer) budget.closed = true;
  }
}
