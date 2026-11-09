/** 758 [STN5] unit 4: placeholder until the PDF assistant is built (RED). */
import type { AiStep } from "@/lib/ai-steps";

export const PDF_ASSIST_SYSTEM_BYTES = 0;
export const PDF_ASSIST_PROMPT_BYTES = 0;
export const PDF_ASSIST_OUTPUT_TOKENS = 0;
export const PDF_BENEFITS_MIN = 0;
export const PDF_BENEFITS_MAX = 0;
export const MAX_PDF_BENEFIT = 0;
export const MAX_PDF_TITLE = 0;
export const MAX_PDF_SUMMARY = 0;
export const BENEFITS_HEADING = "";
export const PDF_ASSIST_COPY = { undo: "", file: "" } as const;
export type PdfProposal = { title: string | null; summary: string | null; benefits: string[] };
export const pdfAssistSteps = (): AiStep[] => [];
export const withBenefits = (_about: string, _benefits: string[], _max: number): string | null => null;
export const readProposal = (_value: unknown): PdfProposal | null => null;
