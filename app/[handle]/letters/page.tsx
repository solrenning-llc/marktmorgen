import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { storeRoot } from "@/lib/store-sitemap";
import { speech } from "@/lib/buyer-words";
import { letterWords } from "@/lib/buyer-words/letters";
import { lookStyle } from "@/lib/store-look";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";
import { StoreTracking } from "@/components/store-tracking";
import { listLetters } from "@/lib/letters";
import { membersOnly } from "@/lib/letter-rules";

type Params = { params: Promise<{ handle: string }> };

const load = cache(async (raw: string) => {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const store = await storeForPage(normaliseHandle(decoded));
  return store && !store.suspended ? store : null;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const store = await load((await params).handle);
  if (!store) return { title: "Not found — Marktmorgen" };
  const w = letterWords(store.language);
  return { title: w.listTitle(store.name), description: w.listLead(store.name), alternates: { canonical: `${storeRoot(store)}/letters` } };
}

/**
 * The emails a store chose to publish (lib/letter-rules.ts), newest first.
 * Shown only to those who open the address; nothing is published by itself.
 * Only subjects and dates: an email kept for members says so here, and its
 * words stay on its own page, behind its door (lib/letter-access.ts).
 */
export default async function LettersPage({ params }: Params) {
  const store = await load((await params).handle);
  if (!store) notFound();
  if (await isResting(store)) return <StoreResting store={store} />;
  const letters = await listLetters(store);
  const say = speech(store);
  const w = letterWords(store.language);
  const date = new Intl.DateTimeFormat(say.lang.locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return (
    <div lang={say.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-2xl px-4 pb-16 pt-10 sm:pt-14">
        <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{w.listTitle(store.name)}</h1>
        <p className="st-muted mt-3">{w.listLead(store.name)}</p>
        {letters === null ? (
          <p role="status" className="st-note mt-8">{w.unread}</p>
        ) : letters.length === 0 ? (
          <EmptyState title={w.emptyTitle} body={w.empty} action={{ href: `/@${store.handle}`, label: w.visit(store.name) }} className="mt-8" />
        ) : null}
        <ul className="mt-8 space-y-3">
          {(letters ?? []).map((letter) => (
            <li key={letter.id} className="st-card p-5">
              <Link href={`/@${store.handle}/letters/${letter.id}`} className="font-semibold [overflow-wrap:anywhere]">
                {letter.subject}
              </Link>
              <p className="st-muted mt-1 text-sm">
                <time dateTime={new Date(letter.sentAt).toISOString()}>{w.sentOn(date.format(new Date(letter.sentAt)))}</time>
                {membersOnly(letter) ? ` · ${w.membersLabel}` : null}
              </p>
            </li>
          ))}
        </ul>
        <div className="mt-12 flex justify-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {w.visit(store.name)}
          </Link>
        </div>
        <StoreTracking store={store} presence />
      </main>
    </div>
  );
}
