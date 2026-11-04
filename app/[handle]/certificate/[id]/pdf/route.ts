import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { CERT_ID_PATTERN, readCertificate } from "@/lib/certificate";
import { CERTIFICATE_PDF_UNITS, canDraw, certificatePdf, type CertificateSheet } from "@/lib/certificate-pdf";
import { speech } from "@/lib/buyer-words";
import { coursesWords } from "@/lib/buyer-words/courses";
import { parseLanguage } from "@/lib/store-language";
import { SITE_URL } from "@/lib/site-url";
import { readCourseListing } from "@/lib/catalog";
import { monogram } from "@/lib/store-app";
import { readCourse } from "@/lib/course";
import { takePublicRequest } from "@/lib/traffic";
import { plain } from "@/lib/serve-file";

/**
 * A certificate of completion as a PDF file (lib/certificate-pdf.ts): the
 * same record the page shows, under the store that issued it; or, at
 * /certificate/sample/pdf?product=<id>, the sample a creator looks at before
 * any student has finished, stamped as one. A withdrawn
 * certificate has no file, and one whose name is in a script the file's
 * letters do not cover is sent back to its page, which prints it.
 *
 * Drawing a file is paid for before it is drawn (C3, 4 November 2026): one of
 * the store's public requests before anything is read, and the rest of
 * CERTIFICATE_PDF_UNITS before the file is made, on the public side for a
 * certificate too: its address is public (a check, a LinkedIn post), so
 * strangers opening it never spend what is kept for the store's buyers.
 * Past them the store is resting and nothing is drawn. The sample is the
 * same for everyone for a while, so the CDN keeps it five minutes: short,
 * so a course whose certificate is switched off or a store whose look
 * changes shows it within minutes. A certificate can be withdrawn, so no
 * cache keeps one: the browser asks every time, and gets "not modified",
 * without the file being drawn again, only while the record and the store's
 * look are the same and it is not withdrawn.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ handle: string; id: string }> }) {
  const { handle, id } = await params;
  const decoded = decodeURIComponent(handle);
  if (!decoded.startsWith("@") || (id !== "sample" && !CERT_ID_PATTERN.test(id))) return new Response("Not found", { status: 404 });
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) return new Response("Not found", { status: 404 });
  const sample = id === "sample";
  const now = Date.now();
  const resting = () => plain(503, speech(store).w.restingTitle);
  if (!(await takePublicRequest(store, "public", now, 1))) return resting();
  const w = coursesWords(store.language);
  let certificate = sample ? null : await readCertificate(id);
  if (sample) {
    const found = await readCourseListing(store, request.nextUrl.searchParams.get("product") ?? undefined);
    const course = found?.course ? await readCourse(found.course.id) : null;
    if (!found || !course?.certificate) return new Response("Not found", { status: 404 });
    certificate = { id: "sample", store: storeKey(store), productId: found.id, courseId: course.id, name: w.sampleName, title: found.title, creator: store.name, email: "", issuedAt: Math.floor(now / 1000), withdrawnAt: 0 };
  }
  if (!certificate || certificate.store !== storeKey(store) || certificate.withdrawnAt > 0) return new Response("Not found", { status: 404 });

  const page = `/@${store.handle}/certificate/${certificate.id}`;
  const said = speech(store);
  const sheet: CertificateSheet = {
    name: certificate.name,
    title: certificate.title,
    storeName: store.name,
    kicker: `${w.kicker}${w.kickerAccent}`,
    certifies: w.certifies,
    hasCompleted: w.hasCompleted,
    taughtBy: w.taughtBy(certificate.creator, said.date(certificate.issuedAt * 1000)),
    // A certificate that expires says until when, on the file too (639 [GL7](32)).
    idLine: sample ? w.sampleId : certificate.validUntil ? `${w.certId(certificate.id)} · ${w.validUntil(said.date(certificate.validUntil * 1000))}` : w.certId(certificate.id),
    checkLine: sample ? w.sampleCheck : w.checkAt(`${SITE_URL}${page}`.replace(/^https?:\/\//, "")),
    stamp: sample ? w.stampSample : "",
    accent: store.look.accent,
    // What a screen reader reads the file in: the store's language.
    lang: parseLanguage(store.language),
    // In the store's own look: its letters, its backdrop and its initial (630 [HN6](8), unit 2).
    look: { font: store.look.font, backdrop: store.look.backdrop },
    monogram: monogram(store),
  };
  // Everything the file is drawn from, and the code that draws it: the same tag, the same file.
  const tag = `"${createHash("sha256").update(JSON.stringify([process.env.VERCEL_GIT_COMMIT_SHA ?? "", sheet])).digest("base64url").slice(0, 32)}"`;
  const cache: Record<string, string> = sample
    ? // Five minutes at the CDN: a sample switched off or redrawn in a new look is seen soon, each try past it paid as above.
      { "Cache-Control": "public, max-age=0, s-maxage=300" }
    : { "Cache-Control": "private, no-cache", ETag: tag };
  if (!sample && (request.headers.get("if-none-match") ?? "").split(",").some((one) => one.trim().replace(/^W\//, "") === tag)) {
    return new Response(null, { status: 304, headers: { ...cache, "X-Robots-Tag": "noindex" } });
  }
  if (CERTIFICATE_PDF_UNITS > 1 && !(await takePublicRequest(store, "public", now, CERTIFICATE_PDF_UNITS - 1))) return resting();
  if (!(await canDraw(certificate.name, certificate.title, certificate.creator, store.name))) {
    return new Response(null, { status: 303, headers: { Location: new URL(page, request.nextUrl.origin).toString(), "Cache-Control": "no-store" } });
  }
  const bytes = await certificatePdf(sheet);
  const file = `${certificate.title}-${certificate.name}`.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80) || "certificate";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="certificate.pdf"; filename*=UTF-8''${encodeURIComponent(file)}.pdf`,
      ...cache,
      "X-Robots-Tag": "noindex",
    },
  });
}
