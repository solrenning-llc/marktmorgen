import { EmailField } from "@/components/email-field";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { readListing } from "@/lib/catalog";
import { readFeedToken } from "@/lib/podcast-access";
import { appLinks } from "@/lib/podcast-rules";
import { SITE_URL } from "@/lib/site-url";
import { speech } from "@/lib/buyer-words";
import { coursesWords } from "@/lib/buyer-words/courses";

type Params = {
  params: Promise<{ handle: string; product: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** The tab's title, in the store's language. */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  let language: unknown;
  try {
    const decoded = decodeURIComponent(handle);
    language = decoded.startsWith("@") ? (await storeForPage(normaliseHandle(decoded)))?.language : undefined;
  } catch {
    language = undefined;
  }
  return {
    title: coursesWords(language).metaPodcast,
    robots: { index: false, follow: false },
  };
}

/**
 * Where a buyer gets their own feed of a private podcast and adds it to their
 * podcast app; or, on another device, asks for it by email. In the store's
 * language (lib/buyer-words/courses.ts).
 */
export default async function PodcastPage({ params, searchParams }: Params) {
  const { handle: raw, product: productId } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const product = await readListing(store, productId);
  if (!product?.podcast) redirect(`/@${store.handle}`);
  const said = speech(store);
  const w = coursesWords(store.language);
  const query = await searchParams;
  const token = typeof query.t === "string" ? query.t : "";
  const status = typeof query.status === "string" ? query.status : "";
  const grant = token ? await readFeedToken(token) : null;
  const mine = grant && grant.s === store.statsId && grant.p === product.id ? token : null;
  const feed = mine ? `${SITE_URL}/api/store/podcast/feed/${mine}.xml` : null;
  const notice = w.podcastNotices[status];

  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          <p className="st-price text-sm">{w.privatePodcast}</p>
          <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{product.title}</h1>
          {feed ? (
            <>
              <p className="st-muted mt-4 text-lg">{w.ownFeed}</p>
              <div className="mt-6 grid gap-3">
                {appLinks(feed).map((app) => (
                  <a key={app.name} href={app.href} className="btn st-btn btn-block">
                    {w.addTo(app.name)}
                  </a>
                ))}
              </div>
              <label className="mt-6 block">
                <span className="st-label">{w.anotherApp}</span>
                <input className="st-field mt-2 font-mono text-sm" readOnly value={feed} />
              </label>
              <p className="st-muted mt-4 text-sm">{w.feedNote}</p>
            </>
          ) : (
            <>
              {notice ? (
                <div className="mt-5" role={status === "sent" ? "status" : "alert"}>
                  <p className="font-semibold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
                  <p className="st-muted mt-1">{notice.body}</p>
                </div>
              ) : (
                <p className="st-muted mt-4 text-lg">{w.boughtIt}</p>
              )}
              <form action="/api/store/podcast/link" method="post" className="mt-6 space-y-3">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="product" value={product.id} />
                <div>
                  <label htmlFor={`podcast-email-${product.id}`} className="st-label">{said.w.yourEmail}</label>
                  <EmailField id={`podcast-email-${product.id}`} name="email" className="st-field mt-2" required autoComplete="email" placeholder={said.w.emailPlaceholder} language={store.language} />
                </div>
                <button type="submit" className="btn st-btn btn-block">{w.emailMyFeed}</button>
              </form>
            </>
          )}
          <div className="mt-8">
            <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">{said.w.backTo(store.name)}</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
