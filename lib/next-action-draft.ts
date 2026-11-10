/**
 * Writes the email draft for one "Do this next" action when the creator asks (484 [IT1] complement WG, unit 3;
 * lib/next-action-draft-rules.ts has the bounds, the instructions and the check).
 *
 * The order, each step before the next can spend: the action must be one a draft is written for and must be on the
 * store's list right now (its count read again here, from the store's kept readings, never from the browser); the
 * request must fit its bound; then counted (lib/ai.ts) takes NEXT_DRAFT_JOBS of the month's AI uses, and askModel
 * reserves the request's dollar ceiling (lib/ai-spend.ts, at lib/spend-cost-table.ts's list prices) before the
 * fetch. A draft that fails the check is not shown; the use it took stays counted, because the provider may have
 * billed it (as every writing job, lib/ai.ts).
 *
 * Nothing is saved and nothing is sent: the draft goes back to the studio's screen.
 */
import { type AiResult, askModel, counted, jsonIn, writingModel, writingRules } from "@/lib/ai";
import { NEXT_DRAFT_CALL, NEXT_DRAFT_JOBS, draftRequest, fitsDraftCall, isDraftable, readDraft } from "@/lib/next-action-draft-rules";
import { nextFactsOf } from "@/lib/next-actions-read";
import type { NextActionId, NextFacts } from "@/lib/next-actions-rules";
import type { Store } from "@/lib/store";

export type DraftAsk = { ok: false; reason: "action" | "gone" | "unknown" } | AiResult<{ subject: string; body: string }>;

export type DraftDeps = {
  facts: (store: Store) => Promise<NextFacts>;
  ask: (store: Store, system: string, prompt: string, maxTokens: number) => Promise<string | null>;
  count: typeof counted;
};

const LIVE: DraftDeps = {
  facts: nextFactsOf,
  ask: (store, system, prompt, maxTokens) => askModel(store, system, prompt, maxTokens, writingModel()),
  count: counted,
};

/** The count behind an action, as read for the studio now: a number, or null when it could not be read. */
function countNow(id: NextActionId, facts: NextFacts): number | null | undefined {
  const fact = id === "failed_payments" ? facts.failedPayments : undefined;
  if (fact === undefined) return undefined;
  return typeof fact.count === "number" && Number.isSafeInteger(fact.count) && fact.count >= 0 ? fact.count : null;
}

export async function writeNextActionDraft(store: Store, id: unknown, now = Date.now(), deps: DraftDeps = LIVE): Promise<DraftAsk> {
  if (!isDraftable(id)) return { ok: false, reason: "action" };
  const count = countNow(id, await deps.facts(store));
  // Not read now: no draft on a guess. Read and at zero, or not on the list: nothing to write about.
  if (count === null) return { ok: false, reason: "unknown" };
  if (!count) return { ok: false, reason: "gone" };
  const names = { storeName: store.name, creatorName: store.mail?.fromName || store.name };
  const request = draftRequest(id, { ...names, rules: writingRules("English") });
  if (!request || !fitsDraftCall(request)) return { ok: false, reason: "notes" };
  return deps.count(
    store,
    now,
    async () => {
      const answer = await deps.ask(store, request.system, request.prompt, NEXT_DRAFT_CALL.outputTokens);
      const read = readDraft(answer ? jsonIn(answer) : null, names);
      return read.ok ? { subject: read.subject, body: read.body } : null;
    },
    NEXT_DRAFT_JOBS,
  );
}
