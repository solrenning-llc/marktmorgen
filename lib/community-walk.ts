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
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { type Member, directory } from "@/lib/community";
import { allEvents, eventCount } from "@/lib/community-events";
import { communityOf, eventEntry, lessonBodies, lessonEntries, memberEntry } from "@/lib/community-index";
import { INDEXED_WORDS_BYTES, type SearchKind, indexWrites, indexedWords, unindexWrites } from "@/lib/community-search";
import { MAX_BODY_LENGTH, lessonsInOrder, readCourse } from "@/lib/course";
import { MAX_PRODUCT_BYTES } from "@/lib/catalog";
import { walkUnits } from "@/lib/community-read-rules";

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
 * What the walk reads, at the most, besides its commands: a course's record,
 * a lesson's body in any script, an event, a member.
 */
export const WALK_COURSE_BYTES = 512_000;
export const WALK_BODY_BYTES = MAX_BODY_LENGTH * 3;
export const WALK_EVENT_BYTES = 10_000;
export const WALK_MEMBER_BYTES = 2_000;
/** Things indexed per paid step. */
const WALK_BATCH = 50;
/** Members read per page of the directory. */
const WALK_PAGE = 200;

/** Takes `units` of the store's requests for the step about to run; false stops the walk. */
export type WalkPay = (units: number) => Promise<boolean>;

type Entry = { thing: string; score: number; parts: string[] };

/**
 * Indexes these things, a batch at a time: the words each is found by now
 * are read (paid first), the writes are counted from what was read and paid,
 * and then exactly those are sent. A write by anything else meanwhile changes
 * what this writes, never how much (Codex I, #2316: counted first and read
 * again later, a write in between was sent unpaid). A reply that cannot be
 * read, or a write that fails, stops the walk unmarked.
 */
async function indexPaid(communityId: string, kind: SearchKind, entries: (Entry | { thing: string; gone: true })[], pay: WalkPay): Promise<boolean> {
  for (let at = 0; at < entries.length; at += WALK_BATCH) {
    const batch = entries.slice(at, at + WALK_BATCH);
    if (!(await pay(walkUnits(batch.length, batch.length * INDEXED_WORDS_BYTES)))) return false;
    const before = await indexedWords(communityId, kind, batch.map((e) => e.thing));
    if (before === null) return false;
    // One holding more words than a read takes (writes at the same moment left it so) is not rewritten from part of
    // them: it stays as it is, findable, until the next write of it reads it whole (index).
    const writes = batch.map((e, i) => {
      const had = before[i];
      if (had === "over") return [];
      return "gone" in e ? unindexWrites(communityId, kind, e.thing, had) : indexWrites(communityId, kind, e.thing, e.score, e.parts, had);
    });
    const commands = writes.reduce((sum, w) => sum + w.length, 0);
    if (!commands) continue;
    if (!(await pay(walkUnits(commands, 0)))) return false;
    for (const w of writes) {
      if (!w.length) continue;
      const sent = await redisPipeline(w).then(() => true, () => false);
      if (!sent) return false;
    }
  }
  return true;
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
 *
 * Paid as it goes (4 November 2026, lib/community-read-rules.ts): every read and
 * every batch of writes takes the store's requests for what it will do,
 * through `pay`, before it does it; when one is refused the walk stops there,
 * unmarked, and the next search goes on with it, paying again.
 */
export async function walkCommunity(store: Store, pay: WalkPay): Promise<boolean> {
  const communityId = communityOf(store);
  if (!communityId || !isRedisConfigured()) return false;
  if (!(await needsWalk(communityId))) return false;
  // Read exactly (CX-123 rule 24): a lock held by another walk, or one that cannot be read, walks nothing now; the
  // next search walks.
  const mine = claimValue();
  if ((await claimMark(walkKey(communityId), WALK_SECONDS, mine)) !== "ours") return false;

  try {
    // The courses sold with this store, each read once.
    const courseIds = idsOfKind(store, "course");
    if (courseIds.length && !(await pay(walkUnits(courseIds.length, courseIds.length * MAX_PRODUCT_BYTES)))) return false;
    const products = courseIds.length ? await readProducts(store, courseIds) : [];
    for (const product of products) {
      if (!product.course) continue;
      if (!(await pay(walkUnits(1, WALK_COURSE_BYTES)))) return false;
      const course = await readCourse(product.course.id).catch(() => null);
      if (!course) continue;
      const lessons = lessonsInOrder(course).length;
      if (lessons && !(await pay(walkUnits(lessons, lessons * WALK_BODY_BYTES)))) return false;
      if (!(await indexPaid(communityId, "lesson", lessonEntries(product, course, await lessonBodies(course)), pay))) return false;
    }

    // Everything on the calendar, over or not: a member searching for a talk
    // they went to in March should find it.
    const events = await eventCount(communityId).catch(() => null);
    if (events === null) return false;
    if (events && !(await pay(walkUnits(2 + events, events * WALK_EVENT_BYTES)))) return false;
    const all = events ? await allEvents(communityId).catch(() => []) : [];
    if (!(await indexPaid(communityId, "event", all.map(eventEntry), pay))) return false;

    // Only the people who asked to be listed, which is the same rule the
    // directory itself goes by.
    let before: number | null = null;
    for (let read = 0; read < WALK_MEMBERS; ) {
      if (!(await pay(walkUnits(2, (WALK_PAGE + 1) * WALK_MEMBER_BYTES)))) return false;
      const page: { members: Member[]; next: number | null } = await directory(communityId, before, WALK_PAGE);
      if (!page.members.length) break;
      if (!(await indexPaid(communityId, "member", page.members.map((m) => memberEntry(m) ?? { thing: m.k, gone: true as const }), pay))) return false;
      read += page.members.length;
      if (page.next === null) break;
      before = page.next;
    }

    await redisPipeline([["SET", markKey(communityId), INDEX_VERSION]]);
    return true;
  } finally {
    // Only while it is still ours: a walk that outlasted its lock never deletes the lock of the walk that took it.
    await releaseMark(walkKey(communityId), mine);
  }
}
