import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { readMembers } from "@/lib/community";
import { communityVisitor } from "@/lib/community-page";
import { type Notice, markSeen, noticesFor } from "@/lib/community-notify";
import { requestCount } from "@/lib/community-dm";
import { canPush, deviceCount, publicKey } from "@/lib/community-push";
import { CommunityPushToggle } from "@/components/community-push-toggle";
import { CommunityBar, Face, authorName, storeWhen } from "@/components/community-parts";
import { communityWords } from "@/lib/buyer-words/community";
import { LANGUAGES } from "@/lib/store-language";
import { EmptyState } from "@/components/empty-state";

type Params = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${communityWords(store?.language).whatHappened} — Marktmorgen`, robots: { index: false, follow: false } };
}

/**
 * What happened to this person: somebody answered their post, answered their
 * comment, or named them.
 *
 * Only things that happened to THEM. There is no "new activity in the
 * community" here, because that is not news about anybody, and a list that
 * fills with it is a list people learn to ignore.
 *
 * Opening the page marks it looked at. Somebody who came to read it has read
 * it, and asking them to also press something to say so is a badge that
 * outlives its own truth.
 */
export default async function NotificationsPage({ params }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const viewer = await communityVisitor(store, await cookies());
  if (viewer.state === "off" || !store.community) redirect(`/@${store.handle}`);
  const home = `/@${store.handle}/community`;
  if (viewer.state !== "in") redirect(home);

  const id = store.community.id;
  const { config, key } = viewer;
  const w = communityWords(store.language);
  const WHAT: Record<Notice["kind"], (who: string) => string> = { reply: w.whatReply, answer: w.whatAnswer, mention: w.whatMention };
  const { notices } = await noticesFor(id, key);
  const members = await readMembers(id, notices.map((n) => n.by));
  const waiting = config.dm.on ? await requestCount(id, key) : 0;
  const devices = canPush() ? await deviceCount(id, key) : 0;
  // Read is read. Done after the list is built, so this visit still shows
  // what was new when they arrived.
  await markSeen(id, key, store);

  return (
    <div lang={LANGUAGES[store.language].locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <CommunityBar store={store} config={config} tab={null} signedIn messages={config.dm.on} requests={waiting} />
      <main id="content" className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        <p className="mb-4">
          <Link href={home} className="cm-quiet-link text-sm font-semibold underline underline-offset-4">{w.backToFeed}</Link>
        </p>
        <h1 className="font-display text-2xl font-semibold tracking-[-0.02em]">{w.whatHappened}</h1>
        <p className="st-muted mt-1 text-sm">
          {w.whatHappenedNote}
        </p>

        <CommunityPushToggle handle={store.handle} publicKey={publicKey()} devices={devices} words={w.push} />

        {notices.length === 0 ? (
          <EmptyState
            title={w.nothingYet}
            /* The creator has no member record and no chosen name: their
               handle is @creator, in every community, always. */
            body={viewer.owner ? w.whenNamed("creator") : viewer.member?.h ? w.whenNamed(viewer.member.h) : w.chooseNameToBeNamed}
            className="mt-6"
          />
        ) : (
          <ul className="mt-6 space-y-2">
            {notices.map((notice, i) => {
              const who = authorName(store, notice.by, members);
              const link = notice.comment
                ? `${home}/post/${notice.post}#comment-${notice.comment}`
                : `${home}/post/${notice.post}`;
              return (
                <li key={`${notice.at}-${i}`}>
                  <Link href={link} className="cm-dm-row">
                    <Face store={store} author={notice.by} name={who} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold">{WHAT[notice.kind](who)}</span>
                      {notice.words ? <span className="st-muted block truncate text-sm">{notice.words}</span> : null}
                    </span>
                    <time className="st-muted shrink-0 text-xs font-semibold" dateTime={new Date(notice.at * 1000).toISOString()}>
                      {storeWhen(store, notice.at)}
                    </time>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
