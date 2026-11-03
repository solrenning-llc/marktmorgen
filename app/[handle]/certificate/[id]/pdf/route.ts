import type { NextRequest } from "next/server";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { CERT_ID_PATTERN, readCertificate } from "@/lib/certificate";
import { canDraw, certificatePdf } from "@/lib/certificate-pdf";
import { speech } from "@/lib/buyer-words";
import { coursesWords } from "@/lib/buyer-words/courses";
import { parseLanguage } from "@/lib/store-language";
import { SITE_URL } from "@/lib/site-url";
import { readCourseListing } from "@/lib/catalog";
import { monogram } from "@/lib/store-app";
import { readCourse } from "@/lib/course";

/**
 * A certificate of completion as a PDF file (lib/certificate-pdf.ts): the
 * same record the page shows, under the store that issued it; or, at
 * /certificate/sample/pdf?product=<id>, the sample a creator looks at before
 * any student has finished, stamped as one. A withdrawn
 * certificate has no file, and one whose name is in a script the file's
 * letters do not cover is sent back to its page, which prints it.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ handle: string; id: string }> }) {
  const { handle, id } = await params;
  const decoded = decodeURIComponent(handle);
  if (!decoded.startsWith("@") || (id !== "sample" && !CERT_ID_PATTERN.test(id))) return new Response("Not found", { status: 404 });
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) return new Response("Not found", { status: 404 });
  const w = coursesWords(store.language);
  let certificate = id === "sample" ? null : await readCertificate(id);
  if (id === "sample") {
    const found = await readCourseListing(store, request.nextUrl.searchParams.get("product") ?? undefined);
    const course = found?.course ? await readCourse(found.course.id) : null;
    if (!found || !course?.certificate) return new Response("Not found", { status: 404 });
    certificate = { id: "sample", store: storeKey(store), productId: found.id, courseId: course.id, name: w.sampleName, title: found.title, creator: store.name, email: "", issuedAt: Math.floor(Date.now() / 1000), withdrawnAt: 0 };
  }
  if (!certificate || certificate.store !== storeKey(store) || certificate.withdrawnAt > 0) return new Response("Not found", { status: 404 });
  const sample = id === "sample";

  const page = `/@${store.handle}/certificate/${certificate.id}`;
  if (!(await canDraw(certificate.name, certificate.title, certificate.creator, store.name))) {
    return new Response(null, { status: 303, headers: { Location: new URL(page, request.nextUrl.origin).toString() } });
  }
  const said = speech(store);
  const bytes = await certificatePdf({
    name: certificate.name,
    title: certificate.title,
    storeName: store.name,
    kicker: `${w.kicker}${w.kickerAccent}`,
    certifies: w.certifies,
    hasCompleted: w.hasCompleted,
    taughtBy: w.taughtBy(certificate.creator, said.date(certificate.issuedAt * 1000)),
    idLine: sample ? w.sampleId : w.certId(certificate.id),
    checkLine: sample ? w.sampleCheck : w.checkAt(`${SITE_URL}${page}`.replace(/^https?:\/\//, "")),
    stamp: sample ? w.stampSample : "",
    accent: store.look.accent,
    // What a screen reader reads the file in: the store's language.
    lang: parseLanguage(store.language),
    // In the store's own look: its letters, its backdrop and its initial (630 [HN6](8), unit 2).
    look: { font: store.look.font, backdrop: store.look.backdrop },
    monogram: monogram(store),
  });
  const file = `${certificate.title}-${certificate.name}`.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80) || "certificate";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="certificate.pdf"; filename*=UTF-8''${encodeURIComponent(file)}.pdf`,
      "Cache-Control": "private, max-age=300",
      "X-Robots-Tag": "noindex",
    },
  });
}
