import type { Metadata } from "next";
import { storeRoot } from "@/lib/store-sitemap";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { POSTS_PER_PAGE, postForMembers, postSegment, publishedPosts } from "@/lib/store-blog";
import { letterWords } from "@/lib/buyer-words/letters";
import { speech } from "@/lib/buyer-words";
import { lookStyle } from "@/lib/store-look";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";
import { StoreTracking } from "@/components/store-tracking";
import { JsonLd } from "@/components/structured-data";
import { SITE_URL } from "@/lib/site-url";
import { photoUrl } from "@/lib/photo-limits";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
};

async function load(raw: string) {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  return storeForPage(normaliseHandle(decoded));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const store = await load((await params).handle);
  if (!store || store.posts === 0) return { title: "Not found — Marktmorgen" };
  const title = speech(store).w.blogOf(store.name);
  return {
    title,
    description: store.bio || title,
    alternates: { canonical: `${storeRoot(store)}/blog`, types: { "application/rss+xml": `${SITE_URL}/@${store.handle}/blog/feed.xml` } },
    openGraph: { title, description: store.bio || title, url: `${storeRoot(store)}/blog`, type: "website" },
  };
}

/**
 * A store's blog (lib/store-blog.ts): its published posts, newest first, a
 * page of them at a time. A store with none has no blog to show. A post kept
 * for members is listed by its title and date and says so; it has no first
 * lines to show, and its words stay on its own page, behind its door
 * (lib/letter-access.ts).
 */
export default async function BlogPage({ params, searchParams }: Params) {
  const store = await load((await params).handle);
  // A store switched off after notices (lib/takedown.ts) shows no posts.
  if (!store || store.suspended) notFound();
  if (await isResting(store)) return <StoreResting store={store} />;
  const query = searchParams ? await searchParams : {};
  const page = typeof query.page === "string" && /^\d{1,3}$/.test(query.page) ? Math.max(1, Number(query.page)) : 1;
  const { posts, total } = await publishedPosts(store.statsId, page);
  if (total === 0) notFound();
  const say = speech(store);
  const { w } = say;
  const date = new Intl.DateTimeFormat(say.lang.locale, { year: "numeric", month: "long", day: "numeric" });
  const pages = Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
  const membersLabel = letterWords(store.language).membersLabel;
  const base = `/@${store.handle}/blog`;
  return (
    <div lang={say.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Blog",
          name: w.blogOf(store.name),
          url: `${SITE_URL}${base}`,
          blogPost: posts.map((post) => ({
            "@type": "BlogPosting",
            headline: post.title,
            url: `${SITE_URL}${base}/${postSegment(post)}`,
            datePublished: new Date(post.publishedAt * 1000).toISOString(),
          })),
        }}
      />
      <main id="content" className="relative mx-auto max-w-2xl px-4 pb-16 pt-10 sm:pt-14">
        <Link href={`/@${store.handle}`} className="st-title-link mx-auto flex w-fit items-center gap-3 rounded-full py-1 pr-2">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt="" width={40} height={40} className="st-avatar !mx-0" style={{ width: 40, height: 40 }} />
          ) : (
            <span aria-hidden="true" className="st-avatar st-avatar-initial !mx-0" style={{ width: 40, height: 40, fontSize: "1rem" }}>
              {store.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="font-semibold">{store.name}</span>
        </Link>
        <h1 className="font-display mt-8 text-center text-3xl font-semibold leading-tight sm:text-4xl">{w.blogOf(store.name)}</h1>
        {posts.length === 0 ? (
          <p className="st-muted mt-8 text-center">{w.blogEmpty}</p>
        ) : (
          <ol className="mt-8 space-y-4">
            {posts.map((post) => (
              <li key={post.id}>
                <Link href={`${base}/${postSegment(post)}`} className="st-card st-post-card block p-5 sm:p-6">
                  <span className="st-muted block text-sm">
                    <time dateTime={new Date(post.publishedAt * 1000).toISOString()}>{date.format(new Date(post.publishedAt * 1000))}</time>
                    {` · ${w.blogMinutes(post.minutes)}`}
                    {postForMembers(post) ? ` · ${membersLabel}` : null}
                  </span>
                  <span className="font-display mt-1 block text-xl font-semibold leading-snug">{post.title}</span>
                  {post.excerpt ? <span className="st-muted mt-2 block leading-relaxed">{post.excerpt}</span> : null}
                </Link>
              </li>
            ))}
          </ol>
        )}
        {pages > 1 ? (
          <nav aria-label={w.blogAll} className="mt-8 flex items-center justify-between gap-3 text-sm font-semibold">
            {page > 1 ? (
              <Link href={page === 2 ? base : `${base}?page=${page - 1}`} className="st-footer-link">
                {w.blogNewer}
              </Link>
            ) : (
              <span />
            )}
            {page < pages ? (
              <Link href={`${base}?page=${page + 1}`} className="st-footer-link">
                {w.blogOlder}
              </Link>
            ) : null}
          </nav>
        ) : null}
        <div className="mt-12 flex flex-wrap justify-center gap-x-6 gap-y-2 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {w.everythingFrom(store.name)}
          </Link>
          <a href={`${base}/feed.xml`} className="st-footer-link text-sm font-semibold">
            {w.blogFeed}
          </a>
        </div>
        <StoreTracking store={store} presence />
      </main>
    </div>
  );
}
