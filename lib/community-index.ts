/**
 * Putting a community's lessons, events and people into the search index, and
 * taking them back out.
 *
 * Kept apart from lib/community-search.ts, which knows about words and sorted
 * sets and nothing else. This is the part that knows what a lesson is, where
 * its text lives, and what number puts it in the right place — the knowledge
 * that would otherwise be spread across the four routes that happen to save
 * these things.
 *
 * A leaf on purpose. The modules that save a course, an event or a member call
 * in here, so this one may not call back into them: it takes what it is given
 * and reads only the course bodies, which nothing in a community owns. The
 * one-time walk over what already exists needs to read from everywhere, so it
 * lives in lib/community-walk.ts, which nothing else imports.
 *
 * What each kind is found by, and what orders it:
 *
 *   lesson  its title and its written body, ordered by its place in the
 *           course, so results read in the order a student meets them. Its id
 *           in the index is "<product>.<lesson>", because the gate is on the
 *           product and the link needs both.
 *   event   its title and its description, ordered by when it starts.
 *   member  the name they chose and the handle others mention them by,
 *           ordered by when they came in.
 *
 * A lesson's video is not transcribed here, so what is inside a video is not
 * findable. Skool transcribes and makes the words of a video findable across
 * the whole group, which is the one thing its search does that this does not.
 * Saying so plainly beats letting a creator find out by searching for
 * something they said out loud.
 */
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";
import { type Course, lessonsInOrder, readBody, readCourse } from "@/lib/course";
import type { CommunityEvent } from "@/lib/community-events";
import type { Member } from "@/lib/community";
import { index, unindex } from "@/lib/community-search";

/**
 * A lesson's place, turned upside down so the first lesson of the first module
 * scores highest and so comes back first. A course past this many lessons has
 * its tail ordered together, which is a far better failure than a course whose
 * results run backwards.
 */
const LESSON_CEILING = 100_000;

/** How a lesson is named in the index: the product gates it, the lesson is it. */
export const lessonRef = (productId: string, lessonId: string) => `${productId}.${lessonId}`;

/** Reads one back, or null when it is not a shape this ever wrote. */
export function readLessonRef(ref: string): { productId: string; lessonId: string } | null {
  const at = ref.indexOf(".");
  if (at <= 0 || at === ref.length - 1) return null;
  return { productId: ref.slice(0, at), lessonId: ref.slice(at + 1) };
}

/**
 * Writes every lesson of one course into the index, and takes out the ones
 * that are no longer in it.
 *
 * Called after any change to a course's outline or to a lesson's text. Reading
 * every body is one pipeline of GETs, bounded by the number of lessons, and it
 * happens when a creator saves rather than when a member reads.
 */
export async function reindexCourse(communityId: string, product: Listing, course: Course): Promise<void> {
  const inOrder = lessonsInOrder(course);
  const bodies = await Promise.all(
    inOrder.map(({ lesson }) => readBody(course.id, lesson.id).catch(() => "")),
  );
  await Promise.all(
    inOrder.map(({ lesson, unit }, at) =>
      index(
        communityId,
        "lesson",
        lessonRef(product.id, lesson.id),
        LESSON_CEILING - at,
        // The module's title too: a lesson called "Part 3" under a module
        // called "Pricing" should be findable by the word pricing.
        [lesson.title, unit.title, product.title, bodies[at]],
      ).catch(() => {}),
    ),
  );
}

/** Takes one lesson out: it was deleted, or its course was. */
export async function unindexLesson(communityId: string, productId: string, lessonId: string): Promise<void> {
  await unindex(communityId, "lesson", lessonRef(productId, lessonId)).catch(() => {});
}

/** Takes a whole course out of the index: it was emptied, or its product went. */
export async function unindexCourse(communityId: string, productId: string, course: Course): Promise<void> {
  await Promise.all(
    lessonsInOrder(course).map(({ lesson }) => unindexLesson(communityId, productId, lesson.id)),
  );
}

/**
 * Keeps the index level with a course after a change, whatever the change was.
 *
 * Takes the lessons the course no longer holds out and writes the rest. The
 * caller passes what the course looked like before, when it has it; without
 * it, a deleted lesson would stay findable until something else rebuilt the
 * course, and a member would meet a result that opens nothing.
 */
export async function courseChanged(
  communityId: string,
  product: Listing,
  before: Course | null,
  after: Course,
): Promise<void> {
  if (before) {
    const kept = new Set(lessonsInOrder(after).map(({ lesson }) => lesson.id));
    await Promise.all(
      lessonsInOrder(before)
        .filter(({ lesson }) => !kept.has(lesson.id))
        .map(({ lesson }) => unindexLesson(communityId, product.id, lesson.id)),
    );
  }
  await reindexCourse(communityId, product, after);
}

export async function indexEvent(communityId: string, event: CommunityEvent): Promise<void> {
  await index(
    communityId,
    "event",
    event.id,
    Math.floor(event.start / 1000),
    [event.title, event.about],
  ).catch(() => {});
}

export async function unindexEvent(communityId: string, eventId: string): Promise<void> {
  await unindex(communityId, "event", eventId).catch(() => {});
}

/**
 * Writes a member into the index, or takes them out.
 *
 * Only somebody who asked to be in the directory is findable, which is the
 * same switch the directory itself reads and the same rule Circle applies to
 * its own member search. Somebody who has not chosen a name has nothing to be
 * found by, and somebody the creator removed is not there at all.
 */
export async function indexMember(communityId: string, member: Member): Promise<void> {
  const listed = member.dir && member.n && !member.removed;
  if (!listed) {
    await unindex(communityId, "member", member.k).catch(() => {});
    return;
  }
  await index(
    communityId,
    "member",
    member.k,
    // Already in seconds (lib/community.ts, now()). The first version divided
    // it by a thousand as if it were milliseconds, which kept the order but
    // tied everybody who came within the same quarter of an hour.
    member.at || 1,
    [member.n, member.h],
  ).catch(() => {});
}

export async function unindexMember(communityId: string, key: string): Promise<void> {
  await unindex(communityId, "member", key).catch(() => {});
}

/** A course read and indexed from the product alone, for the one-time backfill. */
export async function indexCourseOf(communityId: string, product: Listing): Promise<void> {
  if (!product.course) return;
  const course = await readCourse(product.course.id).catch(() => null);
  if (course) await reindexCourse(communityId, product, course);
}

/** Whether this store has a community to index anything into. */
export function communityOf(store: Store): string | null {
  return store.community?.id ?? null;
}
