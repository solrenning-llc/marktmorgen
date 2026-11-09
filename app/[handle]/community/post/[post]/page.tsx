import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage, type Store } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { CREATOR, type Comment, type Member, commentNumbers, postNumbers, readComments, readMembers, readPost } from "@/lib/community";
import { levelOf, pointsOf } from "@/lib/community-points";
import { requestCount } from "@/lib/community-dm";
import { unreadCount } from "@/lib/community-notify";
import { maySeeSpace } from "@/lib/community-access";
import { communityVisitor } from "@/lib/community-page";
import { pollViews } from "@/lib/community-polls";
import { mentionsIn, whoIs } from "@/lib/community-mentions";
import { ITEM_ID, MAX_COMMENT_TEXT, MAX_POST_TEXT, MAX_POST_TITLE } from "@/lib/community-text";
import { communityWords } from "@/lib/buyer-words/community";
import { speech } from "@/lib/buyer-words";
import { LANGUAGES } from "@/lib/store-language";
import {
  ActButton,
  Carry,
  CommunityBar,
  CreatorBadge,
  Face,
  LevelBadge,
  PostCard,
  PostText,
  authorName,
  communityNotices,
  storeWhen,
} from "@/components/community-parts";
import { ConfirmDeletes } from "@/components/community-composer";
import { ownEntry } from "@/lib/own-entry";

type Params = { params: Promise<{ handle: string; post: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${communityWords(store?.language).postPageTitle} — Marktmorgen`, robots: { index: false, follow: false } };
}

type Who = { key: string; owner: boolean; canWrite: boolean };

function CommentItem({
  store,
  post,
  comment,
  members,
  who,
  replies,
  editing = false,
  named,
  likes,
  levels,
}: {
  store: Store;
  post: string;
  comment: Comment;
  members: Map<string, Member>;
  who: Who;
  /** How many liked it, and whether this viewer did. */
  likes: Map<string, { likes: number; liked: boolean }>;
  /** Each author's level (lib/community-points.ts). */
  levels: Map<string, number>;
  replies?: React.ReactNode;
  /** Open as a form, because the author asked to rewrite it. */
  editing?: boolean;
  /** The @ in this page that belong to somebody. */
  named: Map<string, string>;
}) {
  const name = authorName(store, comment.a, members);
  const mine = comment.a === who.key;
  const top = !comment.parent;
  const extra = { comment: comment.id };
  const here = `/@${store.handle}/community/post/${post}`;
  const w = communityWords(store.language);
  const { num } = speech(store);
  return (
    <li id={`comment-${comment.id}`} className="scroll-mt-28">
      <div className={`flex items-start gap-3 ${comment.hid ? "cm-hidden" : ""}`}>
        <Face store={store} author={comment.a} name={name} size={top ? 36 : 30} />
        <div className="min-w-0 flex-1">
          <div className="cm-bubble">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-bold leading-tight">
              <span className="break-words">{name}</span>
              {comment.a === CREATOR ? <CreatorBadge store={store} /> : <LevelBadge level={levels.get(comment.a)} store={store} />}
              {comment.hid ? <span className="cm-badge cm-badge-warn">{w.hiddenFromMembers}</span> : null}
            </p>
            {editing ? (
              <form action="/api/store/community" method="post" className="mt-1">
                <Carry store={store} action="edit-comment" post={post} from="post" extra={extra} />
                <label htmlFor={`edit-text-${comment.id}`} className="sr-only">{w.rewriteComment}</label>
                <textarea
                  id={`edit-text-${comment.id}`}
                  name="text"
                  required
                  rows={3}
                  maxLength={MAX_COMMENT_TEXT}
                  defaultValue={comment.text}
                  className="st-field resize-y text-[0.9375rem]"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="submit" className="cm-pill">{w.save}</button>
                  <Link href={`${here}#comment-${comment.id}`} className="cm-quiet-link cm-mini text-xs font-semibold">{w.cancel}</Link>
                </div>
              </form>
            ) : (
              <PostText text={comment.text} className="mt-1 text-[0.9375rem]" named={named} store={store} />
            )}
          </div>
          <div className="st-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs font-semibold">
            <time dateTime={new Date(comment.at * 1000).toISOString()}>{storeWhen(store, comment.at)}</time>
            {comment.ed ? <span title={w.editedAt(storeWhen(store, comment.ed))}>{w.edited}</span> : null}
            {(() => {
              const n = likes.get(comment.id) ?? { likes: 0, liked: false };
              const label = `${n.liked ? w.liked : w.like}${n.likes ? ` · ${num(n.likes)}` : ""}`;
              return who.canWrite ? (
                <ActButton store={store} action="like-comment" post={post} from="post" extra={extra} className={`cm-quiet-link cm-mini ${n.liked ? "cm-liked" : ""}`}>
                  <span aria-hidden="true">{label}</span>
                  <span className="sr-only">{n.liked ? w.unlikeComment(n.likes, num(n.likes)) : w.likeComment(n.likes, num(n.likes))}</span>
                </ActButton>
              ) : n.likes ? (
                <span>{w.likes(n.likes, num(n.likes))}</span>
              ) : null;
            })()}
            {who.canWrite && mine && !editing ? (
              <Link href={`${here}?edit=${comment.id}#comment-${comment.id}`} className="cm-quiet-link cm-mini">{w.edit}</Link>
            ) : null}
            {who.canWrite && !who.owner && !mine ? (
              <ActButton store={store} action="report" post={post} from="post" extra={extra} className="cm-quiet-link cm-mini">{w.report}</ActButton>
            ) : null}
            {who.owner ? (
              <ActButton store={store} action={comment.hid ? "unhide-comment" : "hide-comment"} post={post} from="post" extra={extra} className="cm-quiet-link cm-mini">
                {comment.hid ? w.show : w.hide}
              </ActButton>
            ) : null}
            {who.canWrite && (who.owner || mine) ? (
              <ActButton store={store} action="delete-comment" post={post} from="post" extra={extra} className="cm-quiet-link cm-mini cm-danger" confirm={top ? w.deleteCommentConfirm : w.deleteReplyConfirm}>
                {w.delete}
              </ActButton>
            ) : null}
          </div>
          {who.canWrite && top ? (
            <details className="cm-reply mt-1">
              <summary className="cm-quiet-link cm-mini inline-flex px-1 text-xs font-semibold">{w.reply}</summary>
            <form id={`reply-${comment.id}`} action="/api/store/community" method="post" className="mt-2 scroll-mt-28">
              <Carry store={store} action="comment" post={post} from="post" />
              <input type="hidden" name="parent" value={comment.id} />
              <label htmlFor={`reply-text-${comment.id}`} className="sr-only">{w.replyTo(name)}</label>
              <div className="flex gap-2">
                <input id={`reply-text-${comment.id}`} name="text" required maxLength={MAX_COMMENT_TEXT} placeholder={w.replyToPlaceholder(name)} className="st-field min-w-0 flex-1 !min-h-11 !py-2 text-sm" autoComplete="off" />
                <button type="submit" className="cm-pill">{w.reply}</button>
              </div>
            </form>
            </details>
          ) : null}
          {replies}
        </div>
      </div>
    </li>
  );
}

/** One post on its own page, with every comment under it. */
export default async function CommunityPostPage({ params, searchParams }: Params) {
  const { handle: raw, post: postId } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const viewer = await communityVisitor(store, await cookies());
  if (viewer.state === "off" || !store.community) redirect(`/@${store.handle}`);
  const home = `/@${store.handle}/community`;
  if (viewer.state !== "in") redirect(home);
  const id = store.community.id;
  const post = ITEM_ID.test(postId) ? await readPost(id, postId) : null;
  if (!post || (post.hid && !viewer.owner)) redirect(`${home}?n=gone`);

  const { config, owner, key, canWrite } = viewer;
  // A post in a space kept for the buyers of some products is not reachable
  // by its address either.
  const itsSpace = config.spaces.find((s) => s.id === post.sp);
  if (itsSpace && !(await maySeeSpace(store, config, itsSpace, { owner, email: viewer.email }))) {
    redirect(`${home}?n=spacelocked`);
  }
  const query = await searchParams;
  const w = communityWords(store.language);
  const notices = communityNotices(store.language);
  const notice = ownEntry(notices, query.n) ?? null;
  const all = await readComments(id, post.id);
  const [members, numbers, polls, likes, points] = await Promise.all([
    readMembers(id, [post.a, ...all.map((c) => c.a)]),
    postNumbers(id, [post], key),
    pollViews(id, [post], key, owner),
    commentNumbers(id, post.id, all, key),
    pointsOf(id, [post.a, ...all.map((c) => c.a)]),
  ]);
  const levels = new Map([...points].map(([k, n]) => [k, levelOf(n)]));
  const who: Who = { key, owner, canWrite };
  // The badge on the Messages link: nothing to read, nothing shown.
  const waiting = config.dm.on ? await requestCount(id, key) : 0;
  const news = await unreadCount(id, key);
  // Which @ in this post and its comments belong to somebody. Looked up once,
  // for the whole page.
  const named = await whoIs(id, mentionsIn([post.title, post.text, ...all.map((c) => c.text)].join("\n")));
  const visible = (c: Comment) => owner || !c.hid;
  const tops = all.filter((c) => !c.parent);
  const repliesOf = (c: Comment) => all.filter((r) => r.parent === c.id && visible(r));
  // ?edit=post, or ?edit=<comment>. Only ever the author's own, and only
  // while they may still write here.
  const asked = typeof query.edit === "string" ? query.edit : "";
  const editingPost = asked === "post" && canWrite && post.a === key;
  const editingComment = asked && asked !== "post" && canWrite ? (all.find((c) => c.id === asked && c.a === key && !c.hid)?.id ?? "") : "";

  return (
    <div lang={LANGUAGES[store.language].locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <ConfirmDeletes />
      <CommunityBar store={store} config={config} tab="feed" signedIn messages={config.dm.on} requests={waiting} news={news} room={config.chat.on} />
      <main id="content" className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        <p className="mb-4">
          <Link href={home} className="cm-quiet-link text-sm font-semibold underline underline-offset-4">{w.backToFeed}</Link>
        </p>
        {notice ? <p className={`cm-flash mb-5 ${notice.tone === "warn" ? "cm-flash-warn" : ""}`} role="status">{notice.text}</p> : null}

        {editingPost ? (
          <form action="/api/store/community" method="post" className="st-card p-5 sm:p-6">
            <Carry store={store} action="edit" post={post.id} from="post" />
            <h1 className="font-display text-lg font-semibold tracking-[-0.01em]">{w.editYourPost}</h1>
            <label htmlFor="edit-title" className="st-label mt-4 block">{w.titleField}</label>
            <input
              id="edit-title"
              name="title"
              maxLength={MAX_POST_TITLE}
              defaultValue={post.title}
              className="st-field mt-2"
              autoComplete="off"
            />
            <label htmlFor="edit-text" className="st-label mt-4 block">{w.postField}</label>
            <textarea
              id="edit-text"
              name="text"
              rows={8}
              maxLength={MAX_POST_TEXT}
              defaultValue={post.text}
              className="st-field mt-2 resize-y"
            />
            <p className="st-muted mt-3 text-sm">{w.editNote}</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="submit" className="btn st-btn">{w.savePost}</button>
              <Link href={`${home}/post/${post.id}`} className="cm-quiet-link text-sm font-semibold underline underline-offset-4">{w.cancel}</Link>
            </div>
          </form>
        ) : (
          <PostCard store={store} post={post} config={config} members={members} numbers={numbers.get(post.id)} poll={polls.get(post.id)} viewer={who} from="post" full named={named} levels={levels} />
        )}

        <section id="comments" aria-labelledby="comments-title" className="st-card mt-4 scroll-mt-28 p-5 sm:p-6">
          <h2 id="comments-title" className="text-base font-bold">{w.commentsHeading(all.filter(visible).length)}</h2>
          {tops.length === 0 ? (
            <p className="st-muted mt-2 text-sm">{w.noComments}</p>
          ) : (
            <ul className="mt-4 space-y-5">
              {tops.map((comment) => {
                const replies = repliesOf(comment);
                if (!visible(comment)) {
                  // A hidden comment whose replies are not: they keep their place.
                  if (replies.length === 0) return null;
                  return (
                    <li key={comment.id} id={`comment-${comment.id}`}>
                      <p className="st-muted text-sm italic">{w.creatorHid}</p>
                      <ul className="cm-thread mt-3 space-y-4">
                        {replies.map((r) => (
                          <CommentItem key={r.id} store={store} post={post.id} comment={r} members={members} who={who} editing={editingComment === r.id} named={named} likes={likes} levels={levels} />
                        ))}
                      </ul>
                    </li>
                  );
                }
                return (
                  <CommentItem
                    key={comment.id}
                    store={store}
                    post={post.id}
                    comment={comment}
                    members={members}
                    who={who}
                    editing={editingComment === comment.id}
                    named={named}
                    likes={likes}
                    levels={levels}
                    replies={
                      replies.length ? (
                        <ul className="cm-thread mt-3 space-y-4">
                          {replies.map((r) => (
                            <CommentItem key={r.id} store={store} post={post.id} comment={r} members={members} who={who} editing={editingComment === r.id} named={named} likes={likes} levels={levels} />
                          ))}
                        </ul>
                      ) : null
                    }
                  />
                );
              })}
            </ul>
          )}

          {canWrite ? (
            <form id="reply" action="/api/store/community" method="post" className="mt-6 scroll-mt-28">
              <Carry store={store} action="comment" post={post.id} from="post" />
              <label htmlFor="comment-text" className="st-label">{w.addComment}</label>
              <textarea id="comment-text" name="text" required rows={3} maxLength={MAX_COMMENT_TEXT} className="st-field mt-2 resize-y" placeholder={w.commentPlaceholder} />
              <div className="mt-3 flex justify-end">
                <button type="submit" className="btn st-btn">{w.commentVerb}</button>
              </div>
            </form>
          ) : viewer.member?.muted ? (
            <p className="st-muted mt-6 text-sm">{notices.muted.text}</p>
          ) : null}
        </section>
      </main>
    </div>
  );
}
