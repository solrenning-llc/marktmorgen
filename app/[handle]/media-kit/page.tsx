import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { StoreTracking } from "@/components/store-tracking";
import { speech } from "@/lib/buyer-words";
import { kitWords } from "@/lib/buyer-words/kit";
import { combinedReach, kitShown } from "@/lib/store-kit";
import { SOCIALS, type SocialNetwork } from "@/lib/store-socials";
import { Icon } from "@/components/icons";
import { photoUrl } from "@/lib/photo-limits";
import { KIND, visibleCount } from "@/lib/catalog";
import { summaries } from "@/lib/reviews";
import { average, showsRating, storeSummary } from "@/lib/review-summary";
import { contactOpen } from "@/lib/store-contact";
import { PrintButton } from "@/components/print-button";
import { SITE_URL } from "@/lib/site-url";
import { readVerified } from "@/lib/verified-numbers";
import { NewTab } from "@/components/new-tab";

type Params = { params: Promise<{ handle: string }> };

async function load(raw: string) {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const store = await storeForPage(normaliseHandle(decoded));
  return store && !store.suspended && kitShown(store.kit) ? store : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  if (!store || store.suspended) return { title: "Not found — Marktmorgen", robots: { index: false, follow: false } };
  if (!kitShown(store.kit)) return {
    title: `${speech(store).w.missingTitle} — ${store.name}`,
    robots: { index: false, follow: false },
  };
  const w = kitWords(store.language);
  return {
    title: `${store.name}: ${w.title}`,
    description: store.kit.pitch.slice(0, 160) || store.bio || undefined,
    alternates: { canonical: `${SITE_URL}/@${store.handle}/media-kit` },
  };
}

/** How a network's number is named: followers, subscribers or monthly visitors. */
function countWord(network: SocialNetwork, w: ReturnType<typeof kitWords>): string {
  if (network === "website") return w.visitors;
  if (network === "email" || network === "youtube" || network === "substack") return w.subscribers;
  return w.followers;
}

/**
 * The creator's media kit (lib/store-kit.ts): for a brand deciding whether to
 * pay for a post. Every number the creator typed is said to be theirs, with
 * the day it was last changed; what this site counted itself is set apart.
 */
export default async function MediaKitPage({ params }: Params) {
  const { handle } = await params;
  const store = await load(handle);
  if (!store) notFound();
  const kit = store.kit;
  const said = speech(store);
  const w = kitWords(store.language);
  const compact = new Intl.NumberFormat(said.lang.locale, { notation: "compact", maximumFractionDigits: 1 });
  const profile = new Map(store.socials.map((social) => [social.network, social.url]));
  const reach = combinedReach(kit);

  // What this site counted, never typed: the products listed and the buyers' reviews of them.
  const listed = store.catalog.items.filter((item) => (item.kind & KIND.hidden) === 0).map((item) => item.id);
  const rated = store.reviewed ? await summaries(store.statsId).catch(() => new Map()) : new Map();
  const rating = storeSummary(rated, listed);
  const products = visibleCount(store);
  const since = /^\d{4}-\d{2}-\d{2}/.test(store.createdAt) ? said.date(Date.parse(`${store.createdAt.slice(0, 10)}T00:00:00Z`)) : "";
  // Numbers this site counted, where the creator chose to show them (lib/verified-numbers.ts): read once a day, kept.
  const counted = kit.counted;
  const wantsCounted = counted.visitors || counted.sales || counted.countries;
  const verified = wantsCounted ? await readVerified(store).catch(() => null) : null;
  const showVisitors = Boolean(verified && counted.visitors);
  const showSales = Boolean(verified && counted.sales && verified.salesRead);
  const showCountries = Boolean(verified && counted.countries && verified.countries.length);
  const regions = new Intl.DisplayNames([said.lang.locale], { type: "region" });
  const percent = new Intl.NumberFormat(said.lang.locale, { style: "percent", maximumFractionDigits: 0 });

  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} kit-page relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-3xl px-4 py-12 sm:py-16">
        <header className="text-center">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt={store.name} width={104} height={104} className="st-avatar" />
          ) : (
            <p aria-hidden="true" className="st-avatar st-avatar-initial">{store.name.slice(0, 1).toUpperCase()}</p>
          )}
          <p className="st-muted mt-5 text-sm font-bold uppercase tracking-[0.14em]">{w.title}</p>
          <h1 className="font-display mt-2 text-3xl font-semibold leading-tight tracking-[-0.02em] sm:text-4xl">{store.name}</h1>
          <p className="st-muted mt-1 text-sm font-semibold">@{store.handle}</p>
          {kit.pitch ? <p className="mx-auto mt-5 max-w-xl whitespace-pre-line text-lg leading-relaxed">{kit.pitch}</p> : null}
          <div className="kit-noprint mt-6 flex flex-wrap justify-center gap-2">
            {contactOpen(store) ? (
              <Link href={`/@${store.handle}#contact`} className="btn st-btn">{w.contact}</Link>
            ) : null}
            <PrintButton label={w.print} />
          </div>
        </header>

        {kit.audience.length ? (
          <section aria-labelledby="kit-audience" className="mt-12">
            <h2 id="kit-audience" className="st-section-title">{w.audienceTitle}</h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {kit.audience.map((row) => {
                const spec = SOCIALS[row.n];
                const url = profile.get(row.n);
                const inner = (
                  <>
                    <span className="st-link-icon" aria-hidden="true"><Icon name={spec.icon} size={18} /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{spec.label}</span>
                      <span className="font-display block text-2xl font-semibold tabular-nums">
                        {compact.format(row.count)} <span className="st-muted text-sm font-normal">{countWord(row.n, w)}</span>
                      </span>
                      {row.views ? <span className="st-muted block text-sm">{w.views(compact.format(row.views))}</span> : null}
                    </span>
                  </>
                );
                return (
                  <li key={row.n}>
                    {url && /^https:\/\//.test(url) ? (
                      <a href={url} target="_blank" rel="me noopener noreferrer" className="st-card st-link-card px-5 py-4 text-left">
                        <span className="flex items-center gap-4">{inner}</span>
                      <NewTab language={store.language} /></a>
                    ) : (
                      <div className="st-card flex items-center gap-4 px-5 py-4">{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            {kit.audience.length > 1 ? (
              <div className="st-card mt-3 px-5 py-4 text-center">
                <p className="text-sm font-semibold">{w.reach}</p>
                <p className="font-display text-3xl font-semibold tabular-nums">{compact.format(reach)}</p>
                <p className="st-muted mt-1 text-sm">{w.reachNote}</p>
              </div>
            ) : null}
            {kit.stated ? (
              <p className="st-muted mt-3 text-center text-sm">{w.stated(store.name, said.date(Date.parse(`${kit.stated}T00:00:00Z`)))}</p>
            ) : null}
          </section>
        ) : null}

        {kit.facts.length ? (
          <section aria-labelledby="kit-facts" className="mt-12">
            <h2 id="kit-facts" className="st-section-title">{w.factsTitle}</h2>
            <ul className="st-card divide-y px-5 sm:px-6" style={{ borderColor: "var(--st-line)" }}>
              {kit.facts.map((fact) => (
                <li key={fact} className="py-3 font-semibold" style={{ borderColor: "var(--st-line)" }}>{fact}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {products > 0 || showVisitors || showSales || showCountries ? (
          <section aria-labelledby="kit-counted" className="mt-12">
            <h2 id="kit-counted" className="st-section-title">{w.countedTitle}</h2>
            <dl className="grid gap-3 sm:grid-cols-3">
              <div className="st-card px-5 py-4 text-center">
                <dt className="st-muted text-sm font-semibold">{w.productsLabel}</dt>
                <dd className="font-display mt-1 text-2xl font-semibold tabular-nums">{said.num(products)}</dd>
              </div>
              {/* Unknown (null) while one listed product's numbers did not read: no rating, never a total without them. */}
              {rating !== null && showsRating(rating) ? (
                <div className="st-card px-5 py-4 text-center">
                  <dt className="st-muted text-sm font-semibold">{w.ratingLabel}</dt>
                  <dd className="font-display mt-1 text-2xl font-semibold tabular-nums">
                    {`${said.num(average(rating))} / 5`}
                    <span className="st-muted block text-sm font-normal">{w.reviews(rating.count, said.num(rating.count))}</span>
                  </dd>
                </div>
              ) : null}
              {since ? (
                <div className="st-card px-5 py-4 text-center">
                  <dt className="st-muted text-sm font-semibold">{w.sinceLabel}</dt>
                  <dd className="font-display mt-1 text-xl font-semibold">{since}</dd>
                </div>
              ) : null}
              {showVisitors && verified ? (
                <div className="st-card px-5 py-4 text-center" data-kit-counted="visitors">
                  <dt className="st-muted text-sm font-semibold">{w.countedVisitors}</dt>
                  <dd className="font-display mt-1 text-2xl font-semibold tabular-nums">{compact.format(verified.windows.d30.visitors)}</dd>
                </div>
              ) : null}
              {showSales && verified ? (
                <div className="st-card px-5 py-4 text-center" data-kit-counted="sales">
                  <dt className="st-muted text-sm font-semibold">{w.countedSales}</dt>
                  <dd className="font-display mt-1 text-2xl font-semibold tabular-nums">{said.num(verified.windows.d30.sales ?? 0)}</dd>
                </div>
              ) : null}
            </dl>
            {showCountries && verified ? (
              <div className="st-card mt-3 px-5 py-4" data-kit-counted="countries">
                <p className="st-muted text-sm font-semibold">{w.countedCountries}</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {verified.countries.map((c) => (
                    <li key={c.country} className="rounded-full px-3 py-1 text-sm font-semibold" style={{ background: "var(--st-line)" }}>
                      {`${regions.of(c.country) ?? c.country} ${percent.format(c.share)}`}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {verified && (showVisitors || showSales || showCountries) ? (
              <p className="st-muted mt-3 text-center text-sm">{w.countedNote(said.date(Date.parse(`${verified.day}T00:00:00Z`)))}</p>
            ) : null}
          </section>
        ) : null}

        {kit.rates.length ? (
          <section aria-labelledby="kit-rates" className="mt-12">
            <h2 id="kit-rates" className="st-section-title">{w.ratesTitle}</h2>
            <ul className="space-y-2">
              {kit.rates.map((rate) => (
                <li key={rate.t} className="st-row st-card px-5 py-4">
                  <span className="font-semibold">{rate.t}</span>
                  {rate.cents ? <span className="st-price">{said.money(rate.cents)}</span> : <span className="st-muted text-sm font-semibold">{w.ask}</span>}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {kit.brands.length ? (
          <section aria-labelledby="kit-brands" className="mt-12">
            <h2 id="kit-brands" className="st-section-title">{w.brandsTitle}</h2>
            <ul className="flex flex-wrap justify-center gap-2">
              {kit.brands.map((brand) => (
                <li key={brand} className="st-card rounded-full px-4 py-2 text-sm font-semibold">{brand}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="kit-noprint mt-12 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">{w.storeLink}</Link>
        </p>
        <StoreTracking store={store} presence event={null} />
      </main>
    </div>
  );
}
