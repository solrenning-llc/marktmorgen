/**
 * A ceiling on the Redis commands a piece of work sends, whatever module sends them (Claude 7's and Claude 5's MEDIUM
 * on #4514): a job priced at "at most N commands a run" is held to N in code, not by counting its call sites.
 *
 * Inside `withCommandCeiling(limit, run)`, every pipeline sent by lib/redis.ts (and by the memory Redis the tests
 * use) first spends its command count here. A pipeline that would pass the ceiling of the work it runs in, or of any
 * work around it, is refused before anything is sent (CommandCeilingError): nothing of it reaches Redis or is billed.
 * Outside any ceiling, nothing is counted. The count follows the work through its awaits (AsyncLocalStorage), so work
 * running beside it is never charged to it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Budget = { left: number; outer: Budget | null };

const budgets = new AsyncLocalStorage<Budget>();

/** A pipeline refused because it would pass its work's command ceiling; nothing of it was sent. */
export class CommandCeilingError extends Error {
  constructor(count: number, left: number) {
    super(`a pipeline of ${count} commands would pass its work's ceiling (${left} left); nothing was sent`);
    this.name = "CommandCeilingError";
  }
}

/** Runs `run` with at most `limit` Redis commands sent, inside the ceilings already around it. */
export function withCommandCeiling<T>(limit: number, run: () => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("a command ceiling is a whole number");
  return budgets.run({ left: limit, outer: budgets.getStore() ?? null }, run);
}

/** Spends `count` commands of every ceiling around the caller, or throws before any is spent when one would pass. */
export function spendCommands(count: number): void {
  const inner = budgets.getStore();
  if (!inner) return;
  for (let budget: Budget | null = inner; budget; budget = budget.outer) {
    if (count > budget.left) throw new CommandCeilingError(count, budget.left);
  }
  for (let budget: Budget | null = inner; budget; budget = budget.outer) budget.left -= count;
}

// The meter lib/redis.ts (and the tests' Redis stand-in) spend through: registered here, never imported there, so this
// server-only module stays out of every browser bundle.
(globalThis as Record<symbol, unknown>)[Symbol.for("marktmorgen.redis.spendCommands")] = spendCommands;
