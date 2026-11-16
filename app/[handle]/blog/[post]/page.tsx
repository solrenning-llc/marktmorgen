import type { Metadata } from "next";
import { storeRoot } from "@/lib/store-sitemap";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { postIdFrom, postSegment, readPost } from "@/lib/store-blog";
import { speech } from "@/lib/buyer-words";
import { lookStyle } from "@/lib/store-look";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";
import { StoreTracking } from "@/components/store-tracking";
import { JsonLd } from "@/components/structured-data";
import { SITE_URL } from "@/lib/site-url";
import { photoUrl } from "@/lib/photo-limits";
import { PostBody } from "@/components/blog-body";
import { BlockView } from "@/components/sales-blocks";
import { featuredCards } from "@/lib/featured-cards";
import { cache } from "react";

type Params = { params: Promise<{ handle: string; post: string }> };

const load = cache(async (raw: string, segment: string) => {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const store = await storeForPage(normaliseHandle(decoded));
  // A store switched off after notices (lib/takedown.ts) shows no posts.
  if (!store || store.suspended) return null;
  const id = postIdFrom(decodeURIComponent(segment));
  const post = id ? await readPost(store.statsId, id).catch(() => undefined) : null;
  if (post === undefined) return { store, post: null, unavailable: true as const };
  return post && !post.draft ? { store, post, unavailable: false as const } : null;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, post: segment } = await params;
  const found = await load(handle, segment);
  if (!found) return { title: "Not found — Marktmorgen" };
  if (found.unavailable) return { title: `${speech(found.store).w.notAvailable} — ${found.store.name}`, robots: { index: false, follow: true } };
  const { store, post } = found;
  const url = `${storeRoot(store)}/blog/${postSegment(post)}`;
  return {
    title: `${post.title} — ${store.name}`,
    description: post.excerpt,
    alternates: { canonical: url },
    openGraph: { title: post.title, description: post.excerpt, url, type: "article", publishedTime: new Date(post.publishedAt * 1000).toISOString() },
  };
}

/** One post of a store's blog (lib/store-blog.ts), and the product it ends on, if any. */
export default async function PostPage({ params }: Params) {
  const { handle, post: segment } = await params;
  const found = await load(handle, segment);
  if (!found) notFound();
  const { store } = found;
  if (await isResting(store)) return <StoreResting store={store} />;
  if (found.unavailable) {
    const { w, lang } = speech(store);
    return (
      <div lang={lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
        <main id="content" className="relative mx-auto max-w-2xl px-4 pb-16 pt-10 sm:pt-14">
          <h1 className="font-display text-3xl font-semibold leading-tight">{w.blogOf(store.name)}</h1>
          <p role="status" className="st-muted mt-4">{w.notAvailable}</p>
          <Link href={`/@${store.handle}/blog`} className="st-footer-link mt-6 inline-block rounded-lg py-3 text-sm font-semibold">{w.blogAll}</Link>
        </main>
      </div>
    );
  }
  const { post } = found;
  // Its address with today's title in words: an older one still finds it.
  if (decodeURIComponent(segment) !== postSegment(post)) permanentRedirect(`/@${store.handle}/blog/${postSegment(post)}`);
  const say = speech(store);
  const { w } = say;
  const date = new Intl.DateTimeFormat(say.lang.locale, { year: "numeric", month: "long", day: "numeric" });
  const published = new Date(post.publishedAt * 1000);
  const featured = post.product ? featuredCards(store, "", [post.product]) : {};
  const url = `${storeRoot(store)}/blog/${postSegment(post)}`;
  return (
    <div lang={say.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          headline: post.title,
          description: post.excerpt,
          url,
          datePublished: published.toISOString(),
          dateModified: new Date(post.updatedAt * 1000).toISOString(),
          author: { "@type": "Organization", name: store.name, url: `${SITE_URL}/@${store.handle}` },
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
        <article className="mt-8">
          <p className="st-muted text-sm">
            <time dateTime={published.toISOString()}>{w.blogPublished(date.format(published))}</time>
            {` · ${w.blogMinutes(post.minutes)}`}
          </p>
          <h1 className="font-display mt-2 text-3xl font-semibold leading-tight sm:text-4xl">{post.title}</h1>
          <div className="mt-6">
            <PostBody body={post.body} />
          </div>
        </article>
        {post.product && featured[post.product] ? (
          <div className="mt-10">
            <BlockView
              block={{ id: "postprod", kind: "product", heading: w.blogFrom(store.name), product: post.product, note: "" }}
              ctx={{ storeName: store.name, productTitle: post.title, picture: null, photo: null, action: { kind: "none", text: "" }, defaultLabel: "", lang: store.language, featured }}
              reviews={null}
            />
          </div>
        ) : null}
        <div className="mt-12 flex flex-wrap justify-center gap-x-6 gap-y-2 text-center">
          <Link href={`/@${store.handle}/blog`} className="st-footer-link text-sm font-semibold">
            {w.blogAll}
          </Link>
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {w.everythingFrom(store.name)}
          </Link>
        </div>
        <StoreTracking store={store} presence />
      </main>
    </div>
  );
}
