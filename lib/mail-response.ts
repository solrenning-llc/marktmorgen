import { readDraftSubjectTest, sameDraftSubjectTest } from "@/lib/mail-draft-test";
import { sameDraftAudience } from "@/lib/mail-draft-audience";
import { readTags } from "@/lib/contact-rules";
import { readNarrow, type Narrow, sameNarrow } from "@/lib/segments-rules";
import { MAX_FLOW_WAIT_HOURS } from "@/lib/flow-rules";
export type MailAnswer = Record<string, unknown> & { ok?: boolean; error?: string };
/** A malformed response or failed HTTP request never confirms a mail operation. */
export function mailAnswer(responseOk: boolean, raw: unknown, sequenceWrite = false, draftWrite = false): MailAnswer {
  const unconfirmed: MailAnswer = { ok: false, error: sequenceWrite ? "flow_write_unconfirmed" : draftWrite ? "draft_write_unconfirmed" : "server_error" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unconfirmed;
  const answer = raw as Record<string, unknown>;
  if (responseOk && answer.ok === true) return answer as MailAnswer;
  if (answer.ok === false && typeof answer.error === "string") return answer as MailAnswer;
  return unconfirmed;
}

/** Only a confirmed numeric wait can be described as a kept-email result. */
export function keptWaitHours(answer: MailAnswer): number | null {
  const wait = answer.waitHours;
  return answer.ok === true && typeof wait === "number" && Number.isInteger(wait) && wait >= 0 && wait <= MAX_FLOW_WAIT_HOURS ? wait : null;
}

export type MailCopy = { subject: string; body: string; productId: string | null; who: "all" | "buyers" | "leads"; notProductId: string | null; narrow: Narrow | null; label?: string };
/** A copy must retain its content and audience before replacing the composer. */
export function confirmedMailCopy(answer: MailAnswer): MailCopy | null {
  if (answer.ok !== true || !answer.copy || typeof answer.copy !== "object" || Array.isArray(answer.copy)) return null;
  const copy = answer.copy as Record<string, unknown>;
  if (typeof copy.subject !== "string" || typeof copy.body !== "string" || !(copy.productId === null || typeof copy.productId === "string") || (copy.who !== "all" && copy.who !== "buyers" && copy.who !== "leads")) return null;
  if (!(copy.notProductId === null || typeof copy.notProductId === "string" && copy.notProductId.length > 0)) return null;
  let narrow: Narrow | null = null;
  if (copy.narrow !== null) {
    if (!copy.narrow || typeof copy.narrow !== "object" || Array.isArray(copy.narrow)) return null;
    const raw = copy.narrow as Record<string, unknown>;
    narrow = readNarrow(raw);
    if (!sameNarrow(raw, narrow)) return null;
  }
  // A label, when the sent email had one (99 [E2-TAG-BROADCAST]); absent on a copy of an older email.
  if (!(copy.label === undefined || copy.label === null || typeof copy.label === "string" && readTags([copy.label])[0] === copy.label)) return null;
  const label = typeof copy.label === "string" ? copy.label : "";
  return { subject: copy.subject, body: copy.body, productId: copy.productId, who: copy.who as MailCopy["who"], notProductId: copy.notProductId, narrow, ...(label ? { label } : {}) };
}

/** Accept only a complete draft result belonging to the draft being edited. */
export function confirmedDraftId(answer: MailAnswer, expectedId = "", expectedAudience?: unknown, expectedContent?: Record<string, unknown>, expectedSubjectTest?: unknown): string | null {
  if (answer.ok !== true || Object.hasOwn(answer, "error") || !answer.draft || typeof answer.draft !== "object" || Array.isArray(answer.draft)) return null;
  const draft = answer.draft as Record<string, unknown>;
  if (typeof draft.id !== "string" || !/^[0-9a-f]{16}$/.test(draft.id) || (expectedId !== "" && draft.id !== expectedId)) return null;
  if (typeof draft.subject !== "string" || !draft.subject.trim() || typeof draft.body !== "string" || !draft.body.trim()) return null;
  if (!(draft.productId === null || (typeof draft.productId === "string" && draft.productId !== "")) || typeof draft.by !== "string" || !draft.by.trim() || typeof draft.savedAt !== "string" || !Number.isFinite(Date.parse(draft.savedAt))) return null;
  if (Object.hasOwn(draft, "subjectTest") && readDraftSubjectTest(draft.subjectTest) === undefined) return null;
  if (expectedSubjectTest !== undefined && (!Object.hasOwn(draft, "subjectTest") || !sameDraftSubjectTest(draft.subjectTest, expectedSubjectTest))) return null;
  if (expectedAudience !== undefined && !sameDraftAudience(draft.audience, expectedAudience)) return null;
  if (expectedContent !== undefined) {
    if (typeof expectedContent.subject !== "string" || typeof expectedContent.body !== "string" || !(expectedContent.productId === null || typeof expectedContent.productId === "string")) return null;
    // Match saveDraft normalization, including its preserved body line endings.
    const subject = expectedContent.subject.replace(/\s+/g, " ").trim().slice(0, 150);
    const body = expectedContent.body.trim().slice(0, 20_000);
    const productId = expectedContent.productId || null;
    if (!subject || !body || draft.subject !== subject || draft.body !== body || draft.productId !== productId) return null;
  }
  return draft.id;
}

/** A recipient preview is known only with an explicit nonnegative whole count. */
export function confirmedRecipientCount(answer: MailAnswer): number | null {
  const count = answer.count;
  return answer.ok === true && typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

const REMOVAL_REFUSALS = new Set(["unknown", "draft_remove_conflict", "role", "locked", "store_gone", "none", "signed_out", "origin", "bad_request"]);
/** Confirm deletion only for the exact draft version selected in the list. */
export function draftRemovalAnswer(responseOk: boolean, raw: unknown, id: unknown, expectedSavedAt: unknown): MailAnswer {
  const unknown: MailAnswer = { ok: false, error: "draft_remove_unconfirmed" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unknown;
  const answer = raw as MailAnswer;
  if (answer.ok === false && typeof answer.error === "string" && REMOVAL_REFUSALS.has(answer.error) && !Object.hasOwn(answer, "removed")) return answer;
  if (!responseOk || answer.ok !== true || Object.hasOwn(answer, "error") || typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id) || typeof expectedSavedAt !== "string" || !Number.isFinite(Date.parse(expectedSavedAt)) || !answer.removed || typeof answer.removed !== "object" || Array.isArray(answer.removed)) return unknown;
  const removed = answer.removed as Record<string, unknown>;
  return removed.id === id && removed.savedAt === expectedSavedAt ? answer : unknown;
}
