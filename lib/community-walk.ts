/**
 * Putting what a community already holds into the search index, once.
 *
 * Everything written before the index reached past posts — every lesson, every
 * event, every person in the directory — is invisible to a search that only
 * knows what it was told about as it happened. A creator should not have to
 * press a button to make their own archive findable, and a member should not
 * meet an empty tab and conclude the feature does not work.
 *
 * So this walks each community once, a step at each search, starting the
 * first time somebody searches in it.
 *
 * A step at a time since 4 November 2026 (C4-4; owner's rule MR, a ceiling
 * before every spend): one lesson, one event or WALK_MEMBER_PAGE listed
 * members, never more, with where it stopped kept for the next search. The
 * whole walk at once had no bound a search could pay for — a store's every
 * course, two hundred lessons each — and one cut short by the time limit was
 * begun again from the start by the next search. The search page takes
 * WALK_STEP_UNITS of its window before each step (lib/read-ceilings.ts), and
 * leaves the walk where it is when there is no room for one.
 *
 * It sits on its own because it reads from everywhere: the catalog for the
 * courses, the calendar for the events, the directory for the people. Nothing
 * imports it but the search page, which is what lets it import all of them —
 * lib/community-index.ts stays the leaf that the saving paths call into, and
 * the two never meet.
 */
import type { Store } from "@/lib/store";
import { idsOfKind, readListings } from "@/lib/catalog";
import { readCourse } from "@/lib/course";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Member, directory } from "@/lib/community";
import { eventAt } from "@/lib/community-events";
import { communityOf, indexEvent, indexLessonAt, indexMember } from "@/lib/community-index";
import { WALK_MEMBER_PAGE } from "@/lib/read-ceilings";

/**
 * The version of this index's shape. A community whose marker is behind gets
 * walked once, and only once.
 *
 * Posts have been indexed since the search was built, so nothing here touches
 * them. What is caught up is everything the index reached past afterward:
 * lessons, events, and the people in the directory — none of which existed as
 * a searchable thing when they were written, and none of which any creator
 * should have to touch a button to make findable.
 */
// 3: members are rescored in seconds, as their joining time is kept, rather
// than the thousandths the first version divided it into. Every community is
// walked once more, which rewrites each listed member's place.
const INDEX_VERSION = "3";
const markKey = (id: string) => `nl:cm:${id}:sv`;
const walkKey = (id: string) => `nl:cm:${id}:swalk`;
/** Where the walk stopped: the version it is for, then the course and lesson, the event, or the members' place and count. */
const placeKey = (id: string) => `nl:cm:${id}:swat`;
/** How long one step may hold the community before another may try. Seconds. */
const WALK_SECONDS = 120;
/** How long a walk's place is kept between searches, after which it begins again. Seconds. */
const PLACE_SECONDS = 90 * 86_400;
/**
 * As many listed members as one walk indexes. A community past this has its
 * newest members findable and its oldest not, which is the right way round:
 * somebody looking for a person is nearly always looking for a recent one, and
 * every member indexes themselves the next time they change anything anyway.
 */
const WALK_MEMBERS = 5_000;

type Place =
  | { stage: "course"; course: number; lesson: number }
  | { stage: "event"; event: number }
  | { stage: "member"; before: number | null; read: number };

const START: Place = { stage: "course", course: 0, lesson: 0 };
const count = (raw: string | undefined) => (raw !== undefined && /^\d{1,7}$/.test(raw) ? Number(raw) : -1);

/** Reads a kept place; the start for anything not written by this version. */
export function readPlace(raw: unknown): Place {
  if (typeof raw !== "string") return START;
  const [version, stage, a, b] = raw.split("|");
  if (version !== INDEX_VERSION) return START;
  if (stage === "c" && count(a) >= 0 && count(b) >= 0) return { stage: "course", course: count(a), lesson: count(b) };
  if (stage === "e" && count(a) >= 0) return { stage: "event", event: count(a) };
  if (stage === "m" && count(b) >= 0 && (a === "-" || /^\d{1,12}$/.test(a ?? ""))) {
    return { stage: "member", before: a === "-" ? null : Number(a), read: count(b) };
  }
  return START;
}

function writePlace(place: Place): string {
  if (place.stage === "course") return `${INDEX_VERSION}|c|${place.course}|${place.lesson}`;
  if (place.stage === "event") return `${INDEX_VERSION}|e|${place.event}`;
  return `${INDEX_VERSION}|m|${place.before === null ? "-" : place.before}|${place.read}`;
}

/**
 * Whether this community still needs its one-time walk. One read.
 */
export async function needsWalk(communityId: string): Promise<boolean> {
  const [mark] = await redisPipeline([["GET", markKey(communityId)]]);
  return mark !== INDEX_VERSION;
}

/**
 * One step of the walk, from where the last one stopped: one lesson indexed,
 * one event, or WALK_MEMBER_PAGE members of the directory (lib/read-ceilings.ts,
 * WALK_STEP_SHAPE, is the most a step reads and writes). A course or a place
 * with nothing in it is a step that only moves on. The marker is written
 * once the last member is reached, so the walk happens once ever; a step cut
 * short is done again by the next search, and only that step.
 *
 * Guarded by a lock that lets go of itself, so two people searching at the
 * same minute do not both take the same step. True when a step was taken.
 */
export async function walkStep(store: Store): Promise<boolean> {
  const communityId = communityOf(store);
  if (!communityId || !isRedisConfigured()) return false;
  const [held] = await redisPipeline([["SET", walkKey(communityId), "1", "NX", "EX", WALK_SECONDS]]);
  if (held === null) return false;

  try {
    const [raw] = await redisPipeline([["GET", placeKey(communityId)]]);
    const place = readPlace(raw);
    let next: Place | "done";
    if (place.stage === "course") {
      // The courses sold with this store, one lesson at a time, in the order a student meets them.
      const courseIds = idsOfKind(store, "course");
      if (place.course >= courseIds.length) {
        next = { stage: "event", event: 0 };
      } else {
        const [product] = await readListings(store, [courseIds[place.course]]);
        const course = product?.course ? await readCourse(product.course.id).catch(() => null) : null;
        const indexed = product && course ? await indexLessonAt(communityId, product, course, place.lesson) : false;
        next = indexed ? { ...place, lesson: place.lesson + 1 } : { stage: "course", course: place.course + 1, lesson: 0 };
      }
    } else if (place.stage === "event") {
      // Everything on the calendar, over or not: a member searching for a talk
      // they went to in March should find it.
      const event = await eventAt(communityId, place.event).catch(() => null);
      if (event === undefined) {
        next = { stage: "member", before: null, read: 0 };
      } else {
        if (event) await indexEvent(communityId, event).catch(() => {});
        next = { stage: "event", event: place.event + 1 };
      }
    } else {
      // Only the people who asked to be listed, which is the same rule the
      // directory itself goes by.
      const page: { members: Member[]; next: number | null } = await directory(communityId, place.before, WALK_MEMBER_PAGE);
      for (const member of page.members) await indexMember(communityId, member).catch(() => {});
      const read = place.read + page.members.length;
      next = !page.members.length || page.next === null || read >= WALK_MEMBERS ? "done" : { stage: "member", before: page.next, read };
    }
    if (next === "done") {
      await redisPipeline([["SET", markKey(communityId), INDEX_VERSION], ["DEL", placeKey(communityId)]]);
    } else {
      await redisPipeline([["SET", placeKey(communityId), writePlace(next), "EX", PLACE_SECONDS]]);
    }
    return true;
  } finally {
    await redisPipeline([["DEL", walkKey(communityId)]]).catch(() => {});
  }
}
