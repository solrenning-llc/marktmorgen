import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { countStudio } from "@/lib/studio-route";
import { parseLanguage } from "@/lib/store-language";
import {
  FIRST_PRODUCT_BODY_BYTES,
  FIRST_PRODUCT_PDF_UNITS,
  firstProductDrawable,
  firstProductFileName,
  firstProductPdf,
  firstProductTexts,
  readFirstProduct,
} from "@/lib/first-product-pdf";

/**
 * The first product a creator wrote in the studio, as a tagged PDF to download (490 [PP1], unit 2;
 * lib/first-product-pdf.ts). Who may make it is who may change products. The text is read and checked against
 * the outline first; the rest of FIRST_PRODUCT_PDF_UNITS studio requests is taken before anything is drawn.
 * Made on request and kept nowhere: the creator adds the file to a product themselves.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", FIRST_PRODUCT_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  const read = readFirstProduct(body);
  if (!read.ok) return fail(read.reason);
  const texts = firstProductTexts(read.sheet, store.name);
  if (!(await firstProductDrawable(texts))) return fail("letters", 422);
  const taken = await countStudio(store, null, FIRST_PRODUCT_PDF_UNITS - 1);
  if (!taken.ok) return Response.json({ ok: false, error: "studio", message: taken.message }, { status: 429 });
  const bytes = await firstProductPdf(read.sheet, store.name, parseLanguage(store.language));
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${firstProductFileName(read.sheet.title)}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
