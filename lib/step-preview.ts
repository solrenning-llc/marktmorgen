/**
 * The preview text of a sequence's email (537 [PH1], unit 3; added 6
 * November 2026): the rules of lib/preheader.ts, applied where a sequence
 * (lib/flows.ts) keeps and sends its emails, so that file only calls these.
 *
 *   - Checked when the sequence is saved, against that email's own subject,
 *     since the mail app shows the two side by side; refused with the reason,
 *     never cut, and nothing is written.
 *   - Never kept on a step that acts instead of writing: such a step keeps no
 *     words at all.
 *   - Sent first in the email and as the first line of its text, by the same
 *     render as every email (lib/mail.ts). A stored one its rules refuse is
 *     never read as none: that email is not sent without it.
 *
 * Nothing new is sent, read or kept beyond the words themselves: a
 * sequence's emails are monthly emails, priced with their preview at its
 * largest (tests/plan-cost-registry.ts, list-email), and the sequences'
 * record is held inside the store's data room.
 */
import { type PreviewProblem, cleanPreview, isKeptPreview } from "@/lib/preheader";
import type { SendOutcome } from "@/lib/mail";

/** As a sequence keeps a step's subject (lib/flows.ts, cleanStep). */
const subjectOf = (raw: unknown, max: number) => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * The refusal for the first email of a sequence being saved whose preview its
 * rules refuse, as saveFlow gives it, so the studio says why; null when none
 * is. A step that acts is passed over: its words are not kept.
 */
export function refusedStepPreview(rawSteps: unknown[], maxSubject: number): `preview_${PreviewProblem}` | null {
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as Record<string, unknown>;
    if (step.action !== undefined && step.action !== null) continue;
    const read = cleanPreview(step.preview, subjectOf(step.subject, maxSubject));
    if (!read.ok) return `preview_${read.why}`;
  }
  return null;
}

/** A step's preview as kept: "" for none and on a step that acts; null when its rules refuse it. */
export function stepPreview(raw: unknown, subject: string, acting: boolean): string | null {
  if (acting) return "";
  const read = cleanPreview(raw, subject);
  return read.ok ? read.text : null;
}

/** What a stored step sends: "" for none, its preview when its rules keep it, null when they refuse it. */
export function sendablePreview(step: { subject: string; preview?: unknown }): string | null {
  if (step.preview === undefined) return "";
  return isKeptPreview(step.preview, step.subject) ? step.preview : null;
}

/** A step whose stored preview its rules refuse: refused as it is, nobody tried, so the run says so. */
export function refusedSend(going: string[]): SendOutcome {
  return { done: [], rest: [...going], stopped: "refused" };
}
