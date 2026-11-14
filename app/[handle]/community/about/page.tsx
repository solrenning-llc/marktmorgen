import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { storeRoot } from "@/lib/store-sitemap";
import { speech } from "@/lib/buyer-words";
import { communityWords } from "@/lib/buyer-words/community";
import { aboutPage, aboutWords } from "@/lib/community-about";
import { StoreResting } from "@/components/store-resting";
import { PostText } from "@/components/community-parts";

type Params = { params: Promise<{ handle: string }> };

/**
 * One answer for the head and the page: the page is counted once (lib/community-about.ts).
 */
const load = cache(async (raw: string) => {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const store = await storeForPage(normaliseHandle(decoded)).catch(() => null);
  if (!store) return null;
  return { store, answer: await aboutPage(store) };
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const found = await load((await params).handle);
  if (!found || found.answer.state !== "shown") return { title: "Not found — Marktmorgen", robots: { index: false, follow: false } };
  const { store, answer } = found;
  const w = aboutWords(store.language);
  const description = answer.page.about.trim().slice(0, 300) || w.meta(answer.page.name, store.name);
  const url = `${storeRoot(store)}/community/about`;
  return {
    title: `${answer.page.name} — ${w.label}`,
    description,
    alternates: { canonical: url },
    openGraph: { title: answer.page.name, description, url, type: "website" },
  };
}

/**
 * A community's public About page (233 [SK1]): off until the creator turns
 * it on in the studio, and then only what somebody not in yet may know —
 * the creator's description, the ways in on sale now with their published
 * prices, and, where the creator chose, how many have joined and how many
 * posts the last 30 days had. Nothing a member wrote and nobody's name.
 */
export default async function CommunityAboutPage({ params }: Params) {
  const found = await load((await params).handle);
  if (!found || found.answer.state === "none") notFound();
  const { store, answer } = found;
  if (answer.state === "resting") return <StoreResting store={store} />;
  const { page } = answer;
  const say = speech(store);
  const w = aboutWords(store.language);
  const cw = communityWords(store.language);
  const home = `/@${store.handle}/community`;
  const joined = page.counts?.joined ?? null;
  const posts = page.counts?.posts ?? null;
  const counted = joined !== null || posts !== null;

  return (
    <div lang={say.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="mx-auto max-w-2xl px-4 pb-16 pt-10 sm:pt-14">
        <nav aria-label={w.label} className="text-sm">
          <ol className="flex flex-wrap items-center gap-x-2">
            <li>
              <Link href={`/@${store.handle}`} className="st-footer-link font-semibold">{store.name}</Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <span aria-current="page">{w.label}</span>
            </li>
          </ol>
        </nav>

        <div className="st-card mt-6 p-6 sm:p-8">
          <p className="st-label">{w.label}</p>
          <h1 className="font-display mt-1 text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">{page.name}</h1>
          <p className="st-muted mt-1 text-sm">{w.byline(store.name)}</p>
          {page.about ? <PostText text={page.about} className="mt-4 leading-relaxed" /> : null}
          <p className="st-muted mt-4 text-sm">{w.membersOnly}</p>
        </div>

        {counted ? (
          <section aria-labelledby="about-activity" className="st-card mt-6 p-6 sm:p-8">
            <h2 id="about-activity" className="font-display text-xl font-semibold">{w.activity}</h2>
            <ul className="mt-3 space-y-1">
              {joined !== null ? <li>{w.joined(joined, say.num)}</li> : null}
              {posts !== null ? <li>{w.posts(posts.n, posts.atLeast, say.num)}</li> : null}
            </ul>
            <p className="st-muted mt-3 text-sm">{w.counted}</p>
          </section>
        ) : null}

        <section aria-labelledby="about-join" className="st-card mt-6 p-6 sm:p-8">
          <h2 id="about-join" className="font-display text-xl font-semibold">{w.join}</h2>
          {page.ways.length ? (
            <ul className="mt-3 space-y-2">
              {page.ways.map((way) => (
                <li key={way.id}>
                  <Link href={way.href} className="cm-row">
                    <span className="min-w-0">
                      <span className="block break-words font-semibold">{way.title}</span>
                      <span className="st-muted block text-sm">{w.opens(way.spaces, page.spaces)}</span>
                    </span>
                    <span className="st-muted shrink-0 text-sm">{way.kind}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="st-muted mt-3">{w.noneNow}</p>
          )}
          <p className="mt-5 text-sm">
            {cw.alreadyMember}{" "}
            <Link href={home} className="font-semibold underline underline-offset-4">{w.open}</Link>
          </p>
        </section>
      </main>
    </div>
  );
}
