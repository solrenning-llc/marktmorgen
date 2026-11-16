/**
 * Comments under a course's lessons, as rules the browser can read too. The
 * part that keeps them is lib/lesson-comments.ts.
 *
 * Who may write: a student of the course, on a lesson that is open to them,
 * and the creator. A visitor looking at a free preview reads nothing and
 * writes nothing: what students say to each other stays among the people who
 * paid for the course.
 *
 * What others see: the name the student chose the first time they wrote,
 * never their email address. The creator's words are shown under the store's
 * name, marked as the creator's.
 *
 * What the creator can do: answer from the lesson itself or from the studio,
 * hide a comment (the student who wrote it still sees it, marked hidden, and
 * nobody else does), delete one, and switch comments off for a course, which
 * hides them all and closes the box without deleting anything.
 */

/** The longest comment. */
export const MAX_LESSON_COMMENT = 2_000;
/** The longest name a student shows under their comments. */
export const MAX_COMMENTER_NAME = 40;
/** Comments one person may write in a minute, and in a day, on one store. */
export const COMMENTS_PER_MINUTE = 5;
export const COMMENTS_PER_DAY = 60;
/** Answers one comment may gather. */
export const MAX_REPLIES = 50;
/** Comments a lesson keeps; past it, the oldest thread goes first. */
export const MAX_LESSON_THREADS = 500;
/** Threads a lesson page shows, newest first. */
export const SHOWN_THREADS = 100;

/** Who wrote a comment: the creator, or a student by the key of their address. */
export const CREATOR_AUTHOR = "creator";

export type LessonComment = {
  id: string;
  lesson: string;
  /** CREATOR_AUTHOR, or the student's emailKey. */
  by: string;
  /** The name shown: the student's chosen one. Empty for the creator, who is shown as the store. */
  name: string;
  text: string;
  /** Seconds. */
  at: number;
  /** The comment this answers, or null for the start of a thread. */
  parent: string | null;
  hidden: boolean;
};

export type Thread = { comment: LessonComment; replies: LessonComment[] };

export const COMMENT_ID_PATTERN = /^[a-z0-9]{12}$/;

/** Reads one kept comment, or null when it is not one. */
export function parseComment(raw: unknown): LessonComment | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (!Object.hasOwn(v, "id") || typeof v.id !== "string" || !COMMENT_ID_PATTERN.test(v.id)) return null;
    if (!Object.hasOwn(v, "l") || typeof v.l !== "string") return null;
    if (!Object.hasOwn(v, "b") || typeof v.b !== "string") return null;
    if (!Object.hasOwn(v, "t") || typeof v.t !== "string") return null;
    if (!Object.hasOwn(v, "a") || typeof v.a !== "number" || !Number.isSafeInteger(v.a) || v.a < 0) return null;
    if (Object.hasOwn(v, "n") && typeof v.n !== "string") return null;
    if (Object.hasOwn(v, "r") && v.r !== null && (typeof v.r !== "string" || !COMMENT_ID_PATTERN.test(v.r))) return null;
    if (Object.hasOwn(v, "h") && typeof v.h !== "boolean") return null;
    return {
      id: v.id,
      lesson: v.l,
      by: v.b,
      name: typeof v.n === "string" ? v.n : "",
      text: v.t,
      at: v.a,
      parent: typeof v.r === "string" && COMMENT_ID_PATTERN.test(v.r) ? v.r : null,
      hidden: v.h === true,
    };
  } catch {
    return null;
  }
}

export function serializeComment(c: LessonComment): string {
  return JSON.stringify({ id: c.id, l: c.lesson, b: c.by, n: c.name, t: c.text, a: c.at, r: c.parent, h: c.hidden || undefined });
}

/**
 * What a given reader sees, as threads: newest thread first, answers in the
 * order they were written. A hidden comment is shown only to the creator and
 * to whoever wrote it; answers under a hidden comment go with it.
 */
export function threadsFor(comments: LessonComment[], reader: string): Thread[] {
  const visible = (c: LessonComment) => !c.hidden || reader === CREATOR_AUTHOR || c.by === reader;
  const tops = comments.filter((c) => c.parent === null && visible(c)).sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  const byParent = new Map<string, LessonComment[]>();
  for (const c of comments) {
    if (c.parent === null || !visible(c)) continue;
    const list = byParent.get(c.parent) ?? [];
    list.push(c);
    byParent.set(c.parent, list);
  }
  return tops.map((comment) => ({
    comment,
    replies: (byParent.get(comment.id) ?? []).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)),
  }));
}

/** How many comments a reader sees in these threads. */
export function countShown(threads: Thread[]): number {
  return threads.reduce((sum, t) => sum + 1 + t.replies.length, 0);
}

/** Now, in seconds, for the pages that say how long ago a comment was written. */
export function commentClock(): number {
  return Math.floor(Date.now() / 1000);
}
