import { initialOf, segments } from "@/lib/community-text";
import {
  CREATOR_AUTHOR,
  type LessonComment,
  MAX_COMMENTER_NAME,
  MAX_LESSON_COMMENT,
  type Thread,
  countShown,
} from "@/lib/lesson-comments-rules";
import { type CoursesWords, coursesWords } from "@/lib/buyer-words/courses";
import { type CommunityWords, communityWords } from "@/lib/buyer-words/community";
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";
import { NewTab } from "@/components/new-tab";

/** The notices that say something went wrong, as opposed to that it went through. */
const WARNINGS = new Set(["empty", "name", "slow", "parent", "replies", "full", "gone", "off", "locked"]);

/**
 * How long ago, "5 min ago", and past a week the day it was written, as
 * lib/community-text.ts whenWords says it, in the store's language.
 */
function when(w: CoursesWords, locale: string, seconds: number, nowSeconds: number): string {
  const ago = Math.max(0, nowSeconds - seconds);
  if (ago < 60) return w.justNow;
  if (ago < 3_600) return w.minutesAgo(Math.floor(ago / 60));
  if (ago < 86_400) return w.hoursAgo(Math.floor(ago / 3_600));
  if (ago < 7 * 86_400) return w.daysAgo(Math.floor(ago / 86_400));
  const date = new Date(seconds * 1000);
  const sameYear = date.getUTCFullYear() === new Date(nowSeconds * 1000).getUTCFullYear();
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

function Words({ text }: { text: string }) {
  return (
    <p className="cm-text mt-1 text-[0.9375rem]" style={{ color: "var(--st-text)" }}>
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

type Where = { handle: string; product: string; lesson: string };

function Fields({ where, action }: { where: Where; action: string }) {
  return (
    <>
      <input type="hidden" name="handle" value={where.handle} />
      <input type="hidden" name="product" value={where.product} />
      <input type="hidden" name="lesson" value={where.lesson} />
      <input type="hidden" name="action" value={action} />
    </>
  );
}

/** The name box, only for a student who has not chosen one yet. */
function NameField({ show, w, placeholder }: { show: boolean; w: CoursesWords; placeholder: string }) {
  if (!show) return null;
  return (
    <label className="block">
      <span className="st-label">{w.nameAsSeen}</span>
      <input className="st-field mt-2" name="name" required maxLength={MAX_COMMENTER_NAME} autoComplete="given-name" placeholder={placeholder} />
    </label>
  );
}

function One({
  comment,
  reply,
  answers = 0,
  reader,
  storeName,
  where,
  now,
  w,
  cw,
  locale,
}: {
  comment: LessonComment;
  reply: boolean;
  answers?: number;
  reader: string;
  storeName: string;
  where: Where;
  now: number;
  w: CoursesWords;
  /** The community's words, for the question asked before a delete. */
  cw: CommunityWords;
  locale: string;
}) {
  const creator = reader === CREATOR_AUTHOR;
  const fromCreator = comment.by === CREATOR_AUTHOR;
  const name = fromCreator ? storeName : comment.name || w.aStudent;
  const mine = comment.by === reader;
  return (
    <div id={`c-${comment.id}`} className={`flex gap-3 ${comment.hidden ? "opacity-60" : ""}`}>
      <span aria-hidden="true" className={`cm-face ${fromCreator ? "cm-face-creator" : ""} ${reply ? "h-8 w-8 text-sm" : "h-10 w-10"}`}>
        {initialOf(name)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-semibold" style={{ color: "var(--st-text)" }}>{name}</span>
          {fromCreator ? <span className="cm-badge cm-badge-creator">{w.creatorBadge}</span> : null}
          {comment.hidden ? <span className="cm-badge cm-badge-warn">{w.hiddenBadge}</span> : null}
          <span className="st-muted">{when(w, locale, comment.at, now)}</span>
        </p>
        <Words text={comment.text} />
        {mine || creator ? (
          <div className="mt-1 flex flex-wrap gap-x-4 text-sm">
            {creator && !fromCreator ? (
              <form action="/api/store/course/comment" method="post">
                <Fields where={where} action={comment.hidden ? "show" : "hide"} />
                <input type="hidden" name="id" value={comment.id} />
                <button type="submit" className="st-footer-link inline-flex min-h-11 items-center font-semibold">
                  {comment.hidden ? w.show : w.hide}
                </button>
              </form>
            ) : null}
            {/* Deleting cannot be undone (WCAG 3.3.4, 3.3.6): the first press only opens the question, in the
                community's own words, and its "Delete" sends; pressing the first button again closes it and
                nothing is sent. A plain disclosure, so it works without a script and makes no extra request. */}
            <details>
              {/* A 44 px row of its own (WCAG 2.5.5): the lesson page is not inside [data-store-layout], so the
                  store front's summary rule does not reach it. Equal padding above and below centres the words in
                  that row, and not flex, so it keeps its disclosure triangle; py-2.5 is for a browser without
                  the lh unit. */}
              <summary
                className="st-footer-link cursor-pointer py-2.5 font-semibold"
                style={{ minHeight: "2.75rem", paddingBlock: "calc((2.75rem - 1lh) / 2)" }}
              >
                {answers > 0 ? w.deleteWithAnswers : w.delete}
              </summary>
              <form
                action="/api/store/course/comment"
                method="post"
                role="group"
                aria-label={reply ? cw.deleteReplyConfirm : cw.deleteCommentConfirm}
                className="flex flex-wrap items-center gap-x-4"
              >
                <Fields where={where} action="delete" />
                <input type="hidden" name="id" value={comment.id} />
                <p style={{ color: "var(--st-text)" }}>{reply ? cw.deleteReplyConfirm : cw.deleteCommentConfirm}</p>
                <button type="submit" className="st-footer-link inline-flex min-h-11 items-center font-semibold">
                  {w.delete}
                </button>
              </form>
            </details>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The comments under a lesson, for a student of the course or its creator.
 * Plain forms that post to /api/store/course/comment: nothing here needs
 * a script to work. Said in the store's `language`
 * (lib/buyer-words/courses.ts), English unless given; `namePlaceholder` is
 * the store's example of a first name.
 */
export function LessonComments({
  threads,
  reader,
  storeName,
  hidden,
  myName,
  notice,
  now,
  language = "en",
  namePlaceholder = "Dana",
}: {
  threads: Thread[];
  /** CREATOR_AUTHOR, or the student's key. */
  reader: string;
  storeName: string;
  /** The fields every form carries: which store, product and lesson. */
  hidden: { handle: string; product: string; lesson: string };
  /** The name this student already chose, or "". */
  myName: string;
  notice: string;
  now: number;
  language?: LanguageCode;
  namePlaceholder?: string;
}) {
  const w = coursesWords(language);
  const cw = communityWords(language);
  const locale = LANGUAGES[parseLanguage(language)].locale;
  const creator = reader === CREATOR_AUTHOR;
  const count = countShown(threads);
  const flash = w.commentNotices[notice];
  const warn = WARNINGS.has(notice);
  return (
    <section id="comments" aria-labelledby="comments-title" className="st-card p-5 sm:p-8">
      <h2 id="comments-title" className="font-display text-xl font-semibold tracking-[-0.01em]" style={{ color: "var(--st-text)" }}>
        {w.commentsTitle(count)}
      </h2>
      <p className="st-muted mt-1 text-sm">{creator ? w.commentsCreator : w.commentsStudent}</p>

      {flash ? (
        <p className={`cm-flash mt-4 ${warn ? "cm-flash-warn" : ""}`} role={warn ? "alert" : "status"}>
          {flash}
        </p>
      ) : null}

      <form action="/api/store/course/comment" method="post" className="mt-5 space-y-3">
        <Fields where={hidden} action="post" />
        <NameField show={!creator && !myName} w={w} placeholder={namePlaceholder} />
        <label className="block">
          <span className="st-label">{creator ? w.writeToStudents : w.askOrShare}</span>
          <textarea className="st-field mt-2" name="text" rows={3} required maxLength={MAX_LESSON_COMMENT} />
        </label>
        <button type="submit" className="btn st-btn">{w.post}</button>
        {myName && !creator ? <p className="st-muted text-xs">{w.postAs(myName)}</p> : null}
      </form>

      {threads.length ? (
        <ol className="mt-8 space-y-6">
          {threads.map(({ comment, replies }) => (
            <li key={comment.id} className="space-y-3">
              <One comment={comment} reply={false} answers={replies.length} reader={reader} storeName={storeName} where={hidden} now={now} w={w} cw={cw} locale={locale} />
              {replies.length ? (
                <ol className="cm-thread ml-5 space-y-3">
                  {replies.map((r) => (
                    <li key={r.id}>
                      <One comment={r} reply reader={reader} storeName={storeName} where={hidden} now={now} w={w} cw={cw} locale={locale} />
                    </li>
                  ))}
                </ol>
              ) : null}
              {comment.hidden ? null : (
              <details className="cm-reply ml-[3.25rem]">
                <summary className="st-footer-link inline-flex text-sm font-semibold">{w.answer}</summary>
                <form action="/api/store/course/comment" method="post" className="mt-2 space-y-3">
                  <Fields where={hidden} action="post" />
                  <input type="hidden" name="parent" value={comment.id} />
                  <NameField show={!creator && !myName} w={w} placeholder={namePlaceholder} />
                  <label className="block">
                    <span className="sr-only">{w.answerTo(comment.by === CREATOR_AUTHOR ? storeName : comment.name)}</span>
                    <textarea className="st-field" name="text" rows={2} required maxLength={MAX_LESSON_COMMENT} />
                  </label>
                  <button type="submit" className="btn st-btn">{w.postAnswer}</button>
                </form>
              </details>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="st-muted mt-6 text-sm">{w.noComments}</p>
      )}
    </section>
  );
}
