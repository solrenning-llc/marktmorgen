import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { communityVisitor } from "@/lib/community-page";
import { CommunityBar } from "@/components/community-parts";
import { LANGUAGES } from "@/lib/store-language";
import { EmptyState } from "@/components/empty-state";
import { type ChallengeNotice, challengeWords } from "@/lib/buyer-words/challenges";
import { challengeClock, challengeCounts, keptChallenges, memberProgress } from "@/lib/community-challenges";
import { ChallengeCard } from "@/components/community-challenges";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${challengeWords(store?.language).title} — Marktmorgen`, robots: { index: false, follow: false } };
}

/**
 * The community's challenges (lib/community-challenges.ts): the ones on now
 * and coming up, then the ones over for less than their keep. A member sees
 * their own check-ins and streak and joins or checks in with a plain form;
 * the creator sees the counts, and starts one in the studio.
 */
export default async function CommunityChallengesPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const viewer = await communityVisitor(store, await cookies());
  if (viewer.state === "off" || !store.community) redirect(`/@${store.handle}`);
  const home = `/@${store.handle}/community`;
  // Not in (any more): the community's own door says why, and how to come in.
  if (viewer.state !== "in") redirect(home);
  const id = store.community.id;
  const w = challengeWords(store.language);
  const locale = LANGUAGES[store.language].locale;
  const query = await searchParams;
  const word = typeof query.n === "string" ? query.n : "";
  const notice = Object.hasOwn(w.notices, word) ? w.notices[word as ChallengeNotice] : null;
  const now = challengeClock();

  const challenges = await keptChallenges(id, now);
  const [progress, counts] = await Promise.all([
    viewer.owner || !challenges.length ? Promise.resolve(null) : memberProgress(id, challenges, viewer.key, now),
    viewer.owner && challenges.length ? challengeCounts(id, challenges, now) : Promise.resolve(null),
  ]);
  const current = challenges.filter((c) => c.end > now);
  const over = challenges.filter((c) => c.end <= now).reverse();
  const card = (c: (typeof challenges)[number], level: 2 | 3) => (
    <li key={c.id}>
      <ChallengeCard
        handle={store.handle}
        language={store.language}
        locale={locale}
        challenge={c}
        level={level}
        now={now}
        owner={viewer.owner}
        progress={progress?.get(c.id) ?? null}
        counts={counts?.get(c.id) ?? null}
      />
    </li>
  );

  return (
    <div lang={locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <CommunityBar store={store} config={viewer.config} tab="challenges" signedIn />
      <main id="content" className="mx-auto max-w-3xl px-4 pb-16 pt-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">{w.title}</h1>
          {viewer.owner ? (
            <Link href={store.sid ? `/studio/community?store=${store.sid}#challenges` : "/studio/community#challenges"} className="cm-pill">{w.startInStudio}</Link>
          ) : null}
        </div>
        <p className="st-muted mt-2 max-w-[70ch] text-sm">{w.intro}</p>
        {notice ? <p className={`cm-flash mt-4 ${notice.tone === "warn" ? "cm-flash-warn" : ""}`} role="status">{notice.text}</p> : null}

        {current.length ? (
          <ul className="mt-6 space-y-4">{current.map((c) => card(c, 2))}</ul>
        ) : (
          <EmptyState level={2} title={w.nothing} body={viewer.owner ? w.nothingOwner : w.nothingMember} className="mt-6" />
        )}
        {over.length ? (
          <section aria-labelledby="ch-over" className="mt-10">
            <h2 id="ch-over" className="st-label text-xs uppercase tracking-[0.08em]">{w.over}</h2>
            <ul className="mt-3 space-y-4">{over.map((c) => card(c, 3))}</ul>
          </section>
        ) : null}
      </main>
    </div>
  );
}
