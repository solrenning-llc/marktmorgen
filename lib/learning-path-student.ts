/**
 * What a student has and what they finished, for a learning path (249 [ST2],
 * unit 4a), read from the same records a course page reads:
 *
 *   - the path's products, read exactly (readListingsExact): their titles,
 *     and which of them are courses;
 *   - had: the courses this address paid for (lib/learn.ts paidCourses,
 *     the ledger a course page opens on), within the courses this browser
 *     was let into (Learner.scope); the creator has every course;
 *   - finished: for each course had, every lesson done and every required
 *     quiz passed (lib/certificate.ts hasFinished), from the course's
 *     outline, the lessons done and the passes, each read exactly.
 *
 * Unknown is never "none" and never "finished" (rule 24): when what was paid
 * for does not read, `has` and `finished` are null; when an outline, the
 * lessons done or the passes do not read, `finished` is null. A product no
 * longer in the store is not had and has no title.
 *
 * It only reads, and reads at most what a course page reads for each course
 * of the path (MAX_PATH_COURSES): the caller takes the reading's cost before
 * calling it. Nothing here opens, locks or changes access to a course.
 */
import { readListingsExact } from "@/lib/catalog";
import { readCoursesExact } from "@/lib/course";
import { hasFinished } from "@/lib/certificate";
import { doneLessons, emailKey, paidCourses, type Learner } from "@/lib/learn";
import type { LearningPath } from "@/lib/learning-path-rules";
import { passedQuizzes } from "@/lib/quiz";
import type { Store } from "@/lib/store";

export type PathStudent = { has: Set<string> | null; finished: Set<string> | null; titles: Map<string, string> };

export async function pathStudent(store: Store, path: LearningPath, learner: Learner): Promise<PathStudent> {
  const titles = new Map<string, string>();
  const unknown = (): PathStudent => ({ has: null, finished: null, titles });
  // The path's products, by product id, with the course each holds.
  const courseOf = new Map<string, string>();
  try {
    const listings = await readListingsExact(store, path.courses);
    const byId = new Map(listings.map((listing) => [listing.id, listing]));
    for (const id of path.courses) {
      const listing = byId.get(id);
      if (!listing) continue;
      titles.set(id, listing.title);
      if (listing.course) courseOf.set(id, listing.course.id);
    }
  } catch {
    return unknown();
  }

  const has = new Set<string>();
  if (learner.owner) {
    for (const id of courseOf.keys()) has.add(id);
  } else {
    let paid: Map<string, number>;
    try {
      paid = await paidCourses(store, learner.email);
    } catch {
      return unknown();
    }
    for (const [id, courseId] of courseOf) {
      if (paid.has(id) && (learner.scope === "all" || learner.scope.includes(courseId))) has.add(id);
    }
  }

  const finished = new Set<string>();
  try {
    const owned = [...has];
    const outlines = await readCoursesExact(owned.map((id) => courseOf.get(id)!), "the courses of a learning path");
    const who = emailKey(learner.email);
    // Each course's lessons done and passes, all courses at once; any one that does not read throws.
    const each = await Promise.all(
      owned.map(async (id) => {
        const courseId = courseOf.get(id)!;
        const course = outlines.get(courseId);
        // A course record Redis confirms is not there is not finished; any reply that does not read threw above.
        if (!course) return false;
        const [done, passed] = await Promise.all([doneLessons(courseId, learner.email), passedQuizzes(courseId, who)]);
        return hasFinished(course, done, passed);
      }),
    );
    owned.forEach((id, i) => {
      if (each[i]) finished.add(id);
    });
  } catch {
    return { has, finished: null, titles };
  }
  return { has, finished, titles };
}
