import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { OpenLinkTap } from "@/components/open-link-tap";
import { openLinkWords } from "@/lib/buyer-words/open-link";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const decoded = decodeURIComponent((await params).handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return { title: `${openLinkWords(store?.language).title} — Marktmorgen`, robots: { index: false, follow: false } };
}

/**
 * Where the emailed course link lands (MM-SA-41): nothing is spent here, and
 * one tap posts the token to app/api/store/course/open/route.ts.
 */
export default async function CourseOpenPage({ params, searchParams }: Params) {
  const decoded = decodeURIComponent((await params).handle);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  // Not refused for a store switched off after notices (lib/takedown.ts): what a buyer bought stays theirs, and the
  // link opened it before this page existed.
  const token = (await searchParams).token;
  return <OpenLinkTap store={store} token={typeof token === "string" ? token.slice(0, 80) : ""} kind="course" />;
}
