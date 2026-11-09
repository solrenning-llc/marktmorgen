/** 758 [STN5] unit 4: placeholder until the PDF assistant is built (RED). */
import type { AiResult } from "@/lib/ai";
import type { Store } from "@/lib/store";
import type { PdfProposal } from "@/lib/product-pdf-assist-rules";

type Words = { title: string; summary: string; about: string; notes: string };
export const pdfAssistRequest = (_store: Store, _words: Words, _facts: string): { system: string; prompt: string } | null => null;
export const keptProposal = (_answer: string, _facts: string): PdfProposal | null => null;
export async function writeFromPdf(_store: Store, _input: Words & { pdf: Uint8Array }, _now?: number, _steps?: { run: string; onStep: (step: "read" | "write", state: "started" | "done") => void }): Promise<AiResult<PdfProposal>> {
  return { ok: false, reason: "off" };
}
