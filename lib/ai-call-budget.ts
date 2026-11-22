import { AsyncLocalStorage } from 'node:async_hooks';
/** One asynchronous job owns one shared attempt counter. No await occurs
 * between checking and consuming a slot, so concurrent calls cannot overdraw. */
type CallBudget = { storeId: string; remaining: number; closed: boolean; dispatched: number; documents: number };
const context = new AsyncLocalStorage<CallBudget>();
export function hasAiCallBudget(): boolean { return context.getStore() !== undefined; }
export function consumeAiCallBudget(storeId: string): boolean {
  const budget = context.getStore();
  if (!budget || budget.closed || budget.storeId !== storeId || budget.remaining <= 0) return false;
  budget.remaining--;
  return true;
}
/** A document request (a product's PDF, read at the model's whole context) is funded only by a run that took the PDF's
 * jobs (lib/ai-rules.ts READ_PDF_JOBS, lib/ai-entitlement-rules.ts): each such run may read one. Outside a run, or past
 * its reads, false, and the caller asks nothing. No await between the check and the take. */
export function consumeAiDocumentRead(storeId: string): boolean {
  const budget = context.getStore();
  if (!budget || budget.closed || budget.storeId !== storeId || budget.documents <= 0) return false;
  budget.documents--;
  return true;
}
/** Called once a call's money is reserved, right before the provider is
 * asked: from here the attempt may be billed. Also called right before other
 * costly work inside the job (the creator's page read, lib/source-page.ts),
 * so that job keeps its count with no provider call. False once the job is over,
 * so detached work never reaches the provider after its job was settled. */
export function noteAiDispatch(storeId: string): boolean {
  const budget = context.getStore();
  if (!budget || budget.closed || budget.storeId !== storeId) return false;
  budget.dispatched++;
  return true;
}
/** How many calls the running job's budget has seen reach the provider so far
 * (noteAiDispatch), so a job told in steps knows which of its steps really
 * started (lib/ai.ts, writePage); null outside a job. */
export function aiDispatchCount(): number | null {
  const budget = context.getStore();
  return budget && !budget.closed ? budget.dispatched : null;
}
/** What a job's own budget saw, filled in when the job ends: `owned` is false
 * when it ran inside a parent's budget, whose calls it cannot tell apart. */
export type AiCallReport = { owned: boolean; dispatched: number };
/** Nested helpers share their parent's counter; they cannot renew it or move
 * the request to another store. Detached work cannot spend after completion.
 * `documents` is how many PDF reads the run paid for (none unless given). */
export async function withAiCallBudget<T>(storeId: string, maxCalls: number, run: () => Promise<T>, report?: AiCallReport, documents = 0): Promise<T | null> {
  if (typeof storeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(storeId)
    || !Number.isSafeInteger(maxCalls) || maxCalls <= 0 || !Number.isSafeInteger(documents) || documents < 0) return null;
  const existing = context.getStore();
  if (existing) return existing.closed || existing.storeId !== storeId ? null : run();
  const budget: CallBudget = {storeId,remaining:maxCalls,closed:false,dispatched:0,documents};
  return context.run(budget, async () => {try {return await run();} finally {budget.closed=true;if(report){report.owned=true;report.dispatched=budget.dispatched;}}});
}
