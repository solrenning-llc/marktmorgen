/**
 * lib/ai-file-pdf.ts as it is, with every drawing of a PDF counted, for the
 * tests of the file written with AI (tests/aliases/ai-file*.test.ts.json read
 * it as @/lib/ai-file-pdf): drawing is the save's heavy work, so a test can
 * say that a save refused before it drew nothing.
 */
import { filePdf as drawPdf, type FileSheet } from "../lib/ai-file-pdf";

export * from "../lib/ai-file-pdf";

/** How many PDFs were drawn. */
export const drawings = { count: 0 };

export async function filePdf(sheet: FileSheet): Promise<{ bytes: Uint8Array; pages: number }> {
  drawings.count += 1;
  return drawPdf(sheet);
}
