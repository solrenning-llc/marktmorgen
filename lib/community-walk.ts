/**
 * Putting what a community already holds into the search index, once.
 *
 * Everything written before the index reached past posts — every lesson, every
 * event, every person in the directory — is invisible to a search that only
 * knows what it was told about as it happened. A creator should not have to
 * press a button to make their own archive findable, and a member should not
 * meet an empty tab and conclude the feature does not work.
 *
 * So this walks each community once, the first time somebody searches in it.
 *
 * It sits on its own because it reads from everywhere: the catalog for the
 * courses, the calendar for the events, the directory for the people. Nothing
 * imports it, which is what lets it import all of them — lib/community-index.ts
 * stays the leaf that the saving paths call into, and the two never meet.
 */
import type { Store } from "@/lib/store";
import { idsOfKind, readProducts } from "@/lib/catalog";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Member, directory } from "@/lib/community";
import { allEvents } from "@/lib/community-events";
import { communityOf, indexCourseOf, indexEvent, indexMember } from "@/lib/community-index";

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
/** How long one walk may hold the community before another may try. Seconds. */
const WALK_SECONDS = 120;
/**
 * As many listed members as one walk indexes. A community past this has its
 * newest members findable and its oldest not, which is the right way round:
 * somebody looking for a person is nearly always looking for a recent one, and
 * every member indexes themselves the next time they change anything anyway.
 */
const WALK_MEMBERS = 5_000;

/**
 * Whether this community still needs its one-time walk. One read.
 */
export async function needsWalk(communityId: string): Promise<boolean> {
  const [mark] = await redisPipeline([["GET", markKey(communityId)]]);
  return mark !== INDEX_VERSION;
}

/**
 * Walks a community once, putting its lessons, events and listed members into
 * the search index.
 *
 * Guarded two ways: a marker, so it happens once ever, and a lock that lets go
 * of itself, so two people searching at the same minute do not both walk. The
 * marker is written only after the walk finishes, so a walk cut short by a
 * timeout is simply done again by the next search rather than leaving a
 * community half indexed and believing itself finished.
 */
export async function walkCommunity(store: Store): Promise<boolean> {
  const communityId = communityOf(store);
  if (!communityId || !isRedisConfigured()) return false;
  if (!(await needsWalk(communityId))) return false;
  const [held] = await redisPipeline([["SET", walkKey(communityId), "1", "NX", "EX", WALK_SECONDS]]);
  if (held === null) return false;

  try {
    // The courses sold with this store, each read once.
    const courseIds = idsOfKind(store, "course");
    const products = courseIds.length ? await readProducts(store, courseIds) : [];
    for (const product of products) await indexCourseOf(communityId, product).catch(() => {});

    // Everything on the calendar, over or not: a member searching for a talk
    // they went to in March should find it.
    for (const event of await allEvents(communityId).catch(() => [])) {
      await indexEvent(communityId, event).catch(() => {});
    }

    // Only the people who asked to be listed, which is the same rule the
    // directory itself goes by.
    let before: number | null = null;
    for (let read = 0; read < WALK_MEMBERS; ) {
      const page: { members: Member[]; next: number | null } = await directory(communityId, before, 200);
      if (!page.members.length) break;
      for (const member of page.members) await indexMember(communityId, member).catch(() => {});
      read += page.members.length;
      if (page.next === null) break;
      before = page.next;
    }

    await redisPipeline([["SET", markKey(communityId), INDEX_VERSION]]);
    return true;
  } finally {
    await redisPipeline([["DEL", walkKey(communityId)]]).catch(() => {});
  }
}
