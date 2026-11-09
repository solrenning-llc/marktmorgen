import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { speechFor } from "@/lib/buyer-words";
import { agreementWords } from "@/lib/buyer-words/agreements";
import { withinStore } from "@/lib/metered-limits";
import { clientAddress } from "@/lib/request-guard";
import { SITE_URL } from "@/lib/site-url";
import { ID_PATTERN, MAX_SIGNED_NAME, latestOf, statusOf } from "@/lib/agreement-rules";
import { agreementOf, readVersion } from "@/lib/agreement-store";
import { requestOf } from "@/lib/payment-request-store";
import { statusOf as requestStatus } from "@/lib/payment-request-rules";
import { requestLink } from "@/lib/payment-requests";
import { PrintButton } from "@/components/print-button";
import { StoreResting } from "@/components/store-resting";
import { EMAIL_ADDRESS_RULE, wholeAddress } from "@/lib/email-address-rule";

type Params = {
  params: Promise<{ handle: string; agreement: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** An agreement's link is a private address: never indexed, never followed. */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return { title: `${agreementWords(store?.language).pageTitle("agreement")}${store ? ` — ${store.name}` : ""}`, robots: { index: false, follow: false } };
}

/** How many times one connection may open agreement pages of one store in ten minutes. */
const VIEWS_PER_TEN_MINUTES = 60;

/**
 * One proposal or agreement, as the person it was sent to sees it
 * (lib/agreement-rules.ts): who sent it, the exact text and its SHA-256
 * fingerprint, what is recorded when they sign, that they may ask for a
 * paper copy or another way to sign, that enforceability depends on local
 * law, and the form to sign it. Signed, it shows what was recorded and can
 * be printed or saved as PDF.
 */
export default async function AgreementPage({ params, searchParams }: Params) {
  const { handle: raw, agreement: id } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@") || !ID_PATTERN.test(id)) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  // One of the store's buyer requests, counted in its window (lib/traffic.ts).
  const allowed = await withinStore("agreement-view", `${clientAddress({ headers: await headers() })}|${store.handle}`, VIEWS_PER_TEN_MINUTES, 600, store, "buyer");
  if (!allowed) return <StoreResting store={store} />;
  const agreement = await agreementOf(store, id);
  if (!agreement) notFound();
  const latest = latestOf(agreement);
  const version = latest ? await readVersion(agreement, latest.n) : null;
  if (!latest || !version) notFound();
  const query = await searchParams;
  const now = new Date().getTime();
  const status = statusOf(agreement, now);
  const said = speechFor(store.language, version.currency);
  const w = agreementWords(store.language);
  const notice = typeof query.notice === "string" && query.notice !== "signed" ? w.notices[query.notice] : undefined;
  const signature = latest.signature;
  const earlier = [...agreement.versions].reverse().find((m) => m.n < latest.n && m.signature);
  const reportUrl = `/report?url=${encodeURIComponent(`${SITE_URL}/@${store.handle}`)}`;
  const pay = status === "signed" && agreement.payRequest ? await requestOf(store, agreement.payRequest).catch(() => null) : null;
  const payOpen = pay && requestStatus(pay, now) === "open";

  const heading = status === "signed" ? w.signedTitle : status === "withdrawn" ? w.withdrawnTitle : status === "expired" ? w.expiredTitle : w.pageTitle(agreement.kind);

  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-2xl px-4 py-12 sm:py-16">
        <div className="st-card p-6 sm:p-10">
          <p className="st-muted text-sm font-semibold">{w.eyebrow(store.name)}</p>
          <h1 className="mt-2 font-display text-3xl font-semibold leading-tight sm:text-4xl">{heading}</h1>
          {status === "open" ? <p className="st-muted mt-4 text-lg">{w.lead(store.name)}</p> : null}
          {status === "signed" && signature ? <p className="st-muted mt-4 text-lg">{w.signedBody(signature.name, said.date(signature.at))}</p> : null}
          {status === "withdrawn" ? <p className="st-muted mt-4 text-lg">{w.withdrawnBody(store.name)}</p> : null}
          {status === "expired" ? <p className="st-muted mt-4 text-lg">{w.expiredBody(store.name)}</p> : null}
          {earlier?.signature && status !== "signed" ? <p className="st-muted mt-3 text-sm">{w.signedEarlier(earlier.n, earlier.signature.name, said.date(earlier.signature.at))}</p> : null}
          {notice ? (
            <div className="st-note mt-5" role="alert">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
              <p className="mt-1 text-sm">{notice.body}</p>
            </div>
          ) : null}

          <h2 className="mt-8 text-sm font-semibold">{w.textHeading}</h2>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg border p-4 font-sans text-sm leading-relaxed [overflow-wrap:anywhere]" style={{ borderColor: "var(--st-line, rgba(0,0,0,0.15))" }}>
            {version.text}
          </pre>
          <p className="st-muted mt-2 text-xs [overflow-wrap:anywhere]">
            {`${w.versionLabel} ${version.n} · ${w.fingerprint}: `}
            <code>{version.sha256}</code>
          </p>

          {status === "signed" && signature ? (
            <div className="mt-6">
              <h2 className="text-sm font-semibold">{w.copyRecord}</h2>
              <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="font-semibold">{w.signedBy}</dt>
                <dd className="[overflow-wrap:anywhere]">{signature.name}</dd>
                <dt className="font-semibold">{w.signedAt}</dt>
                <dd>{new Date(signature.at).toISOString().replace("T", " ").slice(0, 19)}</dd>
                <dt className="font-semibold">{w.consentLabel}</dt>
                <dd>{signature.consent}</dd>
                <dt className="font-semibold">{w.ipLabel}</dt>
                <dd>{signature.ipHash ? w.ipRecorded : w.ipNone}</dd>
              </dl>
              <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
                <PrintButton label={w.print} />
                {payOpen && pay ? (
                  <a href={requestLink(store, pay)} className="btn st-btn">
                    {w.pay(store.name)}
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}

          {status === "open" ? (
            <form action="/api/store/agreement-sign" method="post" target="_top" className="mt-8">
              <h2 className="text-lg font-semibold">{w.signHeading}</h2>
              <p className="st-muted mt-2 text-sm">{w.before(store.name)}</p>
              <p className="st-muted mt-2 text-sm">{w.recorded}</p>
              <p className="st-muted mt-2 text-sm">{w.enforce(store.name)}</p>
              <input type="hidden" name="handle" value={store.handle} />
              <input type="hidden" name="agreement" value={agreement.id} />
              <input type="hidden" name="version" value={String(version.n)} />
              <input type="hidden" name="sha256" value={version.sha256} />
              <label className="mt-5 block text-sm font-semibold" htmlFor="sign-name">{w.nameLabel}</label>
              <input id="sign-name" name="name" required minLength={2} maxLength={MAX_SIGNED_NAME} autoComplete="name" className="st-field mt-1" />
              <label className="mt-4 block text-sm font-semibold" htmlFor="sign-email">{w.emailLabel}</label>
              <input id="sign-email" name="email" type="email" pattern={EMAIL_ADDRESS_RULE} title={wholeAddress(store.language)} required maxLength={254} autoComplete="email" className="st-field mt-1" />
              <label className="mt-4 flex items-start gap-3 text-sm">
                <input type="checkbox" name="agree" value="yes" required className="mt-1" />
                <span>{w.consent}</span>
              </label>
              <p className="st-muted mt-3 text-sm font-semibold">{w.onlyYou}</p>
              <button type="submit" className="btn st-btn mt-5 w-full">{w.sign}</button>
              <p className="st-muted mt-3 text-sm">{w.until(said.date(agreement.expiresAt))}</p>
            </form>
          ) : null}

          {status === "open" ? <p className="st-muted mt-6 text-sm">{w.notYou(store.name)}</p> : null}
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
            <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
              {w.visit(store.name)}
            </Link>
            {status === "open" ? (
              <Link href={reportUrl} prefetch={false} rel="nofollow" className="st-footer-link text-sm">
                {w.report}
              </Link>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
