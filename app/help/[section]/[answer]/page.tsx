import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { HelpTopics } from "@/components/help-topics";
import { HelpAnswerTools } from "@/components/help-answer-tools";
import { answerSummary, helpAnswer, helpAnswerPath, helpDay, helpPagePaths, sectionNeighbors, helpTopics } from "@/lib/help-pages";
import { HELP_DATES } from "@/lib/help-dates";
import { answerLinks } from "@/lib/help-areas";

/**
 * One answer of the help center on a page of its own (564 [HC1]): the trail
 * above it, the question as the page's title, the answer as /help shows it,
 * then the other answers of its section. Its own title and description for
 * search and link cards, and it is in the sitemap.
 */
export function generateStaticParams() {
  return helpPagePaths().filter((p) => p.answer).map((p) => ({ section: p.section, answer: p.answer as string }));
}

type Params = { params: Promise<{ section: string; answer: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { section, answer } = await params;
  const found = helpAnswer(section, answer);
  if (!found) return {};
  const path = helpAnswerPath(section, answer);
  return {
    title: `${found.q} — Marktmorgen Help`,
    description: answerSummary(found.a),
    alternates: { canonical: path },
    openGraph: { type: "article", url: path, siteName: "Marktmorgen", title: found.q, description: answerSummary(found.a) },
  };
}

export default async function HelpAnswerPage({ params }: Params) {
  const { section, answer } = await params;
  const found = helpAnswer(section, answer);
  if (!found) notFound();
  const others = sectionNeighbors(found);
  const links = answerLinks(found.id);
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink print:bg-white">
      {/* Printed, the answer stands alone: no menus, no footer, no list of other answers (564 [HC1]). */}
      <div className="print:hidden">
        <SiteNav />
      </div>
      {/* The topics sit beside the page, outside its main region, so "Skip to content" lands on the page itself (review of #4191). */}
      <div className="container-page grid flex-1 gap-8 py-12 sm:py-16 lg:grid-cols-[15rem_1fr] lg:gap-14">
        <aside className="min-w-0 print:hidden lg:sticky lg:top-24 lg:self-start">
          <HelpTopics topics={helpTopics()} current={helpAnswerPath(found.section.id, found.id)} />
        </aside>
        <main id="content" className="min-w-0">
        <Breadcrumb path={[{ label: "Help center", href: "/help" }, { label: found.section.title, href: `/help/${found.section.id}` }]} here={found.q} />
        <article className="mt-4 max-w-3xl">
          <h1 className="t-h2">{found.q}</h1>
          {HELP_DATES[found.id] ? (
            <p className="mt-3 text-sm text-ink-soft" data-help-dates>
              {"Added "}
              <time dateTime={HELP_DATES[found.id].created}>{helpDay(HELP_DATES[found.id].created)}</time>
              {/* Always said, as HC1's complement asks: for an answer never changed since, the day it was added. */}
              {" · Last updated "}
              <time dateTime={HELP_DATES[found.id].updated}>{helpDay(HELP_DATES[found.id].updated)}</time>
            </p>
          ) : null}
          <div className="mt-6 space-y-4" data-help-answer>
            {found.a.map((paragraph) => (
              <p key={paragraph} className="max-w-[80ch] leading-relaxed text-ink-soft">
                {paragraph}
              </p>
            ))}
          </div>
          <HelpAnswerTools />
        </article>
        {/* Where the task is done and read about (564 [HC1], item 3), only for an answer that is a studio area's main one. */}
        {links.studio.length || links.features.length ? (
          <nav aria-labelledby="help-where-title" className="mt-10 max-w-3xl print:hidden" data-help-where>
            <h2 id="help-where-title" className="t-section">Where to do it</h2>
            <ul className="mt-4 space-y-1">
              {[...links.studio, ...links.features].map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
            {links.studio.length ? <p className="mt-2 max-w-[80ch] text-sm text-ink-soft">The studio asks you to sign in first.</p> : null}
          </nav>
        ) : null}
        {others.length ? (
          <nav aria-labelledby="help-more-title" className="mt-12 max-w-3xl print:hidden">
            <h2 id="help-more-title" className="t-section">{`More in ${found.section.title}`}</h2>
            <ul className="mt-4 space-y-1">
              {others.map((item) => (
                <li key={item.id}>
                  <Link href={helpAnswerPath(found.section.id, item.id)} className="inline-flex min-h-11 items-center text-ink underline underline-offset-4 hover:text-violet-deep">
                    {item.q}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <p className="mt-10 print:hidden">
          <Link href="/help" className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4">
            Search all of the help center
          </Link>
        </p>
        </main>
      </div>
      <div className="print:hidden">
        <SiteFooter />
      </div>
    </div>
  );
}
