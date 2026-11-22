import { del, head } from "@/lib/blob";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { essentialLimitState, type LimitState } from "@/lib/request-guard";

/**
 * Pictures let in through the picture door (app/api/store/image/upload) and
 * not put on anything yet.
 *
 * A picture's name is chosen by the browser and the routes that put one on a
 * product, a link or a page only check that it sits in the store's own picture
 * folder. That folder is shared by every picture of the store, so a name the
 * browser sends may be the picture of another product, link or page. When
 * putting one on fails, the file may be deleted only when this very request
 * took it from this list and the file was stored after the door wrote it down
 * (dropTakenPictures): the door notes each name it signs for, only while no
 * file has that name, and the first route that tries to put it on anything
 * takes it off, whether that succeeds or not. A picture already on something
 * was taken then (or signed before this list existed, and never written
 * down), so a failed request naming it deletes nothing. Unknown is kept: a
 * file left behind costs storage, a picture deleted from under a product
 * costs the creator's page.
 *
 * The same note is what lets a new name onto a record at all (4 November
 * 2026, after a review proved that a picture put on a second record was
 * deleted with it): a product's or a link's picture, and a page's new one,
 * must be taken from this list by the request that puts it on, or be that
 * record's own already. A name another record shows, a buyer's review photo
 * or an email's picture was never noted (or was taken when it was put on),
 * so it is refused there, and taking it off the second record later can
 * never delete it. A picture put on before this rule stays where it is shown
 * and can still be kept or replaced there.
 *
 * One list per store's picture folder, so one store's doors never fill
 * another's. Notes older than PICTURE_DOOR_SECONDS are dropped as new ones
 * come in, and the list itself expires a window after its last note; a stale
 * note is never taken, so its file is never deleted by a failure (it costs
 * storage, at most MAX_IMAGE_BYTES in lib/product-image.ts), never deleted
 * wrongly.
 *
 * Each door is a write to the file store, and a picture never put on anything
 * stays there, so the doors are capped before one is signed (owner rule MR: a
 * ceiling before every spend; rule 24 inventory A1, 8 November 2026): a store
 * already holding PICTURE_DOOR_MAX fresh notes is refused, counted exactly,
 * never by pushing its oldest out (which let the door open without end), and
 * a store's doors are counted by the hour (PICTURE_DOORS_PER_HOUR) before the
 * file store is asked. A count that cannot be read opens nothing.
 */
export const PICTURE_DOOR_SECONDS = 24 * 60 * 60;
/** The most fresh notes a store may hold, nothing taken yet: one more door is refused (PictureDoorFull), none pushed out. */
export const PICTURE_DOOR_MAX = 1_000;
/** The doors a store may open in an hour, counted before the file store is asked or anything is signed. */
export const PICTURE_DOORS_PER_HOUR = 200;

/** The store already holds PICTURE_DOOR_MAX fresh doors: nothing was noted, and the door is not opened. */
export class PictureDoorFull extends Error {
  constructor() {
    super("pictures_waiting");
    this.name = "PictureDoorFull";
  }
}

/** A picture's path is images/<folder>/<file>; its store's list is named by the folder. */
function doorsKey(path: string): string | null {
  const parts = path.split("/");
  return parts.length === 3 && parts[0] === "images" && /^[0-9a-f]{24}$/.test(parts[1]) ? `nl:pictures:doors:${parts[1]}` : null;
}

/**
 * Counts one door of this picture's store in the hour, before anything is asked of the file store: "within", or
 * "exceeded" past PICTURE_DOORS_PER_HOUR, or "unknown" when the count could not be read (lib/request-guard.ts,
 * essentialLimitState), which opens nothing. A count taken is spent, even when the door is refused later.
 */
export async function pictureDoorHour(path: string): Promise<LimitState> {
  const key = doorsKey(path);
  if (!key) return "unknown";
  return essentialLimitState("picture-door", key.slice("nl:pictures:doors:".length), PICTURE_DOORS_PER_HOUR, 60 * 60);
}

/**
 * Writes down a picture the door just signed for, in milliseconds; stale notes are dropped with it. False when it
 * could not be written or its count could not be read: such an upload could never be put on anything, so the door is
 * not opened for it. Throws PictureDoorFull, with nothing noted, when the store already held PICTURE_DOOR_MAX fresh
 * notes.
 */
export async function notePictureDoor(path: string, now = Date.now()): Promise<boolean> {
  const key = doorsKey(path);
  if (!key || !isRedisConfigured()) return false;
  const replies = repliesFor(await redisPipeline([
    ["ZREMRANGEBYSCORE", key, 0, now - PICTURE_DOOR_SECONDS * 1000],
    ["ZADD", key, now, path],
    ["ZCARD", key],
    ["EXPIRE", key, PICTURE_DOOR_SECONDS],
  ]), 4);
  // Noted only on its whole acknowledgement (Codex P on #2156): a count for the trim, 0 or 1 for the add, the list's
  // exact count, and 1 for the expiry the add made possible. Anything else is not a note, and the upload is not opened.
  if (!replies) return false;
  const [trimmed, added, held, expires] = replies.map(countOf);
  if (trimmed === null || (added !== 0 && added !== 1) || held === null || expires !== 1) return false;
  if (held <= PICTURE_DOOR_MAX) return true;
  // Past the cap with this one: it is taken back off (best effort; a note left on a name with no file deletes nothing
  // and goes with the day), and the door is refused.
  if (added === 1) await redisPipeline([["ZREM", key, path]]).catch(() => {});
  throw new PictureDoorFull();
}

/**
 * Takes each of these pictures off its store's list, and returns those this
 * call took, with when the door signed for each (ms): the ones let in through
 * the door within PICTURE_DOOR_SECONDS that nothing had tried to put on yet.
 * A stale note is taken off but not returned.
 *
 * When the take cannot be confirmed (the read or the removal failed, or its
 * answer was lost), this throws, and every caller refuses with server_error
 * before it writes or deletes anything (4 November 2026, after a review
 * proved that a swallowed failure here let a picture go on a product with
 * its note still on the list, so a later refused request naming it took the
 * note and deleted the product's picture). Nothing is written, so a note
 * still there is on a picture nothing shows, and the creator's retry finds
 * it; a removal that ran with its answer lost leaves a file nothing shows,
 * kept (storage, never a picture deleted from under a record).
 */
export async function takePictureDoor(paths: string[], now = Date.now()): Promise<Map<string, number>> {
  const unique = [...new Set(paths.filter((path) => typeof path === "string" && doorsKey(path) !== null))];
  const taken = new Map<string, number>();
  if (unique.length === 0 || !isRedisConfigured()) return taken;
  const answers = await redisPipeline(unique.flatMap((path) => {
    const key = doorsKey(path) as string;
    return [["ZSCORE", key, path], ["ZREM", key, path]];
  }));
  if (!Array.isArray(answers) || answers.length !== 2 * unique.length) throw new Error("could not confirm the pictures taken from the door");
  // Each reply only in its exact shape (CX-123, rule 24): ZREM the whole number 0 or 1, ZSCORE null or a score (a
  // number, or the numeric string the REST API sends). Anything else is unknown and throws, never "taken".
  unique.forEach((path, i) => {
    // Read exactly (Codex P on #2156): the score is absent (null) or a number Redis wrote, the removal an exact 0 or
    // 1; anything else is not a confirmed take, and throws as an unconfirmed take does.
    const score = answers[2 * i];
    const removed = countOf(answers[2 * i + 1]);
    if (removed !== 0 && removed !== 1) throw new UnknownReplyError("taking a picture from the door: ZREM");
    if (score !== null && !(typeof score === "number" || (typeof score === "string" && /^\d{1,16}(\.\d+)?$/.test(score)))) {
      throw new UnknownReplyError("taking a picture from the door: ZSCORE");
    }
    const at = score === null ? NaN : Number(score);
    const fresh = Number.isFinite(at) && at > 0 && at >= now - PICTURE_DOOR_SECONDS * 1000;
    if (removed === 1 && fresh) taken.set(path, at);
  });
  return taken;
}

/**
 * Deletes those of these pictures that this request took from the door and
 * that were stored strictly after the door noted them. The door notes a name
 * only while no file has it, and an upload can never write over a file; the
 * time read here is a second check that a file stored before its note (a door
 * asked again for somebody's picture) is kept. Anything that cannot be read is
 * kept. Best effort: nothing here throws.
 */
export async function dropTakenPictures(taken: Map<string, number>, paths: string[]): Promise<void> {
  const ours: string[] = [];
  for (const path of new Set(paths)) {
    const noted = taken.get(path);
    if (noted === undefined) continue;
    const stored = await head(path).then((found) => new Date(found.uploadedAt).getTime(), () => NaN);
    if (Number.isFinite(stored) && stored > noted) ours.push(path);
  }
  if (ours.length) await del(ours).catch(() => {});
}

/**
 * Whether a note was put back on the door once already (returnToDoor): its time carries half a millisecond. A picture
 * taken with such a note is checked again only paid for as a studio request (lib/picture-check.ts pictureChecker).
 */
export const putBackOnce = (noted: number): boolean => !Number.isInteger(noted);

/**
 * Puts pictures this request took from the door back on it, each at the time given (ms), after a check of the file
 * did not finish (Claude 2 on #2843, 6750890970): the file is kept, and a later save finds the picture and checks it
 * again. Only a path with a door list; best effort, nothing here throws (a note not put back leaves a file nothing
 * shows, kept: storage, never a picture deleted).
 */
export async function returnToDoor(entries: ReadonlyArray<readonly [string, number]>): Promise<void> {
  const commands: (string | number)[][] = [];
  for (const [path, at] of entries) {
    const key = doorsKey(path);
    if (!key || !Number.isFinite(at) || at <= 0) continue;
    commands.push(["ZADD", key, at, path], ["EXPIRE", key, PICTURE_DOOR_SECONDS]);
  }
  if (commands.length && isRedisConfigured()) await redisPipeline(commands).catch(() => {});
}
