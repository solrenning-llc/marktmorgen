/** RED stub (758 [STN5] unit 3): the tagged PDF is drawn in the next commit. */
import { PDFDocument, type PDFFont } from "pdf-lib";
import type { FileDraft } from "@/lib/ai-file-rules";

export const MAX_LINE_CHARS = 80;
export const FILE_STYLE = { H1: { size: 24, gap: 18 }, H2: { size: 16, gap: 12 }, P: { size: 12, gap: 12 } } as const;
export function wrapLines(_font: Pick<PDFFont, "widthOfTextAtSize">, _text: string, _size: number): string[] {
  return [];
}
export async function fileDrawable(_draft: FileDraft, _storeName: string): Promise<boolean> {
  return false;
}
export type FileSheet = { draft: FileDraft; storeName: string; lang: string; at: Date };
export async function filePdf(_sheet: FileSheet): Promise<{ bytes: Uint8Array; pages: number }> {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return { bytes: await pdf.save(), pages: 0 };
}
