/**
 * The sweep of pictures attached to nothing (507 [SG3], unit 3; security
 * finding MM-SA-08): which of a store's pictures get a notice to the creator,
 * and which are taken away after it.
 *
 * The owner's decision: pictures attached to nothing are swept after a safe
 * wait, with a notice to the creator first, never one in use. So a picture is
 * noticed only after UNATTACHED_DAYS attached to nothing, and swept only
 * NOTICE_DAYS after its notice, if it is still attached to nothing then. One
 * used again in between is kept and its notice dropped.
 *
 * What is "in use" is the caller's reading, and it must count every place a
 * picture can be seen: a product, a link, a page's blocks, an email kept or
 * already sent (a sent email still shows it in the reader's inbox) and a
 * review. Any reading that is unknown (the pictures, what is in use or the
 * notices) gives "unknown": no notice and no sweep (rule 24). An added time or
 * a notice that cannot be read (or is at time 0, a missing notice read as a
 * number) keeps the picture, and so does a picture listed twice with two added
 * times. Only a picture's own place,
 * images/<folder>/<name>, is ever named, and a run names at most
 * MAX_SWEEP_PER_RUN of each, so its cost is bounded.
 *
 * Off: PICTURE_SWEEP_ON is false and nothing reads these rules yet. The run,
 * the notice email and its cost line come in their own units. Client-safe.
 */

/** Off until the owner confirms the sweep: nothing is noticed or taken away. */
export const PICTURE_SWEEP_ON = false;

/** Days a picture is attached to nothing before the creator is told. */
export const UNATTACHED_DAYS = 30;

/** Days after the notice before a picture still attached to nothing is taken away. */
export const NOTICE_DAYS = 14;

/** The most pictures one run notices, and the most it takes away. */
export const MAX_SWEEP_PER_RUN = 100;

const DAY_SECONDS = 86_400;

/** A picture's own place: images/<folder>/<name>, one level, no "..". */
const PICTURE_PATH = /^images\/[A-Za-z0-9_-]+\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export type PictureSeen = { path: string; addedAt: number };

export type SweepPlan =
  | {
      /** Pictures attached to nothing long enough: tell the creator, and keep the time told. */
      notice: string[];
      /** Pictures still attached to nothing NOTICE_DAYS after their notice: take them away. */
      sweep: string[];
      /** Pictures with a notice that are in use again: forget the notice. */
      clearNotice: string[];
    }
  | "unknown";

const readable = (seconds: number, now: number) => Number.isFinite(seconds) && seconds >= 0 && seconds <= now;

/** What one run does, from times in seconds. */
export function sweepPlan(
  pictures: readonly PictureSeen[] | "unknown",
  used: ReadonlySet<string> | "unknown",
  noticedAt: ReadonlyMap<string, number> | "unknown",
  now: number,
): SweepPlan {
  if (pictures === "unknown" || used === "unknown" || noticedAt === "unknown" || !Number.isFinite(now)) return "unknown";
  const notice: string[] = [];
  const sweep: string[] = [];
  const clearNotice: string[] = [];
  // A picture listed twice must say the same added time; if not, the reading
  // disagrees and the picture is kept (independent review).
  const added = new Map<string, number | null>();
  for (const { path, addedAt } of pictures) {
    const before = added.get(path);
    added.set(path, before === undefined || Object.is(before, addedAt) ? addedAt : null);
  }
  for (const [path, addedAt] of added) {
    if (addedAt === null) continue;
    if (!PICTURE_PATH.test(path) || path.includes("..")) continue;
    const told = noticedAt.get(path);
    if (used.has(path)) {
      if (told !== undefined) clearNotice.push(path);
      continue;
    }
    if (!readable(addedAt, now) || now - addedAt < UNATTACHED_DAYS * DAY_SECONDS) continue;
    if (told === undefined) {
      if (notice.length < MAX_SWEEP_PER_RUN) notice.push(path);
      continue;
    }
    if (!readable(told, now) || told === 0 || now - told < NOTICE_DAYS * DAY_SECONDS) continue;
    if (sweep.length < MAX_SWEEP_PER_RUN) sweep.push(path);
  }
  return { notice, sweep, clearNotice };
}
