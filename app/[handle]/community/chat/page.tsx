import type { Metadata } from "next";
import { aliasKeyed, aliasOf, withAliases } from "@/lib/community-alias";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { CREATOR, readMembers } from "@/lib/community";
import { communityVisitor } from "@/lib/community-page";
import { quietFor, room } from "@/lib/community-chat";
import { grantRoom } from "@/lib/chat-grant";
import { isTalking } from "@/lib/chat-pace";
import { requestCount } from "@/lib/community-dm";
import { unreadCount } from "@/lib/community-notify";
import { CommunityBar } from "@/components/community-parts";
import { CommunityRoom } from "@/components/community-room";
import { communityWords, roomWords } from "@/lib/buyer-words/community";
import { LANGUAGES } from "@/lib/store-language";
import { AWAY_AFTER_MS, IDLE_MS, LIVE_MS } from "@/lib/chat-pace";

type Params = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${communityWords(store?.language).tabRoom} — Marktmorgen`, robots: { index: false, follow: false } };
}

/**
 * The room: where a community talks at the speed people talk.
 *
 * The first page of it is drawn on the server, so somebody arriving reads
 * immediately rather than watching a box fill. Everything after that the page
 * asks for itself.
 */
export default async function CommunityChatPage({ params }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const viewer = await communityVisitor(store, await cookies());
  if (viewer.state === "off" || !store.community) redirect(`/@${store.handle}`);
  const home = `/@${store.handle}/community`;
  if (viewer.state !== "in") redirect(home);
  const { config, owner, key, canWrite } = viewer;
  if (!config.chat.on) redirect(`${home}?n=chatoff`);

  const id = store.community.id;
  const w = communityWords(store.language);
  const locale = LANGUAGES[store.language].locale;
  const page = await room(id);
  const members = await readMembers(id, page.messages.map((m) => m.a).filter((a) => a !== CREATOR));
  const names: Record<string, string> = {};
  for (const message of page.messages) {
    names[message.a] = message.a === CREATOR ? store.name : members.get(message.a)?.n || message.n || w.aMember;
  }
  // Leave for this page to ask what is new for the next ten minutes, counted
  // toward the store's visits (lib/chat-grant.ts): at the pace of a talking
  // room only when this one is.
  const newest = page.messages.length ? page.messages[page.messages.length - 1].at : 0;
  const quiet = quietFor(newest);
  const talking = quiet >= 0 && isTalking(quiet * 1000);
  const given = await grantRoom(store, id, { key, owner }, talking, talking);
  const [waiting, news] = await Promise.all([
    config.dm.on ? requestCount(id, key) : Promise.resolve(0),
    unreadCount(id, key),
  ]);

  return (
    <div lang={locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <CommunityBar store={store} config={config} tab="chat" signedIn messages={config.dm.on} requests={waiting} news={news} room={config.chat.on} />
      <main id="content" className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        <p className="mb-4">
          <Link href={home} className="cm-quiet-link text-sm font-semibold underline underline-offset-4">{w.backToFeed}</Link>
        </p>
        <h1 className="font-display text-2xl font-semibold tracking-[-0.02em]">{w.theRoom}</h1>
        <p className="st-muted mt-1 text-sm">
          {w.roomIntro}
        </p>

        <CommunityRoom
          handle={store.handle}
          room={id}
          creator={CREATOR}
          creatorName={store.name}
          leave={given === "resting" ? null : given}
          resting={given === "resting"}
          quiet={quiet}
          first={withAliases(id, page.messages)}
          names={aliasKeyed(id, names)}
          cursor={page.cursor}
          me={aliasOf(id, key)}
          canWrite={canWrite || owner}
          owner={owner}
          creatorOnly={config.chat.creatorOnly}
          slow={config.chat.slow}
          links={config.chat.links}
          words={roomWords(store.language, locale, { live: LIVE_MS / 1000, idle: IDLE_MS / 1000, away: AWAY_AFTER_MS / 60_000, kept: 500 })}
        />
      </main>
    </div>
  );
}
