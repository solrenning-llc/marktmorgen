import { MIN_TEST_REACH, newTest } from "@/lib/mail-test";
import type { MailAnswer } from "@/lib/mail-response";
import { readNarrow } from "@/lib/segments-rules";
import { readTags } from "@/lib/contact-rules";
const REFUSALS = new Set(["subject", "body", "when", "product", "empty", "allowance", "setup", "plan", "test_subject", "test_small", "test_links", "placeholder", "role", "locked", "store_gone", "none", "signed_out", "origin", "bad_request"]);
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const association = (value: unknown) => typeof value === "string" && value ? value : null;
/** Confirm creation, not delivery. Unknown write outcomes must not invite an immediate retry. */
export function broadcastAnswer(responseOk: boolean, raw: unknown, input: Record<string, unknown>): MailAnswer {
  const unknown: MailAnswer = { ok: false, error: "broadcast_write_unconfirmed" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unknown;
  const answer = raw as MailAnswer;
  if (answer.ok === false && typeof answer.error === "string" && REFUSALS.has(answer.error) && !Object.hasOwn(answer, "broadcast")) return answer;
  if (!responseOk || answer.ok !== true || Object.hasOwn(answer, "error") || !answer.broadcast || typeof answer.broadcast !== "object" || Array.isArray(answer.broadcast)) return unknown;
  const b = answer.broadcast as Record<string, unknown>;
  if (typeof b.id !== "string" || !/^[0-9a-f]{24}$/.test(b.id) || b.status !== "scheduled" || !positive(b.createdAt) || !positive(b.sendAt) || b.sendAt < b.createdAt || !positive(b.total) || b.sent !== 0) return unknown;
  // Match the normalization performed by createBroadcast (MAX_SUBJECT / MAX_MAIL_BODY).
  const subject = typeof input.subject === "string" ? input.subject.replace(/\s+/g, " ").trim().slice(0, 150) : "";
  const body = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n").trim().slice(0, 20_000) : "";
  if (!subject || !body || b.subject !== subject || b.body !== body || b.productId !== association(input.productId) || b.notProductId !== association(input.notProductId) || b.who !== input.who) return unknown;
  if (input.sendAt !== undefined && (typeof input.sendAt !== "number" || !Number.isFinite(input.sendAt) || b.sendAt !== Math.floor(input.sendAt / 1000))) return unknown;
  const narrow = readNarrow(input.narrow);
  if (narrow.minSpent || narrow.channel || narrow.quietDays) {
    if (!b.narrow || typeof b.narrow !== "object" || Array.isArray(b.narrow)) return unknown;
    const actual = b.narrow as Record<string, unknown>;
    if (actual.minSpent !== narrow.minSpent || actual.channel !== narrow.channel || actual.quietDays !== narrow.quietDays) return unknown;
  } else if (b.narrow !== null) return unknown;
  // The label as createBroadcast keeps it (99 [E2-TAG-BROADCAST]): a server that lost it would write to a broader group.
  const expectedLabel = readTags([typeof input.label === "string" ? input.label : ""])[0] ?? null;
  if ((typeof b.label === "string" ? b.label : null) !== expectedLabel) return unknown;
  const expectedTest = newTest(input.test, subject, 150);
  if (expectedTest === "subject") return unknown;
  if (expectedTest === "none") {
    if (b.test !== null) return unknown;
  } else {
    if ((b.total as number) < MIN_TEST_REACH) return unknown;
    if (!b.test || typeof b.test !== "object" || Array.isArray(b.test)) return unknown;
    const actualTest = b.test as Record<string, unknown>;
    // Creation returns the initial test, before any allocation or winner exists.
    if (Object.entries(expectedTest).some(([key, value]) => actualTest[key] !== value)) return unknown;
  }
  const noDraft = input.draftId === undefined || input.draftId === "";
  const draftCleanupConfirmed = noDraft || (
    typeof input.draftId === "string" && /^[0-9a-f]{16}$/.test(input.draftId) &&
    typeof input.draftSavedAt === "string" && Number.isFinite(Date.parse(input.draftSavedAt)) &&
    answer.draftCleanupConfirmed === true
  );
  // A confirmed campaign stays confirmed even when its draft cleanup is unknown.
  return { ...answer, draftCleanupConfirmed };
}

const CANCEL_REFUSALS = new Set(["unknown", "role", "locked", "store_gone", "none", "signed_out", "origin", "bad_request"]);
/** A generic success cannot confirm cancellation of the campaign the user chose. */
export function cancellationAnswer(responseOk: boolean, raw: unknown, id: unknown): MailAnswer {
  const unknown: MailAnswer = { ok: false, error: "broadcast_cancel_unconfirmed" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unknown;
  const answer = raw as MailAnswer;
  if (answer.ok === false && typeof answer.error === "string" && CANCEL_REFUSALS.has(answer.error) && !Object.hasOwn(answer, "cancelled")) return answer;
  if (!responseOk || answer.ok !== true || Object.hasOwn(answer, "error") || typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id) || !answer.cancelled || typeof answer.cancelled !== "object" || Array.isArray(answer.cancelled)) return unknown;
  const cancelled = answer.cancelled as Record<string, unknown>;
  return cancelled.id === id && cancelled.status === "cancelled" ? answer : unknown;
}
