import {CREATOR_GUIDE_SLUGS} from "@/lib/evergreen-guides";
import {PLANS_ON_SALE} from "@/lib/opening";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BlogCard } from "@/components/blog-browser";
import { RevealOnScroll } from "@/components/home-parts";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { PostCover } from "@/components/post-cover";
import { ShareRow } from "@/components/share-row";
import { ArticleData } from "@/components/structured-data";
import { SITE_URL } from "@/lib/site-url";
import {
  BLOG_POSTS,
  type BlogBlock,
  formatPostDate,
  postBySlug,
  postsSorted,
} from "@/lib/blog";

export function generateStaticParams() {
  return BLOG_POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = postBySlug(slug);
  if (!post) return {};
  // Both blocks are spelled out, and that is deliberate. Setting only
  // `openGraph` here replaces the layout's copy of it and drops the image and
  // the address with it, while `twitter` quietly keeps inheriting the home
  // page's title — so an article used to share as the whole site. The picture
  // itself comes from opengraph-image.tsx beside this file.
  //
  // The section name is added only while the whole line still fits what a
  // search result shows. Past that, search engines cut the title mid-word,
  // and the reader loses the end of the headline to keep our own byline.
  const withSection = `${post.title} — The Marktmorgen Journal`;
  return {
    title: withSection.length <= 60 ? withSection : post.title,
    description: post.excerpt,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      type: "article",
      url: `/blog/${post.slug}`,
      siteName: "Marktmorgen",
      title: post.title,
      description: post.excerpt,
      publishedTime: post.date,
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.excerpt,
    },
  };
}

/** An id for a heading, so the index beside the article can link to it. */
function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function Block({ block }: { block: BlogBlock }) {
  switch (block.type) {
    case "h2":
      return (
        <h2 id={headingId(block.text)} className="scroll-mt-24">
          {block.text}
        </h2>
      );

    case "p":
      return <p>{block.text}</p>;

    case "ul":
      return (
        <ul>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );

    case "steps":
      return (
        <ol className="!list-none !pl-0 grid gap-3">
          {block.items.map((item, index) => (
            <li key={item.title} className="!mt-0 flex gap-4 rounded-[var(--r-md)] border border-line bg-white p-5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-lilac text-sm font-semibold text-violet-deep">
                {index + 1}
              </span>
              <span>
                <span className="block font-semibold text-ink">{item.title}</span>
                <span className="mt-1 block text-[1rem]">{item.text}</span>
              </span>
            </li>
          ))}
        </ol>
      );

    case "links":
      return <nav aria-label="Sources and next steps"><ul>{block.items.map(item=><li key={item.href}><Link href={item.href} prefetch={false}>{item.label}</Link></li>)}</ul></nav>;

    case "note":
      return (
        <aside className="rounded-[var(--r-md)] border border-line bg-sand p-6 text-[1rem]">
          <p className="mb-1.5 font-semibold text-ink">Worth knowing</p>
          <p>{block.text}</p>
        </aside>
      );
  }
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = postBySlug(slug);
  if (!post) notFound();

  const headings = post.body
    .filter((block): block is Extract<BlogBlock, { type: "h2" }> => block.type === "h2")
    .map((block) => ({ id: headingId(block.text), text: block.text }));

  const more = postsSorted()
    .filter((other) => other.slug !== post.slug)
    .slice(0, 3);

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <RevealOnScroll />
      <SiteNav />

      <main id="content" className="flex-1">
        <header className="border-b border-line bg-white">
          <div className="container-narrow py-12 sm:py-16">
            <Link href="/blog" className="link-arrow text-[0.9375rem]">
              <span aria-hidden="true">←</span> The Marktmorgen Journal
            </Link>
            <p className="mt-8 flex flex-wrap items-center gap-3 text-sm text-ink-mute">
              <span className="tag tag-brand">{post.category}</span>
              <span>{formatPostDate(post.date)}</span>
              <span aria-hidden="true">·</span>
              <span>{post.readMinutes} min read</span>
            </p>
            <h1 className="t-h1 balance mt-5">{post.title}</h1>
            <p className="t-lead mt-5 max-w-[46ch] text-ink-soft">{post.excerpt}</p>
            <p className="mt-8 text-sm text-ink-mute">Written by the Marktmorgen team.</p>
          </div>
        </header>

        {/* The article's own colours, carried over from the card that led here. */}
        <div className="container-page -mt-8 sm:-mt-10">
          <PostCover
            post={post}
            size="md"
            headings={headings.map((h) => h.text)}
            className="rounded-[var(--r-xl)] shadow-[var(--shadow-md)]"
          />
        </div>

        <div className="container-page py-12 sm:py-16 lg:grid lg:grid-cols-[15rem_minmax(0,46rem)] lg:justify-center lg:gap-14">
          {headings.length > 2 ? (
            <nav aria-labelledby="toc-title" className="mb-10 lg:sticky lg:top-24 lg:mb-0 lg:self-start">
              <p id="toc-title" className="text-[0.8125rem] font-semibold uppercase tracking-[0.14em] text-ink-mute">
                On this page
              </p>
              <ul className="mt-4 space-y-2.5 border-l border-line pl-4 text-[0.9375rem]">
                {headings.map((h) => (
                  <li key={h.id}>
                    <a href={`#${h.id}`} className="text-ink-soft underline-offset-4 transition-colors hover:text-violet-deep hover:underline">
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          <article className="min-w-0">
          <div className="prose-nb">
            {post.body.map((block, index) => (
              <Block key={index} block={block} />
            ))}
          </div>

          {post.faq?.length ? <section aria-labelledby="article-faq-title" className="mt-12" data-article-faq>
            <h2 id="article-faq-title" className="t-h3">Frequently asked questions</h2>
            <dl className="mt-5 space-y-5">{post.faq.map(item=><div key={item.q}><dt className="font-semibold text-ink">{item.q}</dt><dd className="mt-2 max-w-[46ch] leading-relaxed text-ink-soft">{item.a}</dd></div>)}</dl>
          </section> : null}

          {CREATOR_GUIDE_SLUGS.some(slug=>slug===post.slug) ? <nav aria-label="More creator guides" className="mt-10"><h2 className="t-h3">Continue with the next kind of offer</h2><ul className="mt-4 space-y-2">{CREATOR_GUIDE_SLUGS.filter(slug=>slug!==post.slug).map(slug=><li key={slug}><Link href={"/blog/"+slug} prefetch={false} className="link inline-flex min-h-11 items-center">{postBySlug(slug)!.title}</Link></li>)}</ul></nav> : null}
          <ShareRow url={`${SITE_URL}/blog/${post.slug}`} title={post.title} />

          <aside className="surface-night on-dark mt-16 overflow-hidden rounded-[var(--r-xl)] p-8 sm:p-10">
            <h2 className="t-section text-white">See it working before you believe us</h2>
            <p className="mt-3 max-w-lg text-white/80">
              The demo store is a real Stripe checkout with a test card. Buy the file, watch it arrive, then decide.
            </p>
            {!PLANS_ON_SALE ? <p className="mt-3 max-w-[46ch] text-sm text-white/80">Paid plans and paid selling remain closed. Start by preparing your store; a login link does not begin a paid plan.</p> : null}
            <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-4">
              <Link href="/demo" className="btn btn-light">
                Open the live demo store
              </Link>
              <Link href="/signin" className="link-arrow on-dark">
                Start your store
                <span aria-hidden="true" className="arrow">
                  →
                </span>
              </Link>
            </div>
          </aside>
          </article>
        </div>

        {more.length > 0 ? (
          <section className="surface-sand">
            <div className="container-page py-14 sm:py-20">
              <h2 className="t-h2">Read next</h2>
              <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {more.map((other) => (
                  <BlogCard key={other.slug} post={other} />
                ))}
              </div>
            </div>
          </section>
        ) : null}
      </main>

      <SiteFooter />
      <ArticleData post={post} />
    </div>
  );
}
