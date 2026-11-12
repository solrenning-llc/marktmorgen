import {CREATOR_GUIDE_SLUGS} from "@/lib/evergreen-guides";
import {postBySlug} from "@/lib/blog";
import {PLANS_ON_SALE} from "@/lib/opening";
import type { Metadata } from "next";
import Link from "next/link";
import { BlogBrowser } from "@/components/blog-browser";
import { RevealOnScroll } from "@/components/home-parts";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import {
  BLOG_CATEGORIES,
  featuredPost,
  formatPostDate,
  postsSorted,
} from "@/lib/blog";
import { PUBLISHED_PRICE_CENTS as PRICE_CENTS, TRIAL_DAYS } from "@/lib/plan";
import { feeWords } from "@/lib/fee-words";

export const metadata: Metadata = {
  title: "The Marktmorgen Journal — selling digital products without the guesswork",
  description:
    "Plain guides on selling files, courses and calls from a link in your bio: what to charge, what the page has to say, where the money lands, and what every platform costs you per sale.",
};

export default function BlogIndexPage() {
  const featured = featuredPost();
  const posts = postsSorted();
  const latest = posts[0];

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <RevealOnScroll />
      <SiteNav />

      <main id="content" className="flex-1">
        <section className="surface-dawn border-b border-line">
          <div className="container-page py-14 sm:py-20">
            <p className="eyebrow">The Marktmorgen Journal</p>
            <h1 className="t-h1 balance mt-4 max-w-3xl">
              Everything we learn about <span className="serif font-normal text-violet-deep">selling your own work</span>
            </h1>
            <p className="t-lead mt-6 max-w-2xl text-ink-soft">
              No hacks, no invented case studies. What to charge, what the page has to say, where the money lands, and
              what each platform really costs you on a sale.
            </p>
            <p className="mt-6 flex max-w-[46ch] flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-mute">
              <span>{`${posts.length} articles`}</span>
              <span aria-hidden="true">·</span>
              <span>{latest ? `Written by us, latest ${formatPostDate(latest.date)}` : "Written by us"}</span>
              <span aria-hidden="true">·</span>
              <span>Facts about other companies carry their source</span>
            </p>
          </div>
        </section>

        <section className="container-page py-10" aria-labelledby="creator-guides-title" data-creator-guides>
          <h2 id="creator-guides-title" className="t-h2">Start with the offer you want to build</h2>
          <p className="mt-4 max-w-[46ch] text-ink-soft">Five practical guides: prepare the deliverable, explain its terms, test the access and review real records. Read the one that fits your work; none promises demand or earnings.</p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2">{CREATOR_GUIDE_SLUGS.map(slug=>{const guide=postBySlug(slug)!;return <li key={slug}><Link href={"/blog/"+slug} prefetch={false} className="block rounded-2xl border border-line bg-white p-5 font-semibold text-violet-deep underline underline-offset-4">{guide.title}</Link></li>;})}</ul>
        </section>

        {featured ? (
          <section className="container-page pt-12 sm:pt-16">
            <article className="reveal surface-night on-dark group relative grid gap-8 overflow-hidden rounded-[var(--r-xl)] p-7 sm:p-10 lg:grid-cols-[1.5fr_1fr] lg:items-center lg:p-12">
              <div>
                <div className="flex flex-wrap items-center gap-3 text-[0.8125rem]">
                  <span className="eyebrow">Featured</span>
                  <span className="text-white/70">
                    {featured.category} · {formatPostDate(featured.date)} · {featured.readMinutes} min read
                  </span>
                </div>
                <h2 className="t-h2 balance mt-4 text-white">
                  <Link href={`/blog/${featured.slug}`} className="after:absolute after:inset-0">
                    {featured.title}
                  </Link>
                </h2>
                <p className="mt-4 max-w-xl text-white/80">{featured.excerpt}</p>
                <p className="link-arrow on-dark mt-7">
                  Read the article
                  <span aria-hidden="true" className="arrow">
                    →
                  </span>
                </p>
              </div>
              <ul className="panel-dark relative space-y-3 p-6 text-[0.9375rem] text-white/80">
                <li className="text-[0.8125rem] font-semibold uppercase tracking-[0.14em] text-white/70">Inside</li>
                {[
                  "The card fee the pricing page leaves out",
                  "Where the money waits, and for how long",
                  "The arithmetic at 5, 9, 100 and 500 sales",
                  "When to stay on Gumroad, and when to move",
                ].map((line) => (
                  <li key={line} className="flex gap-3">
                    <span aria-hidden="true" className="text-violet-lift">
                      →
                    </span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </article>
          </section>
        ) : null}

        <section className="container-page py-14 sm:py-20">
          <h2 className="t-h2">More to explore</h2>
          <p className="mt-3 max-w-[46ch] text-ink-soft">
            Pick a subject or search for a word. Every article is written by us and says where its facts about other companies come from.
          </p>
          <div className="mt-8">
            <BlogBrowser posts={posts} categories={[...BLOG_CATEGORIES]} />
          </div>
        </section>

        <section className="surface-sand">
          <div className="container-page grid gap-8 py-16 sm:py-20 lg:grid-cols-[1.4fr_1fr] lg:items-center">
            <div>
              <h2 className="t-h2 balance">Reading about it is useful. Having a store is better.</h2>
              <p className="mt-4 max-w-xl text-ink-soft">
                {PLANS_ON_SALE ? `The published plan starts at USD ${PRICE_CENTS / 100} a month. An eligible first store may have a ${TRIAL_DAYS}-day trial; review its terms in your studio.` : `Published plan price: USD ${PRICE_CENTS / 100} a month when it opens. Paid plans and paid selling remain closed. You can prepare your store without starting a paid plan or an active trial.`} {feeWords().blogCta}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-4 lg:justify-end">
              <Link href="/signin" className="btn btn-primary btn-lg">
                Start your store
              </Link>
              <Link href="/demo" className="link-arrow">
                Open the live demo store
                <span aria-hidden="true" className="arrow">
                  →
                </span>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
