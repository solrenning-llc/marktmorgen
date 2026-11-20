/**
 * Turning what the index found into what one person may actually be shown.
 *
 * The search index knows nothing about who is asking, and that is deliberate:
 * one index serves the creator and every member, and the door is asked about
 * afterward. This is that afterward, and it is the part where getting it
 * wrong would matter most — a lesson title is content. "Week 4: the $40k month
 * spreadsheet" tells somebody who never bought the course something they did
 * not pay for, and a search that leaked it would be worse than no search.
 *
 * So every kind goes through the very same gate its own page goes through, and
 * not a looser one written for here:
 *
 *   post    the feed's space gate, and the creator's hidden posts
 *   lesson  holdsAnyOf on the product the course is sold with — the same
 *           question the course page asks, cached under the same key
 *   event   mayAttend, the same call the event's own page makes
 *   member  the directory's own switch: listed, named, not removed
 *
 * The count of matches the tabs show comes from the index and so counts things
 * this reader may not see. That is on purpose and it is said plainly on the
 * page: the alternative is running the gate over every match of every kind to
 * draw four numbers, which for a member of a large community would mean asking
 * Stripe about products they have nothing to do with.
 */
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";
import { readListings } from "@/lib/catalog";
import { type Course, findLesson, readCourse } from "@/lib/course";
import { type CommunityConfig, type Member, readMembers } from "@/lib/community";
import { type CommunityEvent, isOver, mayAttend, readEvents } from "@/lib/community-events";
import { holdsAnyOf } from "@/lib/community-access";
import { readLessonRef } from "@/lib/community-index";

export type FoundLesson = {
  product: Listing;
  lessonId: string;
  title: string;
  /** The module it sits in, so a bare "Part 3" is not the whole of what is shown. */
  unit: string;
};

export type Viewer = { owner: boolean; email: string; key: string };

/**
 * The lessons among these refs that this reader holds, in the order the index
 * gave them.
 *
 * One `holdsAnyOf` per distinct product, not per lesson: five lessons of one
 * course is one question, and the answer is cached under the community's own
 * version exactly as the feed's gate is.
 */
export async function lessonsFound(
  store: Store,
  config: CommunityConfig,
  refs: string[],
  viewer: Viewer,
): Promise<FoundLesson[]> {
  const communityId = store.community?.id;
  if (!communityId || !refs.length) return [];
  const parsed = refs.map(readLessonRef).filter((r): r is { productId: string; lessonId: string } => r !== null);
  if (!parsed.length) return [];

  const productIds = [...new Set(parsed.map((r) => r.productId))];
  const products = new Map((await readListings(store, productIds)).map((p) => [p.id, p]));

  // Which of those products this reader holds. The creator holds all of them.
  const allowed = new Set<string>();
  await Promise.all(
    productIds.map(async (productId) => {
      const product = products.get(productId);
      if (!product?.course) return;
      if (viewer.owner) {
        allowed.add(productId);
        return;
      }
      const ok = await holdsAnyOf(
        store,
        [productId],
        viewer.email,
        `nl:cm:${communityId}:sg:${productId}:${viewer.key}`,
        String(config.v),
      ).catch((error) => { console.error("checking lesson access in community search failed", error); return false; });
      if (ok) allowed.add(productId);
    }),
  );
  if (!allowed.size) return [];

  // The courses behind them, each read once, so a lesson can be named.
  const courseIds = [...allowed].flatMap((id) => {
    const course = products.get(id)?.course;
    return course ? [[id, course.id] as const] : [];
  });
  const courses = new Map<string, Course>();
  await Promise.all(
    courseIds.map(async ([productId, courseId]) => {
      const course = await readCourse(courseId).catch((error) => { console.error("reading a course for community search failed", error); return null; });
      if (course) courses.set(productId, course);
    }),
  );

  const out: FoundLesson[] = [];
  for (const { productId, lessonId } of parsed) {
    if (!allowed.has(productId)) continue;
    const product = products.get(productId);
    const course = courses.get(productId);
    if (!product || !course) continue;
    const found = findLesson(course, lessonId);
    // A lesson the index still holds but the course no longer does is simply
    // passed over: the next save takes it out, and until then it opens nothing.
    if (!found) continue;
    out.push({ product, lessonId, title: found.lesson.title, unit: found.unit.title });
  }
  return out;
}

/**
 * What became of an event, worked out here rather than on the page.
 *
 * The page is a server component and may not read a clock: judging "is this
 * over" belongs with the rest of the knowledge about events, which is in
 * lib/, where every other page already leaves it.
 */
export type FoundEvent = { event: CommunityEvent; state: "upcoming" | "over" | "cancelled" };

/** The events among these ids this reader may attend, in the index's order. */
export async function eventsFound(
  store: Store,
  config: CommunityConfig,
  ids: string[],
  viewer: Viewer,
  now = Date.now(),
): Promise<FoundEvent[]> {
  const communityId = store.community?.id;
  if (!communityId || !ids.length) return [];
  const events: CommunityEvent[] = await readEvents(communityId, ids).catch((error) => { console.error("reading events for community search failed", error); return []; });
  const byId = new Map(events.map((e) => [e.id, e]));
  const kept: FoundEvent[] = [];
  for (const id of ids) {
    const event = byId.get(id);
    if (!event) continue;
    if (!(await mayAttend(store, config, event, viewer).catch((error) => { console.error("checking event access in community search failed", error); return false; }))) continue;
    kept.push({ event, state: event.cancelled ? "cancelled" : isOver(event, now) ? "over" : "upcoming" });
  }
  return kept;
}

/** The members among these keys who are still listed, in the index's order. */
export async function membersFound(communityId: string, keys: string[]): Promise<Member[]> {
  if (!keys.length) return [];
  const found = await readMembers(communityId, keys).catch((error) => { console.error("reading members for community search failed", error); return new Map<string, Member>(); });
  return keys
    .map((k) => found.get(k))
    .filter((m): m is Member => Boolean(m && m.dir && m.n && !m.removed));
}
