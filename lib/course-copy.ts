/**
 * Copying one of a store's own courses into a new, empty one (294 [SQ5],
 * unit 1): the steps, in their order, on the server. The rules, what comes
 * across and what it counts are in lib/course-copy-rules.ts.
 *
 * Run by the course route under the new course's lock
 * (app/api/store/course/route.ts, action "copy"):
 *
 *   1. the new course must be exactly as it was made (templateFits), and the
 *      other one another product: checked on what is already read;
 *   2. COPY_READ_UNITS studio requests are taken, then the other course's
 *      listing and record are read (refused: nothing is read);
 *   3. copyWriteUnits for its lessons with text are taken, then that text is
 *      read (refused: nothing is written);
 *   4. the product is taken off the store, so a buyer never meets a course
 *      whose videos are still to be added;
 *   5. each lesson's text is written, then the outline that points at it.
 *
 * Nothing is left half-done: when a write fails (the data room is full, the
 * database does not answer), the texts already written are taken away again,
 * the product goes back on the store if it was on it, and the course stays as
 * it was made.
 */
import { type Course, readBodies, readCourse, saveBody, dropBody } from "@/lib/course";
import { readListing } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { takeAllowance } from "@/lib/store-allowance";
import { templateFits } from "@/lib/course-templates";
import { COPY_READ_UNITS, type CopyLeft, copyCourse, copyWriteUnits, withTexts } from "@/lib/course-copy-rules";

export type CopyRefusal = "same" | "unknown" | "not_course" | "not_new" | "studio_used" | "unavailable";

export type CopyDone =
  | { ok: true; course: Course; left: CopyLeft; units: number }
  | { ok: false; error: CopyRefusal; status: number; message?: string };

/** What the route gives the copy to do on the store: take the product off it, and save the outline as every edit is saved. */
export type CopySteps = {
  /** Takes the product off the store; null when it could not, or how to put it back as it was. */
  hide: () => Promise<{ undo: () => Promise<void> } | null>;
  save: (next: Course) => Promise<void>;
};

/** Studio requests taken, or why not, in the route's words. */
async function take(store: Store, units: number): Promise<CopyDone | null> {
  const taken = await takeAllowance(store, "studio", units);
  if (taken.ok) return null;
  return taken.reason === "unknown"
    ? { ok: false, error: "unavailable", status: 503, message: taken.message }
    : { ok: false, error: "studio_used", status: 429, message: taken.message };
}

export async function copyCourseInto(store: Store, productId: string, target: Course, fromId: string, steps: CopySteps): Promise<CopyDone> {
  if (!fromId) return { ok: false, error: "unknown", status: 400 };
  if (fromId === productId) return { ok: false, error: "same", status: 400 };
  if (!templateFits(target).ok) return { ok: false, error: "not_new", status: 409 };

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
  const texts = copy.texts.length ? await readBodies(source.id, copy.texts.map((t) => t.from)) : {};

  const hidden = await steps.hide();
  if (!hidden) return { ok: false, error: "unknown", status: 400 };

  const written = new Set<string>();
  try {
    for (const { from, to } of copy.texts) {
      const text = texts[from] ?? "";
      if (!text) continue;
      await saveBody(target.id, to, text, store);
      written.add(to);
    }
    const course = withTexts(copy.course, written);
    await steps.save(course);
    return { ok: true, course, left: copy.left, units: COPY_READ_UNITS + writeUnits };
  } catch (error) {
    // The outline was not saved, so nothing points at these texts: they go, and their room comes back.
    for (const to of written) await dropBody(target.id, to, store).catch(() => {});
    // And the product is put back on the store as it was: the course is as it was made.
    await hidden.undo().catch(() => {});
    throw error;
  }
}
