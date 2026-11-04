import type { Metadata } from "next";
import { storeRoot } from "@/lib/store-sitemap";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, permanentRedirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { postForMembers, postIdFrom, postSegment, readPost } from "@/lib/store-blog";
import { letterWords } from "@/lib/buyer-words/letters";
import { memberPostWords } from "@/lib/buyer-words/member-posts";
import { memberReader } from "@/lib/letter-access";
import { readListings } from "@/lib/catalog";
import { productSegment } from "@/lib/product-slug";
import { LinkRequestForm } from "@/components/link-request-form";
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

type Params = {
  params: Promise<{ handle: string; post: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

const load = cache(async (raw: string, segment: string) => {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const store = await storeForPage(normaliseHandle(decoded));
  // A store switched off after notices (lib/takedown.ts) shows no posts.
  if (!store || store.suspended) return null;
  const id = postIdFrom(decodeURIComponent(segment));
  const post = id ? await readPost(store.statsId, id) : null;
  return post && !post.draft ? { store, post } : null;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, post: segment } = await params;
  const found = await load(handle, segment);
  if (!found) return { title: "Not found — Marktmorgen" };
  const { store, post } = found;
  const url = `${storeRoot(store)}/blog/${postSegment(post)}`;
  // Kept for members: its title only, never its words, and not offered to search engines.
  if (postForMembers(post)) {
    return { title: `${post.title} — ${store.name}`, alternates: { canonical: url }, robots: { index: false, follow: true }, openGraph: { title: post.title, url, type: "article" } };
  }
  return {
    title: `${post.title} — ${store.name}`,
    description: post.excerpt,
    alternates: { canonical: url },
    openGraph: { title: post.title, description: post.excerpt, url, type: "article", publishedTime: new Date(post.publishedAt * 1000).toISOString() },
  };
}

/**
 * One post of a store's blog (lib/store-blog.ts), and the product it ends on,
 * if any. A post kept for members shows its words only to the creator and to
 * a proved address that holds one of its products now (lib/letter-access.ts);
 * everyone else sees its title, its date, who it is for and a way to prove
 * their address.
 */
export default async function PostPage({ params, searchParams }: Params) {
  const { handle, post: segment } = await params;
  const found = await load(handle, segment);
  if (!found) notFound();
  const { store, post } = found;
  if (await isResting(store)) return <StoreResting store={store} />;
  // Its address with today's title in words: an older one still finds it.
  if (decodeURIComponent(segment) !== postSegment(post)) permanentRedirect(`/@${store.handle}/blog/${postSegment(post)}`);
  const say = speech(store);
  const { w } = say;
  const date = new Intl.DateTimeFormat(say.lang.locale, { year: "numeric", month: "long", day: "numeric" });
  const published = new Date(post.publishedAt * 1000);
  const featured = post.product ? featuredCards(store, "", [post.product]) : {};
  const url = `${storeRoot(store)}/blog/${postSegment(post)}`;
  const kept = postForMembers(post);
  const reader = kept ? await memberReader(store, post.products, await cookies()) : ({ state: "public" } as const);
  const readable = reader.state === "public" || reader.state === "owner" || reader.state === "in";
  const lw = letterWords(store.language);
  const pw = memberPostWords(store.language);
  const opens = kept ? await readListings(store, post.products) : [];
  const query = kept ? await searchParams : {};
  const linkState = typeof query.link === "string" ? query.link : "";
  const asked = lw.linkNotices[linkState];
  const notice = kept && !readable && asked ? (linkState === "sent" ? { ...asked, body: pw.sentBody } : asked) : undefined;
  return (
    <div lang={say.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      {/* Kept for members: no structured data, which would offer its title and first lines to search engines. */}
      {kept ? null : <JsonLd
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
      />}
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
            {kept ? ` · ${lw.membersLabel}` : null}
          </p>
          <h1 className="font-display mt-2 text-3xl font-semibold leading-tight sm:text-4xl">{post.title}</h1>
          {kept ? (
            <section aria-labelledby="post-for" className="mt-6">
              <h2 id="post-for" className="text-sm font-semibold">{readable ? lw.forHolders : lw.lockedLead}</h2>
              {reader.state === "owner" ? <p className="st-muted mt-1 text-sm">{opens.length ? lw.ownerNote : pw.noneLeft}</p> : null}
              <ul className="mt-2 space-y-1">
                {opens.map((p) => (
                  <li key={p.id} className="[overflow-wrap:anywhere]">
                    {p.hidden ? (
                      <span className="inline-flex min-h-11 items-center font-semibold">{p.title}</span>
                    ) : (
                      <Link href={`/@${store.handle}/p/${productSegment(p)}`} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
                        {p.title}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {readable ? (
            <div className="mt-6">
              <PostBody body={post.body} />
            </div>
          ) : null}
        </article>
        {kept && !readable ? (
          <>
            {notice ? (
              <div className="st-note mt-6" role="status">
                <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
                <p className="mt-1 text-sm">{notice.body}</p>
              </div>
            ) : null}
            {reader.state === "closed" ? (
              <div className="st-note mt-6" role="status">
                <p className="font-bold" style={{ color: "var(--st-text)" }}>{lw.closedTitle}</p>
                <p className="mt-1 text-sm">{pw.closedBody(reader.email)}</p>
              </div>
            ) : null}
            <LinkRequestForm
              action="/api/store/blog/link"
              hidden={{ handle: store.handle, post: post.id }}
              id="post-email"
              label={lw.linkLabel}
              explain={lw.linkExplain}
              button={lw.sendLink}
              placeholder={w.emailPlaceholder}
              language={store.language}
            />
          </>
        ) : null}
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
