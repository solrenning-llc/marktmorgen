import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { HelpTopics } from "@/components/help-topics";
import { HELP_SECTIONS, answerId } from "@/lib/help-content";
import { answerSummary, helpAnswerPath, helpSection, helpTopics } from "@/lib/help-pages";

/** One section of the help center on a page of its own (564 [HC1]): its answers, each with its first line and its own page. */
export function generateStaticParams() {
  return HELP_SECTIONS.map((section) => ({ section: section.id }));
}

type Params = { params: Promise<{ section: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const section = helpSection((await params).section);
  if (!section) return {};
  return {
    title: `${section.title} · Help center — Marktmorgen`,
    description: section.blurb,
    alternates: { canonical: `/help/${section.id}` },
  };
}

export default async function HelpSectionPage({ params }: Params) {
  const section = helpSection((await params).section);
  if (!section) notFound();
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />
      <main id="content" className="container-page grid flex-1 gap-8 py-12 sm:py-16 lg:grid-cols-[15rem_1fr] lg:gap-14">
        <aside className="min-w-0 print:hidden lg:sticky lg:top-24 lg:self-start">
          <HelpTopics topics={helpTopics()} />
        </aside>
        <div className="min-w-0">
        <Breadcrumb path={[{ label: "Help center", href: "/help" }]} here={section.title} />
        <h1 className="t-h2 mt-4">{section.title}</h1>
        <p className="t-lead mt-3 max-w-2xl text-ink-soft">{section.blurb}</p>
        <ul className="mt-8 max-w-3xl divide-y divide-line overflow-hidden rounded-[var(--r-lg)] border border-line bg-white" data-help-section-list>
          {section.items.map((item) => (
            <li key={item.q} className="px-5 py-4 sm:px-6">
              <Link href={helpAnswerPath(section.id, answerId(item.q))} className="inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-4 hover:text-violet-deep">
                {item.q}
              </Link>
              <p className="mt-1 max-w-[80ch] text-ink-soft">{answerSummary(item.a)}</p>
            </li>
          ))}
        </ul>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
