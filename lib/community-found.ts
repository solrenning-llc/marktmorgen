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
 *   lesson  whether the reader holds the product the course is sold with,
 *           answered from the one reading of what they hold (holdingsOf)
 *   event   mayAttend, the same call the event's own page makes, from the
 *           same reading
 *
 * A match whose answer is not known (Stripe could not be read whole) is not
 * shown and not said to be in something the reader does not have: it is
 * counted apart (`unchecked`), and the page says so (CX-123 rule 24; the
 * pre-review of 9 November 2026, P4).
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
import { type Holdings, heldAnswer, holdingsOf, unknownForGood } from "@/lib/community-access";
import { readLessonRef } from "@/lib/community-index";

export type FoundLesson = {
  product: Listing;
  lessonId: string;
  title: string;
  /** The module it sits in, so a bare "Part 3" is not the whole of what is shown. */
  unit: string;
};

export type Viewer = {
  owner: boolean;
  email: string;
  key: string;
  /** What the reader holds, read once for the page (holdingsOf, with the lessons' products); read here when absent. */
  holdings?: Holdings | null;
};

/**
 * What a reader may be shown of some matches, how many could not be checked just now, and whether those will stay
 * unchecked however often they are asked (`lasting`: more purchases than are read), so the page points to the creator.
 */
export type Found<T> = { found: T[]; unchecked: number; lasting: boolean };

/**
 * The lessons among these refs that this reader holds, in the order the index
 * gave them, and how many could not be checked.
 *
 * One reading of what the reader holds answers every product, not one
 * question per product (holdingsOf, kept under the community's own version
 * exactly as the feed's gate is).
 */
export async function lessonsFound(
  store: Store,
  config: CommunityConfig,
  refs: string[],
  viewer: Viewer,
): Promise<Found<FoundLesson>> {
  const none = { found: [], unchecked: 0, lasting: false };
  const communityId = store.community?.id;
  if (!communityId || !refs.length) return none;
  const parsed = refs.map(readLessonRef).filter((r): r is { productId: string; lessonId: string } => r !== null);
  if (!parsed.length) return none;

  const productIds = [...new Set(parsed.map((r) => r.productId))];
  const products = new Map((await readListings(store, productIds)).map((p) => [p.id, p]));

  // Which of those products this reader holds. The creator holds all of them.
  const withCourse = productIds.filter((productId) => products.get(productId)?.course);
  const holdings = viewer.owner || !withCourse.length ? null : (viewer.holdings ?? (await holdingsOf(store, config, viewer.email, withCourse)));
  const allowed = new Set<string>();
  const unknown = new Set<string>();
  for (const productId of withCourse) {
    const answer = holdings ? heldAnswer(holdings, [productId]) : true;
    if (answer === true) allowed.add(productId);
    else if (answer === "unknown") unknown.add(productId);
  }
  const unchecked = parsed.filter((r) => unknown.has(r.productId)).length;
  const lasting = unchecked > 0 && unknownForGood(holdings);
  if (!allowed.size) return { found: [], unchecked, lasting };

  // The courses behind them, each read once, so a lesson can be named.
  const courseIds = [...allowed].flatMap((id) => {
    const course = products.get(id)?.course;
    return course ? [[id, course.id] as const] : [];
  });
  const courses = new Map<string, Course>();
  await Promise.all(
    courseIds.map(async ([productId, courseId]) => {
      const course = await readCourse(courseId).catch(() => null);
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
  return { found: out, unchecked, lasting };
}

/**
 * What became of an event, worked out here rather than on the page.
 *
 * The page is a server component and may not read a clock: judging "is this
 * over" belongs with the rest of the knowledge about events, which is in
 * lib/, where every other page already leaves it.
 */
export type FoundEvent = { event: CommunityEvent; state: "upcoming" | "over" | "cancelled" };

/** The events among these ids this reader may attend, in the index's order, and how many could not be checked. */
export async function eventsFound(
  store: Store,
  config: CommunityConfig,
  ids: string[],
  viewer: Viewer,
  now = Date.now(),
): Promise<Found<FoundEvent>> {
  const communityId = store.community?.id;
  if (!communityId || !ids.length) return { found: [], unchecked: 0, lasting: false };
  const events: CommunityEvent[] = await readEvents(communityId, ids).catch(() => []);
  const byId = new Map(events.map((e) => [e.id, e]));
  const kept: FoundEvent[] = [];
  let unchecked = 0;
  // One reading for every event of the page, read here only when the page has none.
  const holdings = viewer.owner ? null : (viewer.holdings ?? (await holdingsOf(store, config, viewer.email)));
  for (const id of ids) {
    const event = byId.get(id);
    if (!event) continue;
    const answer = await mayAttend(store, config, event, { owner: viewer.owner, email: viewer.email, holdings }).catch((): "unknown" => "unknown");
    if (answer === "unknown") unchecked += 1;
    if (answer !== true) continue;
    kept.push({ event, state: event.cancelled ? "cancelled" : isOver(event, now) ? "over" : "upcoming" });
  }
  return { found: kept, unchecked, lasting: unchecked > 0 && unknownForGood(holdings) };
}

/** The members among these keys who are still listed, in the index's order. */
export async function membersFound(communityId: string, keys: string[]): Promise<Member[]> {
  if (!keys.length) return [];
  const found = await readMembers(communityId, keys).catch(() => new Map<string, Member>());
  return keys
    .map((k) => found.get(k))
    .filter((m): m is Member => Boolean(m && m.dir && m.n && !m.removed));
}
