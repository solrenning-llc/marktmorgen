import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { feed, postNumbers, readMembers, readPosts } from "@/lib/community";
import { accessProducts, visibleSpaces } from "@/lib/community-access";
import { lockedSpaces } from "@/lib/community-locked";
import { takePublicRequest } from "@/lib/traffic";
import { LockedSpaces } from "@/components/community-locked";
import { communityVisitor } from "@/lib/community-page";
import { requestCount } from "@/lib/community-dm";
import { unreadCount } from "@/lib/community-notify";
import { pollViews } from "@/lib/community-polls";
import { communityFolder } from "@/lib/community-image";
import { announcementReach, canAnnounceByEmail } from "@/lib/community-mail";
import { ITEM_ID } from "@/lib/community-text";
import { levelOf, pointsOf } from "@/lib/community-points";
import {
  CommunityBar,
  Gate,
  PostCard,
  communityNotices,
  linkNotices,
  ticketKind,
} from "@/components/community-parts";
import { communityWords, composerWords } from "@/lib/buyer-words/community";
import { MAX_POLL_OPTIONS } from "@/lib/community-polls";
import { LANGUAGES } from "@/lib/store-language";
import { CommunityComposer, ConfirmDeletes } from "@/components/community-composer";
import { EmptyState } from "@/components/empty-state";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${communityWords(store?.language).pageTitle} — Marktmorgen`, robots: { index: false, follow: false } };
}

/** The community's feed: every space, or one, newest first, a page at a time. */
export default async function CommunityPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const viewer = await communityVisitor(store, await cookies());
  if (viewer.state === "off" || !store.community) redirect(`/@${store.handle}`);
  const id = store.community.id;
  const query = await searchParams;
  const word = typeof query.n === "string" ? query.n : "";
  const w = communityWords(store.language);
  const lang = LANGUAGES[store.language].locale;
  const notices = communityNotices(store.language);
  const notice = notices[word] ?? null;

  if (viewer.state !== "in") {
    const products = (await accessProducts(store, viewer.config)).map((p) => ({ id: p.id, title: p.title, kind: ticketKind(store, p) }));
    return (
      <div lang={lang} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
        <CommunityBar store={store} config={viewer.config} tab={null} signedIn={false} />
        <main id="content" className="px-4 pb-16">
          <Gate
            store={store}
            config={viewer.config}
            state={viewer.state}
            email={viewer.state === "out" ? null : viewer.email}
            products={products}
            link={linkNotices(store.language)[typeof query.link === "string" ? query.link : ""] ?? (word === "out" ? w.sessionEnded : null)}
          />
        </main>
      </div>
    );
  }

  const { config, owner, key, canWrite, member } = viewer;
  // Spaces kept for the buyers of some products are not in this list for
  // anybody else, and neither are their posts: the gate is asked here, once,
  // and everything below reads only what came back.
  const spaces = await visibleSpaces(store, config, { owner, email: viewer.email });
  const mineIds = new Set(spaces.map((s) => s.id));
  const askedSpace = typeof query.space === "string" && ITEM_ID.test(query.space) ? query.space : "";
  // A space they may not see answers the same as one that is not there.
  if (askedSpace && !mineIds.has(askedSpace)) redirect(`${`/@${store.handle}/community`}?n=spacelocked`);
  const space = askedSpace ? spaces.find((s) => s.id === askedSpace) ?? null : null;
  const beforeRaw = typeof query.before === "string" ? Number(query.before) : NaN;
  const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
  const page = await feed(id, { space: space?.id ?? null, before, withHidden: owner });
  // The Start here post and the pinned ones lead the first page of the whole feed.
  const topIds = !space && !before ? [...new Set([config.start, ...config.pinned].filter((p): p is string => Boolean(p)))] : [];
  const topFound = topIds.length ? await readPosts(id, topIds) : [];
  // The spaces this viewer is gated out of. A post in a space that no longer
  // exists is not one of them, and stays where it always was.
  const shut = new Set(config.spaces.filter((s) => s.only.length && !mineIds.has(s.id)).map((s) => s.id));
  const open = (p: { sp: string }) => !shut.has(p.sp);
  const top = topIds
    .map((t) => topFound.find((p) => p.id === t))
    .filter((p): p is NonNullable<typeof p> => Boolean(p && (owner || !p.hid) && open(p)));
  const stream = page.posts.filter((p) => !topIds.includes(p.id) && open(p));
  const shown = [...top, ...stream];
  const [members, numbers, polls, points] = await Promise.all([
    readMembers(id, shown.map((p) => p.a)),
    postNumbers(id, shown, key),
    pollViews(id, shown, key, owner),
    pointsOf(id, [...shown.map((p) => p.a), key]),
  ]);
  // Each author's level, and this member's own, for the spaces that open at one.
  const levels = new Map([...points].map(([k, n]) => [k, levelOf(n)]));
  const myLevel = levels.get(key) ?? 1;
  const locked = (s: { level: number }) => !owner && s.level >= 2 && myLevel < s.level;
  const reach = owner ? await announcementReach(id) : 0;
  // The badge on the Messages link: nothing to read, nothing shown.
  const waiting = config.dm.on ? await requestCount(id, key) : 0;
  const news = await unreadCount(id, key);
  const home = `/@${store.handle}/community`;
  const from = space ? "space" : "feed";
  const openTo = await accessProducts(store, config);
  // The kept spaces shown locked that this member was not let into (542 [CM1]): their names, lines and the way in,
  // on the first page of every space only, with what they read paid for first; nothing from inside them is read.
  const lockedList = !owner && !space && !before ? await lockedSpaces(store, config, mineIds, (units) => takePublicRequest(store, "buyer", undefined, units)) : [];
  if (lockedList === null) redirect(`/@${store.handle}/resting`);

  return (
    <div lang={lang} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <ConfirmDeletes />
      <CommunityBar store={store} config={config} tab="feed" signedIn messages={config.dm.on} requests={waiting} news={news} room={config.chat.on} />
      <main id="content" className="mx-auto grid max-w-5xl gap-x-8 px-4 pb-16 pt-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <nav aria-label={w.spaces} className="sticky top-24">
            <p className="st-label px-3 text-xs uppercase tracking-[0.08em]">{w.spaces}</p>
            <ul className="mt-2 space-y-0.5">
              <li>
                <Link href={home} aria-current={!space ? "page" : undefined} className="cm-side">{w.allPosts}</Link>
              </li>
              {spaces.map((s) => (
                <li key={s.id}>
                  <Link href={`${home}?space=${s.id}`} aria-current={space?.id === s.id ? "page" : undefined} className="cm-side">
                    <span className="min-w-0 truncate">{s.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <div className="min-w-0">
          <nav aria-label={w.spaces} className="cm-chips -mx-4 mb-5 px-4 lg:hidden">
            <ul className="flex gap-2">
              <li className="shrink-0">
                <Link href={home} aria-current={!space ? "page" : undefined} className="cm-chip">{w.allPosts}</Link>
              </li>
              {spaces.map((s) => (
                <li key={s.id} className="shrink-0">
                  <Link href={`${home}?space=${s.id}`} aria-current={space?.id === s.id ? "page" : undefined} className="cm-chip">{s.name}</Link>
                </li>
              ))}
            </ul>
          </nav>

          {notice ? (
            <p className={`cm-flash mb-5 ${notice.tone === "warn" ? "cm-flash-warn" : ""}`} role="status">{notice.text}</p>
          ) : null}

          {owner && !store.community.on ? (
            <div className="st-note mb-5 text-sm" role="status">
              <strong>{w.switchedOff}</strong> {w.switchedOffHow}{" "}
              <Link href="/studio/community" className="font-semibold underline underline-offset-4">{w.studio}</Link>.
            </div>
          ) : null}
          {owner && openTo.length === 0 ? (
            <div className="st-note mb-5 text-sm" role="status">
              <strong>{w.nobodyYet}</strong> {w.nobodyYetHow}{" "}
              <Link href="/studio/community" className="font-semibold underline underline-offset-4">{w.studio}</Link>.
            </div>
          ) : null}
          {member?.muted ? <p className="cm-flash cm-flash-warn mb-5">{notices.muted.text}</p> : null}
          {member && !member.muted && (!member.n || (config.questions.length > 0 && !member.qa)) ? (
            <div className="st-note mb-5 text-sm" role="status">
              <strong>{w.welcome(config.name)}</strong>{" "}
              {!member.n && config.questions.length && !member.qa
                ? w.welcomeNameAndQuestions(store.name, config.questions.length)
                : !member.n
                  ? w.welcomeName
                  : w.welcomeQuestions(store.name, config.questions.length)}
              <Link href={`${home}/you`} className="font-semibold underline underline-offset-4">{w.takesAMinute}</Link>
            </div>
          ) : null}

          {space ? (
            <div className="mb-5">
              <h1 className="font-display text-2xl font-semibold tracking-[-0.02em]">{space.name}</h1>
              {space.about ? <p className="st-muted mt-1">{space.about}</p> : null}
              {space.creatorOnly ? <p className="st-muted mt-1 text-sm">{w.onlyCreatorStarts(store.name)}</p> : null}
              {!space.creatorOnly && space.level >= 2 ? (
                <p className="st-muted mt-1 text-sm">
                  {locked(space) ? w.spaceLevelYours(space.level, myLevel) : w.spaceLevel(space.level)}
                  <Link href={`${home}/leaderboard`} className="font-semibold underline underline-offset-4">{w.howLevelsWork}</Link>
                </p>
              ) : null}
            </div>
          ) : (
            <h1 className="sr-only">{config.name}</h1>
          )}

          {canWrite && !before && !(space && locked(space)) ? (
            <div className="mb-6">
              <CommunityComposer
                key={space?.id ?? "all"}
                handle={store.handle}
                folder={communityFolder(id)}
                spaces={spaces.map((s) => ({ id: s.id, name: s.name, creatorOnly: s.creatorOnly, locked: locked(s) }))}
                current={space?.id ?? null}
                owner={owner}
                from={from}
                canEmail={owner && canAnnounceByEmail(store)}
                reach={reach}
                named={Boolean(member?.n)}
                words={composerWords(store.language, MAX_POLL_OPTIONS, reach)}
              />
            </div>
          ) : null}

          <LockedSpaces spaces={lockedList} language={store.language} />

          {shown.length === 0 ? (
            <EmptyState
              title={before ? w.nothingOlder : w.noPostsYet}
              body={before ? w.thatIsEverything : canWrite && !(space && locked(space)) ? w.beTheFirst : w.whenSomebodyPosts}
            />
          ) : (
            <ul className="space-y-4">
              {shown.map((post) => (
                <li key={post.id}>
                  <PostCard
                    store={store}
                    post={post}
                    config={config}
                    members={members}
                    numbers={numbers.get(post.id)}
                    poll={polls.get(post.id)}
                    viewer={{ key, owner, canWrite }}
                    from={from}
                    space={space?.id ?? null}
                    levels={levels}
                  />
                </li>
              ))}
            </ul>
          )}

          {page.next ? (
            <p className="mt-6 text-center">
              <Link href={`${home}?${space ? `space=${space.id}&` : ""}before=${page.next}`} className="cm-pill cm-pill-wide">
                {w.olderPosts}
              </Link>
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
