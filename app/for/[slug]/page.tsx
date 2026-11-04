import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TopicPageView } from "@/components/topic-page";
import { findPage, slugsFor } from "@/lib/site-pages";

const SECTION = "for" as const;

export function generateStaticParams() {
  return slugsFor(SECTION);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = findPage(SECTION, slug);
  if (!page) return {};
  return {
    // The page's own search title and description when it has them (271 [SEO1]), as /proof pages already do.
    title: page.seo?.title ?? `${page.title} ${page.highlight} — Marktmorgen`,
    description: page.seo?.description ?? page.intro,
  };
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = findPage(SECTION, slug);
  if (!page) notFound();
  return <TopicPageView page={page} />;
}
