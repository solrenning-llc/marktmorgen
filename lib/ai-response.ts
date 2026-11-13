import { MAX_DRAFTED_BODY, MAX_DRAFTED_SUBJECT, type DraftedStep } from "@/lib/sequence-draft";
import { MAX_FLOW_WAIT_HOURS } from "@/lib/flow-rules";
import { isLanguage, type LanguageCode } from "@/lib/store-language";
/** `language`: the store language the draft is written in, when the answer says one (756 [STN3], unit 2). */
export type AiAnswer = { ok: true; value: unknown; left: number; language?: LanguageCode } | { ok: false; error: string };
/** Only a complete successful HTTP response confirms a writing result and allowance. */
export function readAiAnswer(responseOk: boolean, raw: unknown): AiAnswer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "unconfirmed" };
  const data = raw as Record<string, unknown>;
  if (responseOk && data.ok === true && data.value !== undefined && data.value !== null && typeof data.left === "number" && Number.isSafeInteger(data.left) && data.left >= 0) return { ok: true, value: data.value, left: data.left, ...(isLanguage(data.language) ? { language: data.language } : {}) };
  if (data.ok === false && typeof data.error === "string") return { ok: false, error: data.error };
  return { ok: false, error: "unconfirmed" };
}
export function isAiEmailCopy(value: unknown): value is { subject: string; body: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const copy = value as Record<string, unknown>;
  return typeof copy.subject === "string" && copy.subject.trim().length > 0 && typeof copy.body === "string" && copy.body.trim().length > 0;
}

/** Validate the sequence result as a whole before the editor maps any step. */
export function isAiSequenceDraft(value: unknown): value is DraftedStep[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 10 && value.every(step => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return false;
    return typeof step.delayHours === "number" && Number.isInteger(step.delayHours) && step.delayHours >= 0 && step.delayHours <= MAX_FLOW_WAIT_HOURS && typeof step.subject === "string" && step.subject.trim().length > 0 && step.subject.length <= MAX_DRAFTED_SUBJECT && typeof step.body === "string" && step.body.trim().length > 0 && step.body.length <= MAX_DRAFTED_BODY;
  });
}
