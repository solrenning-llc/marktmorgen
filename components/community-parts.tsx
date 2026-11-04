import { EmailField } from "@/components/email-field";
import Link from "next/link";
import { photoUrl } from "@/lib/photo-limits";
import { isFree, type Listing, type Store } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { communityWords, pollWhenIn, whenIn } from "@/lib/buyer-words/community";
import { LANGUAGES } from "@/lib/store-language";
import { CREATOR, type CommunityConfig, type Member, type Post } from "@/lib/community";
import { communityImageFile } from "@/lib/community-image";
import { initialOf, segments } from "@/lib/community-text";
import { MAX_QUERY_LENGTH } from "@/lib/community-search";
import { withMentions } from "@/lib/community-mentions";
import type { PollView } from "@/lib/community-polls";
import { productSegment } from "@/lib/product-slug";
import { NewTab } from "@/components/new-tab";

/**
 * The pieces every community page is made of: the bar across the top, a
 * member's badge, a post's text with its links, a post in the feed, and the
 * small forms behind every button.
 *
 * Everything a member wrote reaches the page as text through React, which
 * escapes it; the only thing turned into markup is a web address that
 * lib/community-text.ts has already checked is an ordinary http or https one.
 * Every button is a plain form, so the community works before, and without,
 * any script.
 */

/** Notices that warn rather than confirm: drawn in the warning colour. */
const WARN = new Set([
  "noemail", "dmoff", "dmbetween", "dmfull", "chatoff", "pollclosed", "polloptions", "polltitle", "notyours", "empty", "links", "slow",
  "name", "questions", "image", "creatoronly", "level", "muted", "full", "fullposts", "fullcomments", "pinfull", "gone", "forbidden",
  "eventfull", "eventcancelled", "eventover", "eventlocked", "host", "nospace", "spacelocked", "out", "off", "error",
]);

/** What happened after a button, in the store's language (lib/buyer-words/community.ts). */
export function communityNotices(language: unknown): Record<string, { text: string; tone?: "warn" }> {
  const w = communityWords(language);
  return Object.fromEntries(Object.entries(w.notices).map(([key, text]) => [key, WARN.has(key) ? { text, tone: "warn" as const } : { text }]));
}

/** After asking for a link to come in, in the store's language. */
export function linkNotices(language: unknown): Record<string, { title: string; body: string }> {
  return communityWords(language).linkNotices;
}

/** "5 min ago", "Sep 4", in the store's language. */
export function storeWhen(store: Store, seconds: number): string {
  return whenIn(store.language, LANGUAGES[store.language].locale, seconds);
}

/** What a product that opens the community is, in a few words. */
export function ticketKind(store: Store, product: Listing): string {
  const w = communityWords(store.language);
  if (isFree(product)) return w.ticketFree;
  const price = speech(store).money(product.priceCents);
  if (product.recurring) return w.ticketMembership(price);
  if (product.course) return w.ticketCourse(price);
  if (product.call) return w.ticketCall(price);
  return price;
}

/** The picture's address: through the route that checks who is asking. */
export function communityImageUrl(store: Store, path: string): string {
  return `/api/store/community/image?h=${encodeURIComponent(store.handle)}&f=${communityImageFile(path)}`;
}

export type Tab = "feed" | "events" | "members" | "leaderboard" | "you" | "search" | "messages" | "notifications" | "chat";

/** The bar across the top of every community page. */
export function CommunityBar({
  store,
  config,
  tab,
  signedIn,
  query = "",
  messages = false,
  requests = 0,
  news = 0,
  room = false,
}: {
  store: Store;
  config: CommunityConfig;
  tab: Tab | null;
  signedIn: boolean;
  /** What was searched for, so the box still holds it on the results page. */
  query?: string;
  /** Private messages are switched on here. */
  messages?: boolean;
  /** How many people are waiting to be let into a conversation. */
  requests?: number;
  /** How many things happened to this person that they have not looked at. */
  news?: number;
  /** The live room is switched on here. */
  room?: boolean;
}) {
  const home = `/@${store.handle}/community`;
  const w = communityWords(store.language);
  const tabs: { id: Tab; label: string; href: string }[] = [
    { id: "feed", label: w.tabFeed, href: home },
    ...(room ? [{ id: "chat" as Tab, label: w.tabRoom, href: `${home}/chat` }] : []),
    { id: "events", label: w.tabEvents, href: `${home}/events` },
    { id: "members", label: w.tabMembers, href: `${home}/members` },
    { id: "leaderboard", label: w.tabLeaderboard, href: `${home}/leaderboard` },
    { id: "you", label: w.tabYou, href: `${home}/you` },
    ...(messages ? [{ id: "messages" as Tab, label: requests ? w.tabMessagesWaiting(requests) : w.tabMessages, href: `${home}/messages` }] : []),
    { id: "notifications" as Tab, label: news ? w.tabNewsWaiting(news) : w.tabNews, href: `${home}/notifications` },
  ];
  return (
    <header className="cm-bar relative z-30 sm:sticky sm:top-0">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href={`/@${store.handle}`} className="cm-home flex min-w-0 flex-1 items-center gap-3 rounded-xl">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt="" width={40} height={40} className="st-avatar !mx-0 shrink-0" style={{ width: 40, height: 40 }} />
          ) : (
            <span aria-hidden="true" className="st-avatar st-avatar-initial !mx-0 shrink-0" style={{ width: 40, height: 40, fontSize: "1.05rem" }}>
              {initialOf(store.name)}
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-[0.9375rem] font-bold leading-tight">{config.name}</span>
            <span className="st-muted block truncate text-xs font-semibold">{w.byStore(store.name)}</span>
          </span>
        </Link>
        {signedIn ? (
          <nav aria-label={w.pageTitle} className="w-full sm:w-auto">
            <ul className="flex flex-wrap gap-1">
              {tabs.map((t) => (
                <li key={t.id} className="flex-none">
                  <Link href={t.href} aria-current={tab === t.id ? "page" : undefined} className="cm-tab">
                    {t.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        {signedIn ? (
          // Its own form, and a GET: a search is a place you can send somebody,
          // go back to, and bookmark, so it belongs in the address.
          <form action={`${home}/search`} method="get" role="search" className="w-full sm:w-56">
            <label htmlFor="cm-search" className="sr-only">{w.searchLabel}</label>
            <input
              id="cm-search"
              type="search"
              name="q"
              defaultValue={query}
              maxLength={MAX_QUERY_LENGTH}
              placeholder={w.searchPlaceholder}
              className="cm-search"
              autoComplete="off"
            />
          </form>
        ) : null}
      </div>
    </header>
  );
}

/** A round badge with a member's first letter, or the creator's photo. */
export function Face({ store, author, name, size = 40 }: { store: Store; author: string; name: string; size?: number }) {
  if (author === CREATOR && store.photoId) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={photoUrl(store.photoId)} alt="" width={size} height={size} className="cm-face" style={{ width: size, height: size }} />
    );
  }
  return (
    <span aria-hidden="true" className={`cm-face ${author === CREATOR ? "cm-face-creator" : ""}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {initialOf(name)}
    </span>
  );
}

/** The name an author is shown by: the store's for the creator, a member's chosen one, or "A member". */
export function authorName(store: Store, author: string, members: Map<string, Member>): string {
  if (author === CREATOR) return store.name;
  return members.get(author)?.n || communityWords(store.language).aMember;
}

/** A member's words, with their web addresses as links and their line breaks kept. */
export function PostText({
  text,
  className = "",
  named,
  store,
}: {
  text: string;
  className?: string;
  /**
   * The handles in this text that belong to somebody, already looked up. An
   * @ that names nobody is left exactly as it was written: turning it into a
   * link would be the software inventing a person.
   */
  named?: Map<string, string>;
  store?: Store;
}) {
  const parts = named && named.size && store ? withMentions(segments(text), named) : null;
  if (!parts) {
    return (
      <p className={`cm-text ${className}`}>
        {segments(text).map((part, i) =>
          part.kind === "link" ? (
            <a key={i} href={part.href} target="_blank" rel="nofollow ugc noopener noreferrer">
              {part.text}
            <NewTab /></a>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
      </p>
    );
  }
  return (
    <p className={`cm-text ${className}`}>
      {parts.map((part, i) =>
        part.kind === "link" ? (
          <a key={i} href={part.href} target="_blank" rel="nofollow ugc noopener noreferrer">
            {part.text}
          <NewTab /></a>
        ) : part.kind === "mention" ? (
          <Link key={i} href={`/@${store!.handle}/community/members`} className="cm-mention">
            {part.text}
          </Link>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </p>
  );
}

/** The hidden fields every community form carries. */
export function Carry({
  store,
  action,
  post,
  from,
  space,
  extra,
}: {
  store: Store;
  action: string;
  post?: string;
  from: "feed" | "space" | "post" | "you";
  space?: string | null;
  /** Anything else the action needs, such as which comment it acts on. */
  extra?: Record<string, string>;
}) {
  return (
    <>
      <input type="hidden" name="handle" value={store.handle} />
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="from" value={from} />
      {post ? <input type="hidden" name="post" value={post} /> : null}
      {space ? <input type="hidden" name="space" value={space} /> : null}
      {extra ? Object.entries(extra).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />) : null}
    </>
  );
}

/** One button that is a whole form. */
export function ActButton({
  store,
  action,
  post,
  from,
  space,
  extra,
  children,
  className = "cm-menu-item",
  confirm,
}: {
  store: Store;
  action: string;
  post?: string;
  from: "feed" | "space" | "post" | "you";
  space?: string | null;
  extra?: Record<string, string>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
}) {
  return (
    <form action="/api/store/community" method="post" data-confirm={confirm}>
      <Carry store={store} action={action} post={post} from={from} space={space} />
      {extra ? Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      <button type="submit" className={className}>
        {children}
      </button>
    </form>
  );
}

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" />
    </svg>
  );
}

function Bubble() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

/** A creator badge: what tells every member who the creator is. */
export function CreatorBadge({ store }: { store?: Store }) {
  return <span className="cm-badge cm-badge-creator">{communityWords(store?.language).creatorBadge}</span>;
}

/** A member's level (lib/community-points.ts), beside their name everywhere they write. */
export function LevelBadge({ level, store }: { level: number | undefined; store?: Store }) {
  if (!level) return null;
  const said = communityWords(store?.language).levelBadge(level);
  return (
    <span className="cm-badge" title={said}>
      {said}
    </span>
  );
}

const CUT = 600;

/** One post, in a feed or on its own page. */
/**
 * The poll on a post: the answers, the bars, and the one form that casts,
 * changes or takes back a vote.
 *
 * Deliberate, and stated on the card itself rather than left to be assumed:
 * a vote is tied to the person who cast it, because a poll that let one
 * person vote a thousand times counts nothing. The creator is shown the
 * tally, never who chose what. Saying so is the difference between a poll
 * people trust and one they answer carefully.
 */
function PollBox({
  store,
  post,
  view,
  viewer,
  from,
  space,
}: {
  store: Store;
  post: Post;
  view: PollView;
  viewer: { key: string; owner: boolean; canWrite: boolean };
  from: "feed" | "space" | "post";
  space?: string | null;
}) {
  const { poll, counts, total, mine, closed, showing } = view;
  const w = communityWords(store.language);
  const when = pollWhenIn(store.language, poll.ends);
  const voted = mine.length > 0;
  const open = !closed && viewer.canWrite;
  const share = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  return (
    <div className="cm-poll mt-4">
      <form action="/api/store/community" method="post">
        <Carry store={store} action="vote" post={post.id} from={from} space={space} />
        <fieldset disabled={!open}>
        <legend className="sr-only">{post.title || w.poll}</legend>
        <ul className="space-y-1.5">
          {poll.options.map((option) => {
            const n = counts[option.id] ?? 0;
            const picked = mine.includes(option.id);
            return (
              <li key={option.id}>
                <label className={`cm-poll-row ${picked ? "cm-poll-mine" : ""}`}>
                  <input
                    type={poll.multi ? "checkbox" : "radio"}
                    name="choice"
                    value={option.id}
                    defaultChecked={picked}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1 break-words">{option.text}</span>
                  {showing ? (
                    <span className="cm-poll-count tabular-nums">{`${share(n)}%`}</span>
                  ) : null}
                  {showing ? (
                    <span aria-hidden="true" className="cm-poll-bar" style={{ width: `${share(n)}%` }} />
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
        {open ? (
          <div className="mt-3">
            <button type="submit" className="cm-pill">{voted ? w.changeVote : w.vote}</button>
          </div>
        ) : null}
        </fieldset>
      </form>
      {open && voted ? (
        // Its own form, with no choice field in it at all. Inside the first
        // one the checked option is sent too, and an empty value next to a
        // real one is simply the real one: the button did nothing, silently.
        <form action="/api/store/community" method="post" className="mt-2">
          <Carry store={store} action="vote" post={post.id} from={from} space={space} />
          <button type="submit" className="cm-quiet-link cm-mini text-xs font-semibold">{w.takeVoteBack}</button>
        </form>
      ) : null}
      <p className="st-muted mt-2 text-xs font-semibold">
        {[
          showing ? w.votes(total) : w.resultsHidden,
          poll.multi ? w.pickMany : w.pickOne,
          when,
          closed ? "" : viewer.canWrite ? "" : w.cannotVote,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <p className="st-muted mt-1 text-xs">
        {w.voteNote(store.name)}
      </p>
    </div>
  );
}

export function PostCard({
  store,
  post,
  config,
  members,
  numbers,
  poll,
  viewer,
  from,
  space,
  full = false,
  named,
  levels,
}: {
  store: Store;
  post: Post;
  config: CommunityConfig;
  members: Map<string, Member>;
  /** Each author's level, by member key. */
  levels?: Map<string, number>;
  numbers: { likes: number; liked: boolean; comments: number } | undefined;
  /** The poll on this post, already read, or undefined when it has none. */
  poll?: PollView;
  viewer: { key: string; owner: boolean; canWrite: boolean };
  from: "feed" | "space" | "post";
  space?: string | null;
  full?: boolean;
  /** The @ in this post that belong to somebody. */
  named?: Map<string, string>;
}) {
  const home = `/@${store.handle}/community`;
  const name = authorName(store, post.a, members);
  const place = config.spaces.find((s) => s.id === post.sp);
  const long = !full && post.text.length > CUT;
  const shown = long ? `${post.text.slice(0, CUT).replace(/\s+\S*$/, "")}…` : post.text;
  const pinned = config.pinned.includes(post.id);
  const start = config.start === post.id;
  const mine = post.a === viewer.key;
  const likes = numbers?.likes ?? 0;
  const comments = numbers?.comments ?? 0;
  const link = `${home}/post/${post.id}`;
  const labelId = `post-title-${post.id}`;
  const authorMuted = post.a !== CREATOR && members.get(post.a)?.muted;
  const w = communityWords(store.language);
  const { num } = speech(store);

  return (
    <article id={`post-${post.id}`} aria-labelledby={labelId} className={`st-card cm-post scroll-mt-28 p-5 sm:p-6 ${post.hid ? "cm-hidden" : ""}`}>
      <header className="flex items-start gap-3">
        <Face store={store} author={post.a} name={name} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.9375rem] font-bold leading-tight">
            <span className="min-w-0 break-words">{name}</span>
            {post.a === CREATOR ? <CreatorBadge store={store} /> : <LevelBadge level={levels?.get(post.a)} store={store} />}
          </p>
          <p className="st-muted mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm">
            {place ? (
              <>
                <Link href={`${home}?space=${place.id}`} className="cm-quiet-link">{place.name}</Link>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <time dateTime={new Date(post.at * 1000).toISOString()}>{storeWhen(store, post.at)}</time>
            {post.ed ? (
              <>
                <span aria-hidden="true">·</span>
                {/* Said out loud, because people reply to what a post said. */}
                <span title={w.editedAt(storeWhen(store, post.ed))}>{w.edited}</span>
              </>
            ) : null}
          </p>
        </div>
      </header>

      {start || pinned || post.kind === "announcement" || post.hid ? (
        <p className="mt-3 flex flex-wrap gap-1.5">
          {start ? <span className="cm-badge cm-badge-accent">{w.startHere}</span> : null}
          {pinned ? <span className="cm-badge">{w.pinnedBadge}</span> : null}
          {post.kind === "announcement" ? <span className="cm-badge cm-badge-accent">{w.announcement}</span> : null}
          {post.hid ? <span className="cm-badge cm-badge-warn">{w.hiddenFromMembers}</span> : null}
        </p>
      ) : null}

      <h2 id={labelId} className={`font-display mt-3 break-words text-lg font-semibold leading-snug tracking-[-0.01em] sm:text-xl ${post.title ? "" : "sr-only"}`}>
        {full ? post.title || w.postBy(name) : <Link href={link} className="st-title-link">{post.title || w.postBy(name)}</Link>}
      </h2>
      {shown ? <PostText text={shown} className="mt-2" named={named} store={store} /> : null}
      {long ? (
        <p className="mt-2 text-sm font-semibold">
          <Link href={link} className="cm-quiet-link underline underline-offset-4">{w.readWholePost}</Link>
        </p>
      ) : null}
      {post.img ? (
        // A plain img: the picture is already shrunk and is served through a
        // route that checks who is asking, which an optimiser would bypass.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={communityImageUrl(store, post.img.path)}
          alt={post.img.alt}
          width={post.img.w}
          height={post.img.h}
          loading="lazy"
          decoding="async"
          className="cm-img mt-4"
        />
      ) : null}
      {poll ? <PollBox store={store} post={post} view={poll} viewer={viewer} from={from} space={space} /> : null}

      <footer className="mt-4 flex flex-wrap items-center gap-2">
        {viewer.canWrite ? (
          <ActButton
            store={store}
            action="like"
            post={post.id}
            from={from}
            space={space}
            className={`cm-pill ${numbers?.liked ? "cm-pill-on" : ""}`}
          >
            <Heart filled={Boolean(numbers?.liked)} />
            <span aria-hidden="true">{likes}</span>
            <span className="sr-only">{numbers?.liked ? w.unlikeThis(likes, num(likes)) : w.likeThis(likes, num(likes))}</span>
          </ActButton>
        ) : (
          <span className="cm-pill cm-pill-still">
            <Heart filled={false} />
            <span aria-hidden="true">{likes}</span>
            <span className="sr-only">{w.likes(likes, num(likes))}</span>
          </span>
        )}
        {full ? (
          <a href="#comments" className="cm-pill">
            <Bubble />
            <span>{w.comments(comments, num(comments))}</span>
          </a>
        ) : (
          <Link href={`${link}#comments`} className="cm-pill">
            <Bubble />
            <span>{comments === 0 ? w.commentVerb : w.comments(comments, num(comments))}</span>
          </Link>
        )}

        {viewer.canWrite ? (
          <details className="cm-menu ml-auto">
            <summary className="cm-pill" aria-label={w.moreForPost}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </summary>
            <div className="cm-menu-list" role="group" aria-label={w.postActions}>
              {viewer.owner ? (
                <>
                  <ActButton store={store} action={pinned ? "unpin" : "pin"} post={post.id} from={from} space={space}>
                    {pinned ? w.unpin : w.pinToTop}
                  </ActButton>
                  <ActButton store={store} action={start ? "unstart" : "start"} post={post.id} from={from} space={space}>
                    {start ? w.noLongerStart : w.makeStart}
                  </ActButton>
                  <ActButton store={store} action={post.hid ? "unhide" : "hide"} post={post.id} from={from} space={space}>
                    {post.hid ? w.showToMembers : w.hideFromMembers}
                  </ActButton>
                  {post.a !== CREATOR ? (
                    <ActButton store={store} action={authorMuted ? "unmute" : "mute"} post={post.id} from={from} space={space}>
                      {authorMuted ? w.unmute(name) : w.mute(name)}
                    </ActButton>
                  ) : null}
                </>
              ) : !mine ? (
                <ActButton store={store} action="report" post={post.id} from={from} space={space}>
                  {w.reportToCreator}
                </ActButton>
              ) : null}
              {mine ? (
                <Link href={`${link}?edit=post`} className="cm-menu-item">
                  {w.editPost}
                </Link>
              ) : null}
              {viewer.owner || mine ? (
                <ActButton store={store} action="delete" post={post.id} from={from} space={space} className="cm-menu-item cm-danger" confirm={w.deletePostConfirm}>
                  {w.deletePost}
                </ActButton>
              ) : null}
            </div>
          </details>
        ) : null}
      </footer>
    </article>
  );
}

/** The panel shown to somebody who is not in: what opens it, and how to come in. */
export function Gate({
  store,
  config,
  state,
  email,
  products,
  link,
}: {
  store: Store;
  config: CommunityConfig;
  state: "out" | "closed" | "removed";
  email: string | null;
  products: { id: string; title: string; kind: string }[];
  link: { title: string; body: string } | null;
}) {
  const w = communityWords(store.language);
  return (
    <div className="st-card mx-auto mt-8 max-w-xl p-6 sm:p-8">
      <p className="st-label">{w.pageTitle}</p>
      <h1 className="font-display mt-1 text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">{config.name}</h1>
      {config.about ? <PostText text={config.about} className="st-muted mt-3 leading-relaxed" /> : null}

      {link ? (
        <div className="st-note mt-6" role="status">
          <p className="font-bold" style={{ color: "var(--st-text)" }}>{link.title}</p>
          <p className="mt-1 text-sm">{link.body}</p>
        </div>
      ) : null}

      {state === "removed" ? (
        <div className="st-note mt-6" role="status">
          <p className="font-bold" style={{ color: "var(--st-text)" }}>{w.removedTitle(store.name)}</p>
          <p className="mt-1 text-sm">{w.removedBody(email ?? "")}</p>
        </div>
      ) : state === "closed" ? (
        <div className="st-note mt-6" role="status">
          <p className="font-bold" style={{ color: "var(--st-text)" }}>{w.closedTitle}</p>
          <p className="mt-1 text-sm">{w.closedBody(email ?? "", store.name)}</p>
        </div>
      ) : null}

      {state !== "removed" && products.length > 0 ? (
        <div className="mt-6">
          <p className="text-sm font-semibold">{w.openToEveryone}</p>
          <ul className="mt-2 space-y-2">
            {products.map((p) => (
              <li key={p.id}>
                <Link href={`/@${store.handle}/p/${productSegment(p)}`} className="cm-row">
                  <span className="min-w-0 break-words font-semibold">{p.title}</span>
                  <span className="st-muted shrink-0 text-sm">{p.kind}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state !== "removed" ? (
        <form action="/api/store/community/link" method="post" className="mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }}>
          <input type="hidden" name="handle" value={store.handle} />
          <label htmlFor="community-email" className="st-label">{state === "closed" ? w.tryAnotherAddress : w.alreadyMember}</label>
          <p className="st-muted mt-1 text-sm">{w.linkExplain}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
            <EmailField id="community-email" name="email" className="st-field w-full" wrapClassName="min-w-0 flex-1" required autoComplete="email" placeholder={speech(store).w.emailPlaceholder} language={store.language} />
            <button type="submit" className="btn st-btn">{w.sendLink}</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
