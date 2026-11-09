import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { CREATOR, memberNames } from "@/lib/community";
import { communityVisitor } from "@/lib/community-page";
import { MAX_MESSAGE_TEXT, mayMessage, otherIn, thread } from "@/lib/community-dm";
import { CommunityBar, Face, PostText, authorName, communityNotices, storeWhen } from "@/components/community-parts";
import { communityWords } from "@/lib/buyer-words/community";
import { LANGUAGES } from "@/lib/store-language";
import { EmptyState } from "@/components/empty-state";
import { NamesUnread } from "@/components/community-names-unread";

type Params = {
  params: Promise<{ handle: string; pair: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${communityWords(store?.language).messageLink} — Marktmorgen`, robots: { index: false, follow: false } };
}

const PAIR = /^(creator|[0-9a-f]{12,64})\.(creator|[0-9a-f]{12,64})$/;

/**
 * One conversation.
 *
 * Reachable only by somebody in it: the address carries both people, and a
 * viewer who is not one of them is answered exactly as they would be for a
 * conversation that does not exist. There is no moderator's view of this page
 * and no way to build one from here.
 */
export default async function MessageThreadPage({ params, searchParams }: Params) {
  const { handle: raw, pair } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const viewer = await communityVisitor(store, await cookies());
  if (viewer.state === "off" || !store.community) redirect(`/@${store.handle}`);
  const home = `/@${store.handle}/community`;
  const box = `${home}/messages`;
  if (viewer.state !== "in") redirect(home);
  const { config, owner, key, canWrite } = viewer;
  if (!config.dm.on) redirect(`${home}?n=dmoff`);
  if (!PAIR.test(pair)) redirect(`${box}?n=gone`);

  const other = otherIn(pair, key);
  if (!other) redirect(`${box}?n=gone`);
  const id = store.community.id;
  // No messages yet is not a missing conversation: it is one about to start,
  // opened from somebody's name in the members list. It is only refused when
  // these two may not write to each other at all.
  const talk = (await thread(id, key, pair)) ?? { messages: [], pending: false };

  const query = await searchParams;
  const w = communityWords(store.language);
  const NOTICES = communityNotices(store.language);
  const notice = NOTICES[typeof query.n === "string" ? query.n : ""] ?? null;
  // A name that could not be read (rules 24 and 30) shows as "A member", and the page says so.
  const { members, unread: namesUnread } = other === CREATOR ? { members: new Map(), unread: false } : await memberNames(id, [other]);
  const name = authorName(store, other, members);
  const refused = mayMessage(config.dm, key, other);
  if (refused && talk.messages.length === 0) redirect(`${box}?n=${refused.reason === "between" ? "dmbetween" : "dmoff"}`);
  // A pending request is read, and answered, but not written into: accepting
  // is the answer, and a reply before that would make the queue pointless.
  const canSend = !talk.pending && !refused && (owner || canWrite);

  return (
    <div lang={LANGUAGES[store.language].locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <CommunityBar store={store} config={config} tab="messages" signedIn messages={config.dm.on} />
      <main id="content" className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        <p className="mb-4">
          <Link href={box} className="cm-quiet-link text-sm font-semibold underline underline-offset-4">{w.backToMessages}</Link>
        </p>
        {notice ? <p className={`cm-flash mb-5 ${notice.tone === "warn" ? "cm-flash-warn" : ""}`} role="status">{notice.text}</p> : null}
        {namesUnread ? <NamesUnread language={store.language} className="mb-5" /> : null}

        <header className="flex items-center gap-3">
          <Face store={store} author={other} name={name} size={44} />
          <div className="min-w-0">
            <h1 className="font-display truncate text-xl font-semibold tracking-[-0.02em]">{name}</h1>
            <p className="st-muted text-sm">{w.privateTwo}</p>
          </div>
        </header>

        {talk.pending ? (
          <div className="st-note mt-5">
            <p className="font-bold" style={{ color: "var(--st-text)" }}>{w.wouldLike(name)}</p>
            <p className="mt-1 text-sm">
              {w.pendingNote}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <form action="/api/store/community/messages" method="post">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="action" value="accept" />
                <input type="hidden" name="pair" value={pair} />
                <button type="submit" className="btn st-btn">{w.accept}</button>
              </form>
              <form action="/api/store/community/messages" method="post">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="action" value="decline" />
                <input type="hidden" name="pair" value={pair} />
                <button type="submit" className="cm-quiet-link cm-mini cm-danger text-sm font-semibold">
                  {w.declineForGood}
                </button>
              </form>
            </div>
          </div>
        ) : null}

        {talk.messages.length === 0 ? (
          <EmptyState
            title={w.nothingSaidYet}
            body={config.dm.ask && other !== CREATOR && key !== CREATOR ? w.firstAsRequest(name) : w.writeFirst}
            className="mt-5"
          />
        ) : null}

        <ul className="mt-6 space-y-3">
          {talk.messages.map((message, i) => {
            const mine = message.a === key;
            return (
              <li key={`${message.at}-${i}`} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div className={`cm-dm-bubble ${mine ? "cm-dm-mine" : ""}`}>
                  <PostText text={message.text} className="text-[0.9375rem]" />
                  <p className="st-muted mt-1 text-xs font-semibold">
                    <time dateTime={new Date(message.at * 1000).toISOString()}>{storeWhen(store, message.at)}</time>
                  </p>
                </div>
              </li>
            );
          })}
        </ul>

        {canSend ? (
          <form action="/api/store/community/messages" method="post" className="mt-6">
            <input type="hidden" name="handle" value={store.handle} />
            <input type="hidden" name="action" value="send" />
            <input type="hidden" name="to" value={other} />
            <label htmlFor="dm-text" className="sr-only">{w.writeTo(name)}</label>
            <textarea
              id="dm-text"
              name="text"
              required
              rows={3}
              maxLength={MAX_MESSAGE_TEXT}
              placeholder={w.writeToPlaceholder(name)}
              className="st-field resize-y"
            />
            <div className="mt-3 flex justify-end">
              <button type="submit" className="btn st-btn">{w.send}</button>
            </div>
          </form>
        ) : talk.pending ? null : (
          <p className="st-muted mt-6 text-sm">
            {refused
              ? w.notOpenBetween
              : viewer.member?.muted
                ? NOTICES.muted.text
                : w.cannotWriteNow}
          </p>
        )}
      </main>
    </div>
  );
}
