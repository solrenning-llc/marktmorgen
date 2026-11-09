"use client";

/** RED stub (758 [STN5] unit 3): the studio's box is written in the next commit. */
import type { StepView } from "@/components/ai-steps-assist";
import type { AiStepId } from "@/lib/ai-steps";
import type { FileDraft } from "@/lib/ai-file-rules";

export function finalStates(_ids: readonly AiStepId[], _states: Partial<Record<AiStepId, StepView>>): Partial<Record<AiStepId, StepView>> {
  return {};
}
export function AiFileReview(_props: { draft: FileDraft; given: string; checks: readonly boolean[]; missing: readonly string[]; saving: boolean; onToggle: (index: number, ticked: boolean) => void; onEdit: (index: number, body: string) => void; onSave: () => void }) {
  return null;
}
export function AiFileAssist(_props: { productId: string; onSaved: () => void }) {
  return null;
}
