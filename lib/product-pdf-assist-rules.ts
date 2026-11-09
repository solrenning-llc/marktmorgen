/**
 * "Suggest a title and benefits from your PDF" (758 [STN5], unit 4): the
 * rules the studio and the server share. Read by the browser too, so
 * nothing here talks to the model or the database (lib/product-pdf-assist.ts
 * and lib/ai.ts, readPdfThenWrite, do).
 *
 * The writing help reads the first pages of a product's own PDF, then
 * proposes a title, a short description and three to five benefits. The
 * studio puts the benefits in front of the creator's own description, as a
 * list under one heading, and never cuts what the creator wrote; nothing is
 * saved until the creator presses Save.
 */
import { READ_PDF_JOBS, READ_PDF_PAGES } from "@/lib/ai-rules";
import type { AiStep } from "@/lib/ai-steps";
import { MAX_TITLE_LENGTH } from "@/lib/catalog-rules";

/**
 * The writing step's request, at the most: these bytes of instructions and
 * of facts and words, and this many tokens back. Its most expensive
 * reservation on every model a deployment may pick is at most one priced
 * writing job (tests/product-pdf-assist.test.ts).
 */
export const PDF_ASSIST_SYSTEM_BYTES = 4_096;
export const PDF_ASSIST_PROMPT_BYTES = 8_192;
export const PDF_ASSIST_OUTPUT_TOKENS = 1_000;

/** How many benefits a proposal has: fewer kept than the least is a failure, more are cut to the most. */
export const PDF_BENEFITS_MIN = 3;
export const PDF_BENEFITS_MAX = 5;
/** Each part's longest: the title fits the form's name, the short description its box, with room. */
export const MAX_PDF_BENEFIT = 120;
export const MAX_PDF_TITLE = MAX_TITLE_LENGTH;
export const MAX_PDF_SUMMARY = 200;

/** The line above the benefits in the full description (a list, as components/product-about-view.tsx draws one). */
export const BENEFITS_HEADING = "What you get:";

export type PdfProposal = {
  /** None when the model's title was refused: the form keeps its own. */
  title: string | null;
  /** None when the model's short description was refused: the form keeps its own. */
  summary: string | null;
  benefits: string[];
};

/** The two steps: reading the PDF's first pages, then writing. */
export function pdfAssistSteps(): AiStep[] {
  return [
    { id: "read", label: `Reading the first ${READ_PDF_PAGES} pages of your PDF`, jobs: READ_PDF_JOBS },
    { id: "write", label: "Writing a title and benefits", jobs: 1 },
  ];
}

/** What the studio box says, in plain words, every sentence with no figure (AX274, 3.1.5). */
export const PDF_ASSIST_COPY = {
  title: "Suggest a title and benefits from your PDF",
  hint: "AI reads the start of this product's PDF. Then it suggests a name, a short description and a few benefits, using only what the PDF says. Only those pages are read, and nothing is kept.",
  placeholder: "Anything else it should know: who it is for, what makes it different. You can leave this empty.",
  done: "The name, the short description and the benefits are filled in below. Read them, change anything, then save.",
  file: "This product's PDF could not be read just now. Upload the PDF again, then try again.",
  undo: "Put back what was there",
  undone: "The name and both descriptions are back as they were.",
  keptTitle: "The name was not changed: the suggested one did not stick to what the PDF says.",
  keptSummary: "The short description was not changed: the suggested one did not stick to what the PDF says.",
  tooLong: "The benefits did not fit in the full description, so it was not changed. Shorten it, then try again.",
  aboutLoading: "Suggestions from your PDF open once your full description has been read.",
  aboutUnread: "Suggestions from your PDF are off here: your full description could not be read just now, and they would be put in front of it. Close this product and open it again to try.",
} as const;

/** Whether the form holds the creator's full description: suggestions are put in front of it only when it does. */
export type AboutState = "ready" | "loading" | "unread";

/**
 * The full description with the benefits in front of it: the heading, one
 * line per benefit starting with "- ", then a blank line and the creator's
 * own description, whole. Null when that would be longer than `max`:
 * nothing is put in and nothing is cut.
 */
export function withBenefits(about: string, benefits: readonly string[], max: number): string | null {
  const list = benefitsList(benefits);
  const next = about.trim() ? `${list}\n\n${about}` : list;
  return next.length <= max ? next : null;
}

/** The list put in front of the full description: the heading, then one line per benefit starting with "- ". */
export function benefitsList(benefits: readonly string[]): string {
  return [BENEFITS_HEADING, ...benefits.map((b) => `- ${b}`)].join("\n");
}

/**
 * The full description without the list this box put in front of it, when
 * it is still there exactly as put; otherwise unchanged (a list the creator
 * changed is theirs). A second suggestion replaces the first one's list
 * rather than adding a second.
 */
export function withoutList(about: string, list: string | null): string {
  if (!list) return about;
  if (about === list) return "";
  return about.startsWith(`${list}\n\n`) ? about.slice(list.length + 2) : about;
}

const fits = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** The route's answer as the studio reads it, in its exact shape, or null. */
export function readProposal(value: unknown): PdfProposal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "benefits,summary,title") return null;
  const { title, summary, benefits } = raw;
  if (title !== null && !fits(title, MAX_PDF_TITLE)) return null;
  if (summary !== null && !fits(summary, MAX_PDF_SUMMARY)) return null;
  if (!Array.isArray(benefits) || benefits.length < PDF_BENEFITS_MIN || benefits.length > PDF_BENEFITS_MAX) return null;
  if (!benefits.every((b) => fits(b, MAX_PDF_BENEFIT))) return null;
  return { title: title as string | null, summary: summary as string | null, benefits: [...(benefits as string[])] };
}
