/**
 * A sequence's emails drafted with AI (added 11 October 2026): the rules,
 * which the studio's browser reads too. The part that asks the model is in
 * lib/ai.ts (writeSequence); a sequence itself is lib/flows.ts.
 *
 * The two starter sequences (lib/mail-starters.ts) are the same words for
 * every store. This writes a sequence for the moment the creator picks — a
 * welcome, the days after somebody gets one product, the first purchase —
 * from what the store really sells: its products' names, summaries, prices
 * and links, and anything the creator types. Kajabi, Kit and Beacons draft
 * sequences with AI; Stan drafts single emails.
 *
 * What holds it to the store's own standard:
 *
 *   - Only the store's own links. A line of a drafted email that holds an
 *     address other than the store's (its page, its orders page, a product's
 *     page) is taken out, so a sequence never sends a reader somewhere invented.
 *   - The waits are kept to what a sequence can hold and to a sensible pace:
 *     the first email within a day, each later one 1 to 14 days after the one
 *     before.
 *   - Nothing is saved or switched on. The emails land in the sequence being
 *     edited; the creator reads them and presses Save the sequence.
 */
/** How many emails a creator may ask for at once, and the default. */
export const SEQUENCE_DRAFT_COUNTS = [3, 4, 5, 7] as const;
export const DEFAULT_SEQUENCE_DRAFT = 3;
/** The most of the store's products the writer is told about. */
export const MAX_SEQUENCE_PRODUCTS = 12;
/** The longest a drafted email is, and its subject: well inside what a sequence's email may be (lib/mail.ts). */
export const MAX_DRAFTED_BODY = 2_400;
export const MAX_DRAFTED_SUBJECT = 120;

export type DraftedStep = { delayHours: number; subject: string; body: string };

const ADDRESS = /https?:\/\/[^\s<>()"']+/gi;

/**
 * The body without any line that holds a web address other than `allowed`:
 * addresses are written on lines of their own, so the line goes with it and
 * no sentence is left pointing at nothing.
 */
export function keepOwnLinks(body: string, allowed: readonly string[]): string {
  const protocolKey = (link: string) => link.replace(/^https?:/i, (scheme) => scheme.toLowerCase());
  const own = new Set(allowed.map((link) => protocolKey(link).replace(/\/+$/, "")));
  const ours = (found: string) => own.has(protocolKey(found).replace(/[.,;:!?]+$/, "").replace(/\/+$/, ""));
  return body
    .split("\n")
    .filter((text) => (text.match(ADDRESS) ?? []).every(ours))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

const paragraph = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, max)
    : "";

/**
 * What the model sent, made into steps a sequence can hold: a subject and a
 * body each, only the store's own links, and waits kept to a sensible pace.
 * A step without a subject or a body is left out, never filled in by guess.
 */
export function readDraftedSteps(raw: unknown, count: number, links: readonly string[]): DraftedStep[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: DraftedStep[] = [];
  for (const item of list) {
    if (out.length >= count) break;
    const value = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const subject = clean(value.subject, MAX_DRAFTED_SUBJECT);
    const body = keepOwnLinks(paragraph(value.body, MAX_DRAFTED_BODY), links);
    if (!subject || !body) continue;
    const days = Number(value.waitDays);
    const first = out.length === 0;
    const wait = Number.isFinite(days) ? Math.round(days) : first ? 0 : 2;
    // The first within a day of the moment it starts on; each later one 1 to 14 days after the one before.
    const delayHours = first ? Math.max(0, Math.min(wait, 1)) * 24 : Math.max(1, Math.min(wait, 14)) * 24;
    out.push({ delayHours, subject, body });
  }
  return out;
}

type ExistingSequenceStep = { kind: string; subject: string; body: string };
/** Only wholly blank email placeholders are replaced by generated emails. */
export function keptSequenceSteps<T extends ExistingSequenceStep>(steps: readonly T[]): T[] {
  return steps.filter(step => step.kind !== "email" || step.subject.trim() !== "" || step.body.trim() !== "");
}
export function sequenceDraftSlots(steps: readonly ExistingSequenceStep[]): number {
  return Math.max(0, 10 - keptSequenceSteps(steps).length);
}
/** Preserve every existing and generated step; capacity is checked explicitly. */
export function appendSequenceDraft<T extends ExistingSequenceStep>(steps: readonly T[], generated: readonly T[]): T[] {
  return [...keptSequenceSteps(steps), ...generated];
}
