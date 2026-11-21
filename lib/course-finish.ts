/**
 * A student finishing a course (added 12 October 2026): the moment the last
 * lesson of it is marked done, by a button, a quiz passed or work approved.
 *
 * It is the best moment a course has to offer the next thing — Kajabi and
 * Teachable both start automations on it — and until now nothing happened
 * then. Now the sequences that start "when someone finishes" a course
 * (lib/flows.ts, trigger "finished") start for that student, if they agreed
 * to hear from the creator; nobody else is written to.
 *
 * A student finishes once: a flag kept for 400 days says it happened, so a
 * lesson marked undone and done again does not start anything twice.
 *
 * Opening a course for the first time (added 17 October 2026) starts the
 * sequences that start "when someone opens" it, in the same way and once,
 * which is the welcome into a course that Kajabi and Teachable send.
 *
 * Reaching a share of it (287 [H4-1], added 12 November 2026): each lesson
 * marked done also starts the sequences that start "when someone has done N%
 * of" the course, for every N at or below the whole percent of its lessons
 * now done. Each sequence starts a person once (lib/flows.ts, startFlows).
 * The store's sequences are read only when the student passes a step of
 * REACHED_SHARE_STEP they had not passed before (the highest is kept), and
 * that read takes one more of the store's buyer actions first: at most 19
 * reads a student and course, and a lesson undone and done again reads
 * nothing (independent review, 12 November 2026).
 *
 *   nl:course:<courseId>:fin:<student>    pending owner, 60 seconds; confirmed "1", 400 days
 *   nl:course:<courseId>:open:<student>   "1", 400 days
 *   nl:course:<courseId>:reach:<student>  the highest step passed, 400 days
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { doneLessons, emailKey } from "@/lib/learn";
import { lessonsInOrder, readCourse } from "@/lib/course";
import { enroll, enrollOrThrow } from "@/lib/flows";
import { MIN_REACHED_SHARE, REACHED_SHARE_STEP, reachedShare } from "@/lib/flow-rules";
import { takeBuyerAction } from "@/lib/buyer-actions";
import { exactReplies, UnknownReply } from "@/lib/redis-exact";
import type { Store } from "@/lib/store";
import { FINISH_KEEP_SECONDS } from "@/lib/course-finish-rules";
import { claimValue, releaseMark } from "@/lib/claim-mark";
import { REDIS_TIMEOUT_MS, withCutoff } from "@/lib/fetch-timeout";
import { suppressedAtCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";

export { FINISH_KEEP_SECONDS };

// A pending attempt is a lease, not the 400-day record of a confirmed event. Network work ends a full Redis
// timeout before its lease can expire; failed cleanup is then bounded, and a late owner cannot confirm another's.
const FINISH_PENDING_SECONDS = 60;
const CONFIRM_FINISH = '-- marktmorgen:course-finish-confirm:v1\nif redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end\nredis.call("SET", KEYS[1], "1", "EX", ARGV[2])\nreturn 1';
/**
 * A share mark written after its sequences started (Codex X6's LOW on #3989), in one step: never lowered (a view that
 * read 25 and reached 50 does not land over a 75 another view wrote meanwhile) and never written back after the
 * student's erasure (a mark the read saw that is gone now, or a deletion print that changed since the read). Returns 1
 * when it wrote, 0 otherwise.
 *
 *   KEYS[1] the share mark, KEYS[2] the store's deletion prints (only with a list)
 *   ARGV[1] the step, ARGV[2] the mark as read ("" for none), ARGV[3] seconds kept, ARGV[4] the print's field, ARGV[5]
 *   the print as read ("" for none)
 */
const RAISE_REACHED = '-- marktmorgen:course-reach-raise:v1\nlocal cur = redis.call("GET", KEYS[1])\nif cur and tonumber(cur) and tonumber(cur) >= tonumber(ARGV[1]) then return 0 end\nif not cur and ARGV[2] ~= "" then return 0 end\nif #KEYS == 2 and (redis.call("HGET", KEYS[2], ARGV[4]) or "") ~= ARGV[5] then return 0 end\nredis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3])\nreturn 1';

const finishedKeyOf = (courseId: string, learner: string) => `nl:course:${courseId}:fin:${learner}`;
const openedKeyOf = (courseId: string, learner: string) => `nl:course:${courseId}:open:${learner}`;
const reachedKeyOf = (courseId: string, learner: string) => `nl:course:${courseId}:reach:${learner}`;
const finishedKey = (courseId: string, email: string) => finishedKeyOf(courseId, emailKey(email));
const openedKey = (courseId: string, email: string) => openedKeyOf(courseId, emailKey(email));
const reachedKey = (courseId: string, email: string) => reachedKeyOf(courseId, emailKey(email));
/**
 * Two of a dropped course's probes (lib/person-erasure.ts). A start, finish, or progress mark can outlive the
 * student row. One EXISTS counts both the finish and progress keys to preserve the fixed command count.
 */
export const finishMarkProbes = (courseId: string, learner: string): (string | number)[][] => [
  ["EXISTS", openedKeyOf(courseId, learner)],
  ["EXISTS", finishedKeyOf(courseId, learner), reachedKeyOf(courseId, learner)],
];

/**
 * Starts what a share of the course starts, when the student has passed a step they had not passed before: the
 * highest step passed is kept, and one more of the store's buyer actions is taken before the store's sequences are
 * read. A kept step that cannot be read is unknown: nothing is read or started on a guess (rule 24).
 */
async function noteReached(store: Store, productId: string, courseId: string, email: string, share: number): Promise<void> {
  const step = Math.floor(share / REACHED_SHARE_STEP) * REACHED_SHARE_STEP;
  if (step < MIN_REACHED_SHARE) return;
  const mark = reachedKey(courseId, email);
  // The mark and, in the same read, the store's deletion print for this address (lib/suppression.ts): the write below
  // compares both, so an erasure in between is never undone (Codex X6's LOW on #3989).
  const listId = store.listId;
  const read = exactReplies(await redisPipeline([["GET", mark], ...(listId ? [suppressedAtCommand(listId, email)] : [])]), listId ? 2 : 1, "the course share a student reached");
  const kept = read[0];
  const before = kept === null ? 0 : typeof kept === "string" && /^\d{1,3}$/.test(kept) ? Number(kept) : NaN;
  if (!Number.isFinite(before) || step <= before) return;
  const print = listId ? read[1] : null;
  if (print !== null && typeof print !== "string" && typeof print !== "number") throw new UnknownReply("the deletion print of a student");
  if (!(await takeBuyerAction(store))) return;
  // Started first, and the share written down only once that is known (Codex X5's MEDIUM on #3989): a start that
  // failed leaves the mark where it was, so the next lesson view tries again (each start is still claimed once).
  await enrollOrThrow(store, email, { joined: false, reached: { productId, share } });
  // Raised only, and only while the student is not erased since the read: one step (RAISE_REACHED).
  const keys = listId ? [mark, suppressedKey(listId)] : [mark];
  await redisPipeline([["EVAL", RAISE_REACHED, keys.length, ...keys, String(step), kept === null ? "" : String(kept), FINISH_KEEP_SECONDS, listId ? suppressionPrint(listId, email) : "", print === null ? "" : String(print)]]);
}

/** How long a moment's mark lives once its sequences started: a student opens and finishes a course once. */
const KEPT_SECONDS = FINISH_KEEP_SECONDS;
/**
 * How long a mark lives while its sequences are being started. It becomes KEPT_SECONDS only once enroll went through,
 * so a start that failed and whose cleanup DEL was lost or answered in an unknown shape holds the moment for an hour
 * at the most, never 400 days (Codex G and X5 on #4301). Starting again after it is safe: a start is claimed per
 * person and sequence (lib/flows.ts startFlows).
 */
const CLAIM_SECONDS = 3_600;

/**
 * Takes a moment's mark for this invocation, starts its sequences and keeps the mark for good only when they started.
 * When starting failed, the mark goes; if that DEL is not confirmed, the short claim lets the mark lapse within the hour.
 */
async function claimAndStart(key: string, start: () => Promise<boolean>): Promise<boolean> {
  const claim = await redisPipeline([["SET", key, "1", "NX", "EX", CLAIM_SECONDS]]);
  if (!confirmedClaim(claim)) return false;
  // Starting the sequences failed on its way (enroll logged it): the mark goes, so the moment can start them when it
  // comes again; a start is claimed per person and sequence, never twice (lib/flows.ts startFlows).
  if (!(await start())) {
    await redisPipeline([["DEL", key]]);
    return false;
  }
  // The sequences started: the mark is kept 400 days. An unconfirmed reply leaves the hour-long claim, after which the
  // same moment finds every sequence already claimed for this person and starts nothing twice.
  await redisPipeline([["EXPIRE", key, KEPT_SECONDS]]);
  return true;
}

/** Only a complete, own acknowledgement confirms this invocation took the claim. */
function confirmedClaim(reply: unknown): boolean {
  if (!Array.isArray(reply) || reply.length !== 1) return false;
  const slot = Object.getOwnPropertyDescriptor(reply, "0");
  return slot !== undefined && Object.hasOwn(slot, "value") && slot.value === "OK";
}

/**
 * After a student opens a course: the first time, starts what opening it
 * starts (lib/flows.ts, trigger "started"). Never throws: opening a lesson
 * must never fail on what comes after it.
 */
export async function noteIfOpened(store: Store, productId: string, courseId: string, email: string): Promise<boolean> {
  try {
    if (!email || !isRedisConfigured()) return false;
    return await claimAndStart(openedKey(courseId, email), () => enroll(store, email, { joined: false, started: productId }));
  } catch (error) {
    console.error("noting an opened course failed", error);
    return false;
  }
}

/**
 * After a lesson is marked done: whether that finished the course for this
 * student, the first time, and if so starts what finishing starts. Never
 * throws: a lesson marked done must never fail on what comes after it.
 */
export async function noteIfFinished(store: Store, productId: string, courseId: string, email: string): Promise<boolean> {
  try {
    if (!email || !isRedisConfigured()) return false;
    const course = await readCourse(courseId);
    const lessons = course ? lessonsInOrder(course).map(({ lesson }) => lesson.id) : [];
    if (!lessons.length) return false;
    const done = await doneLessons(courseId, email);
    const share = reachedShare(lessons.filter((id) => done.has(id)).length, lessons.length);
    if (!lessons.every((id) => done.has(id))) {
      // Partway through: what starts at the share now reached (287 [H4-1]), read only past a new step.
      await noteReached(store, productId, courseId, email, share);
      return false;
    }
    const key = finishedKey(courseId, email), token = claimValue();
    const cutoff = Date.now() + FINISH_PENDING_SECONDS * 1_000 - REDIS_TIMEOUT_MS;
    const claim = await redisPipeline([["SET", key, token, "NX", "EX", FINISH_PENDING_SECONDS]]);
    if (!confirmedClaim(claim)) return false;
    // Finishing is also every share reached, for a student who got here without one starting (one read of the sequences for both).
    try {
      await withCutoff(cutoff, () => enrollOrThrow(store, email, { joined: false, finished: productId, reached: { productId, share } }));
      // Only our still-live attempt can become the durable mark. Erasing it, or a newer attempt taking it,
      // cannot be undone by this completion; an unknown acknowledgement is never treated as confirmation.
      const [confirmed] = exactReplies(await redisPipeline([["EVAL", CONFIRM_FINISH, 1, key, token, FINISH_KEEP_SECONDS]]), 1, "the confirmed course finish");
      if (confirmed !== 1) return false;
    } catch (error) {
      // Not known to have started: the claim is let go so the next view tries again (Codex X5 on #3989); a start that
      // did land is not made twice, each being claimed once per sequence.
      await releaseMark(key, token);
      throw error;
    }
    return true;
  } catch (error) {
    console.error("noting a finished course failed", error);
    return false;
  }
}

/** Forgets the marks that one person opened, finished and got partway through these courses (lib/person-erasure.ts). */
export async function forgetFinishPerson(courseIds: string[], email: string): Promise<number> {
  if (!courseIds.length || !isRedisConfigured()) return 0;
  const what = "the deletion of a person's course opening, finishing and progress marks";
  const keys = [...new Set(courseIds.flatMap((courseId) => [finishedKey(courseId, email), openedKey(courseId, email), reachedKey(courseId, email)]))];
  const [gone] = exactReplies(
    await redisPipeline([["DEL", ...keys]]),
    1,
    what,
  );
  if (typeof gone !== "number" || !Number.isSafeInteger(gone) || gone < 0 || gone > keys.length) throw new UnknownReply(what);
  return gone;
}
