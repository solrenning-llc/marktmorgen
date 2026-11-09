import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { CREATOR, readMembers } from "@/lib/community";
import { communityVisitor } from "@/lib/community-page";
import { type Conversation, inbox } from "@/lib/community-dm";
import { aliasOf } from "@/lib/community-alias";
import { CommunityBar, Face, authorName, communityNotices, storeWhen } from "@/components/community-parts";
import { communityWords } from "@/lib/buyer-words/community";
import { LANGUAGES } from "@/lib/store-language";
import { EmptyState } from "@/components/empty-state";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${communityWords(store?.language).tabMessages} — Marktmorgen`, robots: { index: false, follow: false } };
}

/**
 * Somebody's own messages: the conversations they are in, and the requests
 * waiting on them.
 *
 * The two lists are apart on purpose. A request is not a conversation yet —
 * it is a stranger asking for one — and mixing them would give an unwanted
 * message the same place in somebody's day as a wanted one. That separation
 * is the whole point of the queue.
 */
export default async function MessagesPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const viewer = await communityVisitor(store, await cookies());
  if (viewer.state === "off" || !store.community) redirect(`/@${store.handle}`);
  const home = `/@${store.handle}/community`;
  if (viewer.state !== "in") redirect(home);
  const { config, owner, key } = viewer;
  if (!config.dm.on) redirect(`${home}?n=dmoff`);

  const id = store.community.id;
  const query = await searchParams;
  const w = communityWords(store.language);
  const notice = communityNotices(store.language)[typeof query.n === "string" ? query.n : ""] ?? null;
  const [talks, asks] = await Promise.all([inbox(id, key), inbox(id, key, true)]);
  const people = [...talks, ...asks].map((c) => c.other).filter((who) => who !== CREATOR);
  const members = await readMembers(id, people);
  const nameOf = (who: string) => authorName(store, who, members);

  const list = (rows: Conversation[], request: boolean) => (
    <ul className="mt-3 space-y-2">
      {rows.map((c) => (
        // The other person by their alias, never their key (lib/community-alias.ts, audit N2).
        <li key={aliasOf(id, c.other)}>
          <Link href={`${home}/messages/${aliasOf(id, c.other)}`} className="cm-dm-row">
            <Face store={store} author={aliasOf(id, c.other)} name={nameOf(c.other)} size={40} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2">
                <span className="truncate font-bold">{nameOf(c.other)}</span>
                {c.unread ? <span className="cm-badge cm-badge-accent">{w.newBadge}</span> : null}
              </span>
              <span className="st-muted block truncate text-sm">
                {c.last ? `${c.last.a === key ? w.youColon : ""}${c.last.text}` : w.noMessages}
              </span>
            </span>
            <time className="st-muted shrink-0 text-xs font-semibold" dateTime={new Date(c.at * 1000).toISOString()}>
              {storeWhen(store, c.at)}
            </time>
          </Link>
          {request ? (
            <div className="mt-1 flex flex-wrap gap-2 px-1">
              <form action="/api/store/community/messages" method="post">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="action" value="accept" />
                <input type="hidden" name="with" value={aliasOf(id, c.other)} />
                <button type="submit" className="cm-pill">{w.accept}</button>
              </form>
              <form action="/api/store/community/messages" method="post">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="action" value="decline" />
                <input type="hidden" name="with" value={aliasOf(id, c.other)} />
                <button type="submit" className="cm-quiet-link cm-mini cm-danger text-xs font-semibold">
                  {w.declineForGood}
                </button>
              </form>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <div lang={LANGUAGES[store.language].locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <CommunityBar store={store} config={config} tab="messages" signedIn messages={config.dm.on} />
      <main id="content" className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        <p className="mb-4">
          <Link href={home} className="cm-quiet-link text-sm font-semibold underline underline-offset-4">{w.backToFeed}</Link>
        </p>
        {notice ? <p className={`cm-flash mb-5 ${notice.tone === "warn" ? "cm-flash-warn" : ""}`} role="status">{notice.text}</p> : null}

        <h1 className="font-display text-2xl font-semibold tracking-[-0.02em]">{w.tabMessages}</h1>
        <p className="st-muted mt-1 text-sm">
          {owner
            ? w.dmOwnerNote
            : w.dmMemberNote(store.name)}
        </p>

        {asks.length ? (
          <section aria-labelledby="asks-title" className="mt-7">
            <h2 id="asks-title" className="text-lg font-semibold">
              {w.wantToMessage(asks.length)}
            </h2>
            <p className="st-muted mt-1 text-sm">
              {w.requestsNote}
            </p>
            {list(asks, true)}
          </section>
        ) : null}

        <section aria-labelledby="talks-title" className="mt-7">
          <h2 id="talks-title" className="text-lg font-semibold">{w.yourConversations}</h2>
          {talks.length === 0 ? (
            <EmptyState
              level={3}
              title={w.nothingHereYet}
              body={owner ? w.openMemberName : config.dm.between ? w.openSomebodyName : w.onlyStoreWritten(store.name)}
              className="mt-3"
            />
          ) : (
            list(talks, false)
          )}
        </section>
      </main>
    </div>
  );
}
