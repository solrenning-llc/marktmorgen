import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
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
import { LinkRequestForm } from "@/components/link-request-form";
import { bodyHtml } from "@/lib/mail-body";
import { readLetter } from "@/lib/letters";
import { membersOnly } from "@/lib/letter-rules";
import { letterReader } from "@/lib/letter-access";
import { readListings } from "@/lib/catalog";
import { productSegment } from "@/lib/product-slug";

type Params = {
  params: Promise<{ handle: string; letter: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

const load = cache(async (raw: string, id: string) => {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store || store.suspended) return null;
  const letter = await readLetter(store, id);
  return letter ? { store, letter } : null;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, letter: id } = await params;
  const found = await load(handle, id);
  if (!found) return { title: "Not found — Marktmorgen" };
  const { store, letter } = found;
  // Only the subject, never the words: an email kept for members is not offered to search engines either.
  return {
    title: `${letter.subject} — ${store.name}`,
    alternates: { canonical: `${storeRoot(store)}/letters/${letter.id}` },
    ...(membersOnly(letter) ? { robots: { index: false, follow: true } } : {}),
  };
}

/**
 * One email a store published (lib/letter-rules.ts): its subject and words
 * as they were sent, drawn the way the email drew them, with its links as
 * the creator typed them. An email kept for members shows its words only to
 * the creator and to a proved address that holds one of its products now
 * (lib/letter-access.ts); everyone else sees its subject, who it is for and
 * a way to prove their address.
 */
export default async function LetterPage({ params, searchParams }: Params) {
  const { handle, letter: id } = await params;
  const found = await load(handle, id);
  if (!found) notFound();
  const { store, letter } = found;
  if (await isResting(store)) return <StoreResting store={store} />;
  const say = speech(store);
  const w = letterWords(store.language);
  const date = new Intl.DateTimeFormat(say.lang.locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const sent = new Date(letter.sentAt);
  const kept = membersOnly(letter);
  const reader = kept ? await letterReader(store, letter, await cookies()) : ({ state: "public" } as const);
  const readable = reader.state === "public" || reader.state === "owner" || reader.state === "in";
  const products = kept ? await readListings(store, letter.products) : [];
  const query = kept ? await searchParams : {};
  const linkState = typeof query.link === "string" ? query.link : "";
  const notice = kept && !readable ? w.linkNotices[linkState] : undefined;
  return (
    <div lang={say.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-2xl px-4 pb-16 pt-10 sm:pt-14">
        <article>
          <p className="st-muted text-sm">
            <time dateTime={sent.toISOString()}>{w.sentOn(date.format(sent))}</time>
            {` · ${store.name}`}
            {kept ? ` · ${w.membersLabel}` : null}
          </p>
          <h1 className="font-display mt-2 text-3xl font-semibold leading-tight sm:text-4xl [overflow-wrap:anywhere]">{letter.subject}</h1>
          {kept ? (
            <section aria-labelledby="letter-for" className="mt-6">
              <h2 id="letter-for" className="text-sm font-semibold">{readable ? w.forHolders : w.lockedLead}</h2>
              {reader.state === "owner" ? <p className="st-muted mt-1 text-sm">{products.length ? w.ownerNote : w.noneLeft}</p> : null}
              <ul className="mt-2 space-y-1">
                {products.map((p) => (
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
            /* The email's own drawing (lib/mail-body.ts): every word escaped, only its headings, lists, links, buttons and pictures. */
            <div className="mt-6 rounded-2xl bg-white p-6 text-[15px] leading-relaxed text-stone-900 [overflow-wrap:anywhere] sm:p-8" dangerouslySetInnerHTML={{ __html: bodyHtml(letter.body, undefined, store.look.accent) }} />
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
                <p className="font-bold" style={{ color: "var(--st-text)" }}>{w.closedTitle}</p>
                <p className="mt-1 text-sm">{w.closedBody(reader.email)}</p>
              </div>
            ) : null}
            <LinkRequestForm
              action="/api/store/letters/link"
              hidden={{ handle: store.handle, letter: letter.id }}
              id="letter-email"
              label={w.linkLabel}
              explain={w.linkExplain}
              button={w.sendLink}
              placeholder={say.w.emailPlaceholder}
              language={store.language}
            />
          </>
        ) : null}
        <div className="mt-12 flex flex-wrap justify-center gap-x-6 gap-y-2">
          <Link href={`/@${store.handle}/letters`} className="st-footer-link text-sm font-semibold">
            {w.all}
          </Link>
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {w.visit(store.name)}
          </Link>
        </div>
        <StoreTracking store={store} presence />
      </main>
    </div>
  );
}
