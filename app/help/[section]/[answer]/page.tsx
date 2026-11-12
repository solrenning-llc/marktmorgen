import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { answerSummary, helpAnswer, helpAnswerPath, helpPagePaths, sectionNeighbors } from "@/lib/help-pages";

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
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />
      <main id="content" className="container-page flex-1 py-12 sm:py-16">
        <Breadcrumb path={[{ label: "Help center", href: "/help" }, { label: found.section.title, href: `/help/${found.section.id}` }]} here={found.q} />
        <article className="mt-4 max-w-3xl">
          <h1 className="t-h2">{found.q}</h1>
          <div className="mt-6 space-y-4" data-help-answer>
            {found.a.map((paragraph) => (
              <p key={paragraph} className="max-w-[80ch] leading-relaxed text-ink-soft">
                {paragraph}
              </p>
            ))}
          </div>
        </article>
        {others.length ? (
          <nav aria-labelledby="help-more-title" className="mt-12 max-w-3xl">
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
        <p className="mt-10">
          <Link href="/help" className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4">
            Search all of the help center
          </Link>
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
