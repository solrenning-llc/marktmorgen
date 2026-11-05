import { type VisitUs, telHref } from "@/lib/visit-us";
import { visitWords } from "@/lib/buyer-words/visit";

/** The "Visit us" block: a section with a heading, and each part the creator wrote under its own label (lib/buyer-words/visit.ts). */
export function VisitUsBlock({ visitUs, language }: { visitUs: VisitUs; language: string }) {
  const v = visitWords(language);
  return (
    <section className="st-card mt-8 px-5 py-5 sm:px-6" aria-labelledby="visit-us" data-visit-us="">
      <h2 id="visit-us" className="st-section-title" style={{ marginBottom: 0 }}>{v.heading}</h2>
      <dl className="mt-3 space-y-3">
        {visitUs.place ? (
          <div>
            <dt className="st-muted text-sm font-semibold">{v.address}</dt>
            <dd>
              <address className="not-italic [overflow-wrap:anywhere]">
                {visitUs.place.lines.map((line, i) => (
                  <span key={i} className="block">{line}</span>
                ))}
              </address>
            </dd>
          </div>
        ) : null}
        {visitUs.hours.length ? (
          <div>
            <dt className="st-muted text-sm font-semibold">{v.hours}</dt>
            <dd className="[overflow-wrap:anywhere]">
              {visitUs.hours.map((line, i) => (
                <span key={i} className="block">{line}</span>
              ))}
            </dd>
          </div>
        ) : null}
        {visitUs.phone ? (
          <div>
            <dt className="st-muted text-sm font-semibold">{v.phone}</dt>
            <dd>
              <a href={telHref(visitUs.phone)} className="st-footer-link inline-flex min-h-11 items-center font-semibold" aria-label={v.call(visitUs.phone)}>
                {visitUs.phone}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
