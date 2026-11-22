/**
 * The product's file written with AI (758 [STN5], unit 3): a guide a creator
 * sells as a PDF, planned first, written part by part, read and checked by the
 * creator (756 [STN3]), and only then made into a tagged PDF kept as the file of
 * one of their draft products. Rules the browser can read too: how big each
 * request may be (what it is priced at), how many parts a file may have, how a
 * plan and a part are read back, and the steps the studio shows. Nothing here
 * calls a model, reads or writes anything (lib/ai-file.ts does, on the server).
 *
 * Each part is one request to the writing model and one of the month's writing
 * jobs, and its worst reservation is at most a priced writing job on every
 * model a deployment may pick (tests/ai-file-rules.test.ts), so a file of n
 * parts uses n jobs, and the plan before it one more, inside AI_MONTHLY
 * (lib/ai-rules.ts): no credit or limit of its own.
 *
 * What it does not do in this unit, said where the studio offers it: no lists,
 * tables, pictures or links in the PDF (headings and paragraphs only), and no
 * notice inside the PDF that AI wrote it (the owner's decision of 9 November
 * 2026; the studio says it is an AI draft until the creator checks it).
 */
import type { AiStep } from "@/lib/ai-steps";

/** The most parts a file may have, and how many are written at once. */
export const MAX_FILE_SECTIONS = 10;
export const FILE_BATCH = 5;

/** The words each part is asked for, and the words a page of the PDF holds (12-point letters, lines of at most 80 characters), for "about N pages". */
export const FILE_SECTION_WORDS = 1_600;
export const FILE_PAGE_WORDS = 320;

/** What each request may carry and write back: instructions and the creator's words apart, and the tokens back. */
export const FILE_SYSTEM_BYTES = 4_096;
export const FILE_PROMPT_BYTES = 8_192;
export const FILE_SECTION_OUTPUT_TOKENS = 3_000;
export const FILE_OUTLINE_OUTPUT_TOKENS = 1_200;

/** Each piece of a plan at the most, and the points a part is planned with. */
export const MAX_FILE_TITLE = 100;
export const MAX_SECTION_TITLE = 100;
export const MAX_SECTION_POINT = 120;
export const SECTION_POINTS = 3;

/** The most characters one part's text may hold, as written or as the creator changed it. */
export const MAX_SECTION_CHARS = 14_000;

/** What the model ends a whole part with: a part without it was cut off and is not shown. */
export const SECTION_END = "[END]";

/** The biggest PDF kept: a file of ten parts is far smaller (tests/ai-file-pdf.test.ts). */
export const MAX_AI_FILE_BYTES = 4 * 1024 * 1024;

/** How long a written file may be saved as a PDF after its parts were written: one save for each run. */
export const AI_FILE_KEEP_SECONDS = 86_400;

/**
 * What making and keeping one PDF may take at the most, priced in the ai line
 * of tests/plan-cost-registry.ts for every writing job of the month (a file
 * takes at least two: its plan and one part): the function held at 2 GB with
 * a CPU busy for AI_FILE_RENDER_SECONDS, AI_FILE_REDIS_COMMANDS database
 * commands and AI_FILE_REDIS_BYTES moved; the bytes of a part sent to the
 * browser (AI_FILE_REPLY_BYTES) and of a save sent back (AI_FILE_SAVE_BYTES).
 * The PDF is kept in the creator's own storage, under the plan's storage
 * limit, and written as one of the plan's uploads (lib/upload-budget.ts),
 * whose costs are their own lines.
 */
export const AI_FILE_RENDER_SECONDS = 30;
export const AI_FILE_REDIS_COMMANDS = 30;
export const AI_FILE_REDIS_BYTES = 262_144;
export const AI_FILE_REPLY_BYTES = 3 * MAX_SECTION_CHARS + 2_048;
export const AI_FILE_SAVE_BYTES = 200_000;

export type FileOutline = { title: string; sections: { title: string; points: string[] }[] };
export type FileSection = { title: string; body: string };
export type FileDraft = { title: string; sections: FileSection[] };

/** "about 15 pages", for a file of this many parts. */
export function filePages(sections: number): number {
  return Math.max(1, Math.round((sections * FILE_SECTION_WORDS) / FILE_PAGE_WORDS));
}

/** The writing jobs a file of this many parts takes: one each. */
export function fileJobs(sections: number): number {
  return Number.isSafeInteger(sections) && sections > 0 ? sections : 0;
}

/** The steps the studio shows while the parts are written: one a part, by its title. */
export function fileSteps(titles: readonly string[]): AiStep[] {
  return titles.slice(0, MAX_FILE_SECTIONS).map((title, i) => ({ id: `section-${i + 1}` as const, label: `Writing part ${i + 1}: ${title}`, jobs: 1 }));
}

const URL_WORDS = /\b(?:https?:\/\/|www\.)\S+/gi;

/** One line of plain words: no addresses, no breaks, spaces folded. */
function plainLine(value: unknown): string {
  return typeof value === "string" ? value.replace(URL_WORDS, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
}

/** A plan the model wrote, made safe: one longer than a box allows is left out, never cut; null when nothing is left. */
export function parseOutline(raw: unknown): FileOutline | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as { title?: unknown; sections?: unknown };
  const title = plainLine(value.title);
  if (!title || title.length > MAX_FILE_TITLE || !Array.isArray(value.sections)) return null;
  const sections: FileOutline["sections"] = [];
  for (const entry of value.sections) {
    if (sections.length >= MAX_FILE_SECTIONS) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const part = entry as { title?: unknown; points?: unknown };
    const name = plainLine(part.title);
    if (!name || name.length > MAX_SECTION_TITLE) continue;
    const points = (Array.isArray(part.points) ? part.points : []).map(plainLine).filter((p) => p && p.length <= MAX_SECTION_POINT).slice(0, SECTION_POINTS);
    sections.push({ title: name, points });
  }
  return sections.length ? { title, sections } : null;
}

const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** A plan as the creator sends it back to be written: read exactly, never cut or mended; null for anything else. */
export function readOutlineInput(raw: unknown): FileOutline | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !exactKeys(raw, ["title", "sections"])) return null;
  const value = raw as { title: unknown; sections: unknown };
  if (typeof value.title !== "string" || plainLine(value.title) !== value.title || !value.title || value.title.length > MAX_FILE_TITLE) return null;
  if (!Array.isArray(value.sections) || value.sections.length < 1 || value.sections.length > MAX_FILE_SECTIONS) return null;
  const sections: FileOutline["sections"] = [];
  for (const entry of value.sections) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !exactKeys(entry, ["title", "points"])) return null;
    const part = entry as { title: unknown; points: unknown };
    if (typeof part.title !== "string" || !part.title || plainLine(part.title) !== part.title || part.title.length > MAX_SECTION_TITLE) return null;
    if (!Array.isArray(part.points) || part.points.length > SECTION_POINTS) return null;
    if (!part.points.every((p) => typeof p === "string" && p !== "" && plainLine(p) === p && p.length <= MAX_SECTION_POINT)) return null;
    sections.push({ title: part.title, points: [...(part.points as string[])] });
  }
  return { title: value.title, sections };
}

/**
 * One part as the model wrote it: whole only when it ends with SECTION_END;
 * headings, list marks and web addresses taken out, paragraphs kept apart by
 * one blank line. Null for a part cut off, empty, or longer than a part may be.
 */
export function readSectionText(text: unknown, title: string): FileSection | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.endsWith(SECTION_END)) return null;
  const paragraphs = trimmed
    .slice(0, -SECTION_END.length)
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((row) => row.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+)/, "").trim())
        .join(" ")
        .replace(URL_WORDS, "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  const body = paragraphs.join("\n\n");
  if (!body || body.length > MAX_SECTION_CHARS) return null;
  return { title, body };
}

/** A part's text as the creator left it in the studio: paragraphs apart by one blank line, nothing else changed. */
export function cleanSectionBody(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** A file as the creator sends it to be saved: read exactly; null for anything else, or a part left empty. */
export function readFileDraft(raw: unknown): FileDraft | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !exactKeys(raw, ["title", "sections"])) return null;
  const value = raw as { title: unknown; sections: unknown };
  if (typeof value.title !== "string" || !value.title || plainLine(value.title) !== value.title || value.title.length > MAX_FILE_TITLE) return null;
  if (!Array.isArray(value.sections) || value.sections.length < 1 || value.sections.length > MAX_FILE_SECTIONS) return null;
  const sections: FileSection[] = [];
  for (const entry of value.sections) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !exactKeys(entry, ["title", "body"])) return null;
    const part = entry as { title: unknown; body: unknown };
    if (typeof part.title !== "string" || !part.title || plainLine(part.title) !== part.title || part.title.length > MAX_SECTION_TITLE) return null;
    if (typeof part.body !== "string" || part.body.length > MAX_SECTION_CHARS || !part.body || cleanSectionBody(part.body) !== part.body) return null;
    sections.push({ title: part.title, body: part.body });
  }
  return { title: value.title, sections };
}

/** Every piece of text a file holds, for the checks under an AI draft (lib/ai-draft-review.ts). */
export function fileTexts(draft: FileDraft): string[] {
  return [draft.title, ...draft.sections.flatMap((s) => [s.title, s.body])];
}
