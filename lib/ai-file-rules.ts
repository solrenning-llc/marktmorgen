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
// RED stub (758 [STN5] unit 3): the rules are written in the next commit.

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

export function filePages(_sections: number): number {
  return 0;
}
export function fileJobs(_sections: number): number {
  return 0;
}
export function fileSteps(_titles: readonly string[]): AiStep[] {
  return [];
}
export function parseOutline(_raw: unknown): FileOutline | null {
  return null;
}
export function readOutlineInput(_raw: unknown): FileOutline | null {
  return null;
}
export function readSectionText(_text: unknown, _title: string): FileSection | null {
  return null;
}
export function cleanSectionBody(text: string): string {
  return text;
}
export function readFileDraft(_raw: unknown): FileDraft | null {
  return null;
}
export function fileTexts(_draft: FileDraft): string[] {
  return [];
}
