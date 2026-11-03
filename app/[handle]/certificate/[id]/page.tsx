import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { SITE_URL } from "@/lib/site-url";
import { storeKey } from "@/lib/learn";
import { CERT_ID_PATTERN, type Certificate, linkedInAddUrl, linkedInShareUrl, readCertificate, standingOf } from "@/lib/certificate";
import { readCourse } from "@/lib/course";
import { CertificateActions } from "@/components/certificate-actions";
import { readCourseListing } from "@/lib/catalog";
import { speech } from "@/lib/buyer-words";
import { coursesWords } from "@/lib/buyer-words/courses";

type Params = {
  params: Promise<{ handle: string; id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

async function load(rawHandle: string, id: string, product: string | undefined) {
  const decoded = decodeURIComponent(rawHandle);
  if (!decoded.startsWith("@")) return null;
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) return null;
  // The sample a creator looks at before any student has finished: the
  // course's real title and the creator's name, a placeholder for the rest.
  if (id === "sample") {
    const found = await readCourseListing(store, product);
    const course = found?.course ? await readCourse(found.course.id) : null;
    if (!found || !course?.certificate) return null;
    const sample: Certificate = {
      id: "sample",
      store: storeKey(store),
      productId: found.id,
      courseId: course.id,
      name: coursesWords(store.language).sampleName,
      title: found.title,
      creator: store.name,
      email: "",
      issuedAt: Math.floor(Date.now() / 1000),
      withdrawnAt: 0,
    };
    return { store, certificate: sample, sample: true };
  }
  if (!CERT_ID_PATTERN.test(id)) return null;
  const certificate = await readCertificate(id);
  // A certificate is only ever shown under the store that issued it, at any
  // address that store has used.
  if (!certificate || certificate.store !== storeKey(store)) return null;
  return { store, certificate, sample: false };
}

/** The store's language, for a page whose certificate was not found. */
async function languageOf(rawHandle: string): Promise<unknown> {
  try {
    const decoded = decodeURIComponent(rawHandle);
    return decoded.startsWith("@") ? (await storeForPage(normaliseHandle(decoded)))?.language : undefined;
  } catch {
    return undefined;
  }
}

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { handle, id } = await params;
  const query = await searchParams;
  const found = await load(handle, id, typeof query.product === "string" ? query.product : undefined);
  if (!found) return { title: coursesWords(await languageOf(handle)).metaCertNotFound, robots: { index: false, follow: false } };
  const { certificate } = found;
  const w = coursesWords(found.store.language);
  return {
    title: w.metaCert(certificate.name, certificate.title),
    description: w.metaCertDescription(certificate.name, certificate.title, certificate.creator),
    robots: { index: false, follow: false },
  };
}

/**
 * A certificate of completion, and the proof of it.
 *
 * Everything on the sheet is read from the record kept when it was issued
 * (lib/certificate.ts): nothing in the address can change a word of it, so
 * the page itself is the check. It prints on one landscape page, and comes
 * as a PDF file too (./pdf/route.ts, lib/certificate-pdf.ts). The words around what was
 * recorded are the store's language (lib/buyer-words/courses.ts).
 */
export default async function CertificatePage({ params, searchParams }: Params) {
  const { handle, id } = await params;
  const query = await searchParams;
  const found = await load(handle, id, typeof query.product === "string" ? query.product : undefined);
  if (!found) notFound();
  const { store, certificate, sample } = found;
  const said = speech(store);
  const w = coursesWords(store.language);
  const withdrawn = certificate.withdrawnAt > 0;
  // A certificate past its validity (639 [GL7](32)) says so, and is still the record of what it certified.
  const expired = !sample && standingOf(certificate, Math.floor(new Date().getTime() / 1000)) === "expired";
  const url = `${SITE_URL}/@${store.handle}/certificate/${certificate.id}`;
  const shortUrl = url.replace(/^https?:\/\//, "");
  const issued = said.date(certificate.issuedAt * 1000);

  return (
    <div
      lang={said.lang.locale}
      className={`st-page st-theme-${store.look.theme} cert-page relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-5xl px-4 py-8 sm:py-12">
        <div className="cert-noprint mx-auto max-w-3xl">
          {sample ? (
            <div className="st-note text-sm" role="status">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{w.sampleTitle}</p>
              <p className="mt-1">{w.sampleBody}</p>
            </div>
          ) : withdrawn ? (
            <div className="rounded-2xl bg-danger-soft px-5 py-4 text-sm text-ink" role="status">
              <p className="font-bold">{w.withdrawnOn(said.date(certificate.withdrawnAt * 1000))}</p>
              <p className="mt-1">{w.withdrawnBody(certificate.creator)}</p>
            </div>
          ) : expired ? (
            <div className="rounded-2xl px-5 py-4 text-sm" style={{ background: "var(--st-item)", color: "var(--st-text)" }} role="status">
              <p className="font-bold">{w.expiredOn(said.date((certificate.validUntil ?? 0) * 1000))}</p>
              <p className="mt-1">{w.onRecord(store.name, issued)} {w.expiredBody(certificate.creator)}</p>
            </div>
          ) : (
            <div className="rounded-2xl px-5 py-4 text-sm" style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }} role="status">
              <p className="font-bold">
                <span aria-hidden="true">{"✓ "}</span>
                {query.issued === "1" ? w.certReady : w.certGenuine}
              </p>
              <p className="mt-1">
                {w.onRecord(store.name, issued)}
                {certificate.validUntil ? ` ${w.validUntil(said.date(certificate.validUntil * 1000))}` : ""}
              </p>
            </div>
          )}
          {sample || withdrawn ? null : (
            <div className="mt-5">
              <CertificateActions
                url={url}
                linkedIn={{ add: linkedInAddUrl(certificate, url), share: linkedInShareUrl(url) }}
                pdf={`/@${store.handle}/certificate/${certificate.id}/pdf`}
                words={{ print: w.printOrSave, copy: w.copyLink, copied: w.linkCopied, prompt: w.copyThisLink, addToLinkedIn: w.addToLinkedIn, shareOnLinkedIn: w.shareOnLinkedIn, downloadPdf: w.downloadPdf }}
              />
            </div>
          )}
        </div>

        <article
          className={`cert-sheet mx-auto mt-6 ${withdrawn ? "cert-withdrawn" : ""}`}
          aria-label={w.certAria(certificate.name)}
        >
          <div className="cert-frame">
            <div className="cert-head">
              {store.photoId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoUrl(store.photoId)} alt="" className="cert-avatar" />
              ) : (
                <span aria-hidden="true" className="cert-avatar cert-avatar-initial">
                  {store.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="cert-store">{store.name}</span>
            </div>

            <h1 className="cert-kicker">{w.kicker}<span className="font-accent">{w.kickerAccent}</span></h1>
            <p className="cert-lead">{w.certifies}</p>
            <p className="cert-name">{certificate.name}</p>
            <p className="cert-lead">{w.hasCompleted}</p>
            <p className="cert-title">{certificate.title}</p>
            <p className="cert-by">{w.taughtBy(certificate.creator, issued)}</p>

            <div className="cert-foot">
              <div className="cert-seal" aria-hidden="true">
                <span>{"✓"}</span>
              </div>
              <div className="cert-proof">
                <p>{sample ? w.sampleId : w.certId(certificate.id)}</p>
                <p>{sample ? w.sampleCheck : w.checkAt(shortUrl)}</p>
              </div>
            </div>
            {sample ? <p className="cert-stamp" aria-hidden="true">{w.stampSample}</p> : withdrawn ? <p className="cert-stamp" aria-hidden="true">{w.stampWithdrawn}</p> : null}
          </div>
        </article>

        <div className="cert-noprint mt-8 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {w.visit(store.name)}
          </Link>
        </div>
      </main>
    </div>
  );
}
