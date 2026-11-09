import { AsyncLocalStorage } from 'node:async_hooks';
/** One asynchronous job owns one shared attempt counter. No await occurs
 * between checking and consuming a slot, so concurrent calls cannot overdraw. */
type CallBudget = { storeId: string; remaining: number; closed: boolean; dispatched: number };
const context = new AsyncLocalStorage<CallBudget>();
export function hasAiCallBudget(): boolean { return context.getStore() !== undefined; }
export function consumeAiCallBudget(storeId: string): boolean {
  const budget = context.getStore();
  if (!budget || budget.closed || budget.storeId !== storeId || budget.remaining <= 0) return false;
  budget.remaining--;
  return true;
}
/** Called once a call's money is reserved, right before the provider is
 * asked: from here the attempt may be billed. False once the job is over,
 * so detached work never reaches the provider after its job was settled. */
export function noteAiDispatch(storeId: string): boolean {
  const budget = context.getStore();
  if (!budget || budget.closed || budget.storeId !== storeId) return false;
  budget.dispatched++;
  return true;
}
/** What a job's own budget saw, filled in when the job ends: `owned` is false
 * when it ran inside a parent's budget, whose calls it cannot tell apart. */
export type AiCallReport = { owned: boolean; dispatched: number };
/** Nested helpers share their parent's counter; they cannot renew it or move
 * the request to another store. Detached work cannot spend after completion. */
export async function withAiCallBudget<T>(storeId: string, maxCalls: number, run: () => Promise<T>, report?: AiCallReport): Promise<T | null> {
  if (typeof storeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(storeId)
    || !Number.isSafeInteger(maxCalls) || maxCalls <= 0) return null;
  const existing = context.getStore();
  if (existing) return existing.closed || existing.storeId !== storeId ? null : run();
  const budget: CallBudget = {storeId,remaining:maxCalls,closed:false,dispatched:0};
  return context.run(budget, async () => {try {return await run();} finally {budget.closed=true;if(report){report.owned=true;report.dispatched=budget.dispatched;}}});
}
