/**
 * Copying one of a store's own courses into a new, empty one (294 [SQ5],
 * unit 1): the steps, in their order, on the server. The rules, what comes
 * across and what it counts are in lib/course-copy-rules.ts.
 *
 * Run by the course route under the new course's lock
 * (app/api/store/course/route.ts, action "copy"):
 *
 *   1. the new course must be exactly as it was made (copyFits), the other
 *      one another product, and a product on the store needs the creator's
 *      yes: checked on what is already read, before anything is counted;
 *   2. COPY_READ_UNITS studio requests are taken, then the other course's
 *      listing and record are read (refused: nothing is read);
 *   3. copyWriteUnits for its lessons with text are taken, then that text is
 *      read (refused: nothing is written);
 *   4. in a store with a community, the exact writes that make the copied
 *      lessons findable in its search are worked out from that text and
 *      counted (refused: nothing is written, and the number it needs is
 *      said). They are sent here, never through the outline's general
 *      reindex (lib/community-index.ts courseChanged), which reads every text
 *      back and is not counted;
 *   5. the product is taken off the store, so a buyer never meets a course
 *      whose videos are still to be added;
 *   6. the outline is written without text, then each lesson's text, then
 *      the outline that says which have text, then the search. Every write
 *      first makes sure the course's lock is still this request's
 *      (holdLock), so a request held up past its lock never writes over a
 *      newer change.
 *
 * Nothing is left half-done when a write fails before the outline with text
 * is saved: every text that may have been written (counted before its SET,
 * so one whose answer was lost goes too) is taken away with its room, the
 * empty outline is written back, and the product goes back on the store if it
 * was on it. Once the outline with text is saved the copy stands: a search
 * write that fails is said, not undone.
 *
 * What a crash in the middle (the function stopped, no catch) can leave: the
 * outline without text is written first, so every text written after it
 * belongs to a lesson of that outline. Deleting the lesson or the course
 * deletes it and gives its room back (lib/course.ts dropBody, dropCourse); no
 * text is ever kept that no record points at. The course then shows the
 * lessons copied, some without their text, hidden from the store, and is not
 * in the search until a lesson is saved again.
 */
import { type Course, dropBody, lessonsInOrder, readBodies, readCourse, saveBody, saveCourse } from "@/lib/course";
import { type Listing, readListing } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { takeAllowance } from "@/lib/store-allowance";
import { type Held, LockBusyError, holdLock } from "@/lib/redis-lock";
import { redisPipeline } from "@/lib/redis";
import { lessonEntries } from "@/lib/community-index";
import { indexWrites } from "@/lib/community-search";
import {
  COPY_NOT_FINDABLE,
  COPY_READ_UNITS,
  type CopyLeft,
  copyCourse,
  copyFits,
  copyIndexUnits,
  copyWriteUnits,
  withTexts,
} from "@/lib/course-copy-rules";

export type CopyRefusal = "same" | "unknown" | "not_course" | "not_new" | "confirm" | "not_hidden" | "studio_used" | "index_used" | "unavailable";

export type CopyDone =
  | { ok: true; course: Course; left: CopyLeft; units: number; notes: string[] }
  | { ok: false; error: CopyRefusal; status: number; message?: string; needed?: number };

/** What the route gives the copy: the course's lock, the product, its community, and how to take it off the store. */
export type CopySteps = {
  held: Held;
  product: Listing;
  /** The store's community, whose search the lessons go into; null for none. */
  community: string | null;
  /** Whether the product is on the store now (not hidden): it then needs `confirmed`. */
  onStore: boolean;
  confirmed: boolean;
  /** Takes the product off the store; null when it could not, or how to put it back as it was. */
  hide: () => Promise<{ undo: () => Promise<void> } | null>;
};

/** Studio requests taken, or why not, in the route's words. */
async function take(store: Store, units: number, used: "studio_used" | "index_used" = "studio_used"): Promise<CopyDone | null> {
  const taken = await takeAllowance(store, "studio", units);
  if (taken.ok) return null;
  return taken.reason === "unknown"
    ? { ok: false, error: "unavailable", status: 503, message: taken.message }
    : { ok: false, error: used, status: 429, message: taken.message, ...(used === "index_used" ? { needed: units } : {}) };
}

/** The lock is still this request's, for a full term, or nothing more is written. */
async function stillOurs(held: Held): Promise<void> {
  if (!(await holdLock(held))) throw new LockBusyError();
}

export async function copyCourseInto(store: Store, productId: string, target: Course, fromId: string, steps: CopySteps): Promise<CopyDone> {
  if (!fromId) return { ok: false, error: "unknown", status: 400 };
  if (fromId === productId) return { ok: false, error: "same", status: 400 };
  if (!copyFits(target)) return { ok: false, error: "not_new", status: 409 };
  if (steps.onStore && !steps.confirmed) return { ok: false, error: "confirm", status: 409 };

  const refusedRead = await take(store, COPY_READ_UNITS);
  if (refusedRead) return refusedRead;
  const listing = await readListing(store, fromId);
  if (!listing) return { ok: false, error: "unknown", status: 404 };
  if (!listing.course) return { ok: false, error: "not_course", status: 400 };
  if (listing.course.id === target.id) return { ok: false, error: "same", status: 400 };
  const source = await readCourse(listing.course.id);
  if (!source) return { ok: false, error: "unknown", status: 404 };

  const copy = copyCourse(source, target);
  const writeUnits = copyWriteUnits(copy.texts.length);
  const refusedWrite = await take(store, writeUnits);
  if (refusedWrite) return refusedWrite;
  const read = copy.texts.length ? await readBodies(source.id, copy.texts.map((t) => t.from)) : {};
  const texts = copy.texts.flatMap(({ from, to }) => (read[from] ? [{ to, text: read[from] }] : []));
  const course = withTexts(copy.course, new Set(texts.map((t) => t.to)));

  // The search's writes, worked out now from the very texts written below, and counted before any write.
  let searchWrites: (string | number)[][][] = [];
  let searchUnits = 0;
  if (steps.community) {
    const byLesson = new Map(texts.map((t) => [t.to, t.text]));
    const community = steps.community;
    searchWrites = lessonEntries(steps.product, course, lessonsInOrder(course).map(({ lesson }) => byLesson.get(lesson.id) ?? "")).map((e) =>
      indexWrites(community, "lesson", e.thing, e.score, e.parts, []),
    );
    searchUnits = copyIndexUnits(searchWrites.flat());
    if (searchUnits) {
      const refusedSearch = await take(store, searchUnits, "index_used");
      if (refusedSearch) return refusedSearch;
    }
  }

  await stillOurs(steps.held);
  const hidden = await steps.hide();
  if (!hidden) return { ok: false, error: "not_hidden", status: 409 };

  // Counted before its SET: a text whose answer was lost may be there, and is taken back with the rest.
  const tried: string[] = [];
  try {
    await stillOurs(steps.held);
    await saveCourse(withTexts(course, new Set()), store);
    for (const { to, text } of texts) {
      await stillOurs(steps.held);
      tried.push(to);
      await saveBody(target.id, to, text, store);
    }
    await stillOurs(steps.held);
    await saveCourse(course, store);
  } catch (error) {
    for (const to of tried) await dropBody(target.id, to, store).catch(() => {});
    // The empty course back, and the product back on the store as it was: the course is as it was made.
    await saveCourse(target, store).catch(() => {});
    await hidden.undo().catch(() => {});
    throw error;
  }

  // The copy stands from here. A search write that fails is said; the lessons are findable once saved again.
  const notes: string[] = [];
  for (const writes of searchWrites) {
    if (!writes.length) continue;
    const sent = await redisPipeline(writes).then(() => true, () => false);
    if (!sent) {
      notes.push(COPY_NOT_FINDABLE);
      break;
    }
  }
  return { ok: true, course, left: copy.left, units: COPY_READ_UNITS + writeUnits + searchUnits, notes };
}
