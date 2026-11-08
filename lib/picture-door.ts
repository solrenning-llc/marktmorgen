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
 * another's. A note past PICTURE_DOOR_SECONDS is never taken, so nothing can
 * put its picture on anything any more, and a failure never deletes its file.
 *
 * Each door is also written on the company's list of unclaimed pictures
 * (UNCLAIMED_KEY), at the same time as the store's note (rule 24 inventory
 * A1b, 8 November 2026: before it, a picture never put on anything stayed in
 * the file store for good once its note expired). That list decides who has a
 * picture: an attach takes a fresh one only when its own ZREM took it off
 * that list (takePictureDoor), and the course job's sweep (sweepPictureDoors)
 * deletes one only when its own ZREM did, a day and an hour after its door.
 * One ZREM answers 1 once, so an attach and the sweep never both win a
 * picture: a picture the sweep deleted was never put on a product, a link or
 * a page, and one put on something is never on the list again. A buyer's
 * review photo, an email's picture and a picture put on before this list
 * existed were never written on it, so the sweep never touches them.
 *
 * A store's note stays until its picture is taken or swept, never dropped by
 * age, and the list has no expiry: so PICTURE_DOOR_MAX bounds every picture
 * the store's doors let in that nothing has taken, fresh or waiting for the
 * sweep, and the file store never holds more than PICTURE_DOOR_MAX of a
 * store's untaken pictures, each at most MAX_IMAGE_BYTES (lib/product-image.ts),
 * however late the sweep runs. A late sweep only keeps the door shut longer.
 *
 * Each door is a write to the file store, and a picture never put on anything
 * stays there until the sweep, so the doors are capped before one is signed (owner rule MR: a
 * ceiling before every spend; rule 24 inventory A1, 8 November 2026): a store
 * already holding PICTURE_DOOR_MAX untaken notes is refused, counted exactly,
 * never by pushing its oldest out (which let the door open without end), and
 * a store's doors are counted by the hour (PICTURE_DOORS_PER_HOUR) before the
 * file store is asked. A count that cannot be read opens nothing.
 */
export const PICTURE_DOOR_SECONDS = 24 * 60 * 60;
/** The most untaken notes a store may hold, fresh or waiting for the sweep: one more door is refused (PictureDoorFull), none pushed out. */
export const PICTURE_DOOR_MAX = 1_000;
/** The doors a store may open in an hour, counted before the file store is asked or anything is signed. */
export const PICTURE_DOORS_PER_HOUR = 200;
/** How long after its door an untaken picture is swept: its day (PICTURE_DOOR_SECONDS), and an hour more so the sweep never meets a fresh note. */
export const PICTURE_SWEEP_AFTER_SECONDS = 25 * 60 * 60;
/** The most unclaimed pictures one run of the sweep takes off the list and deletes, oldest first; the next run goes on. */
export const PICTURE_SWEEP_PER_RUN = 1_000;
/** The company's list of every picture a door signed for that nothing has taken yet, by when (ms). */
const UNCLAIMED_KEY = "nl:pictures:unclaimed";
/** How many unclaimed pictures go to one pipeline of ZREMs and one delete, so a lost reply keeps at most these. */
const SWEEP_BATCH = 25;

/** The store already holds PICTURE_DOOR_MAX untaken doors: nothing was noted, and the door is not opened. */
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
 * Writes down a picture the door is about to sign for, in milliseconds, on the store's list and on the company's list
 * of unclaimed pictures. False when it could not be written or its count could not be read: such an upload could
 * never be put on anything, so the door is not opened for it. Throws PictureDoorFull, with nothing noted, when the
 * store already held PICTURE_DOOR_MAX untaken notes.
 */
export async function notePictureDoor(path: string, now = Date.now()): Promise<boolean> {
  const key = doorsKey(path);
  if (!key || !isRedisConfigured()) return false;
  const replies = repliesFor(await redisPipeline([
    ["ZADD", key, now, path],
    ["ZADD", UNCLAIMED_KEY, now, path],
    ["ZCARD", key],
  ]), 3);
  // Noted only on its whole acknowledgement (Codex P on #2156): 0 or 1 for each add, and the store list's exact count.
  // Anything else is not a note, and the upload is not opened (a name written with no file is swept as nothing).
  if (!replies) return false;
  const [added, listed, held] = replies.map(countOf);
  if ((added !== 0 && added !== 1) || (listed !== 0 && listed !== 1) || held === null) return false;
  if (held <= PICTURE_DOOR_MAX) return true;
  // Past the cap with this one: a name new to the store's list is taken back off both (best effort; a note left on a
  // name with no file deletes nothing), and the door is refused. A name already noted keeps its earlier door's notes.
  if (added === 1) await redisPipeline([["ZREM", key, path], ...(listed === 1 ? [["ZREM", UNCLAIMED_KEY, path]] : [])]).catch(() => {});
  throw new PictureDoorFull();
}

/**
 * Takes each of these pictures off the list of unclaimed pictures and its store's list, and returns those this call
 * took, with when the door signed for each (ms): the ones let in through the door within PICTURE_DOOR_SECONDS that
 * nothing had taken yet. A note past the day is left where it is, on both lists, for the sweep; it is never taken, so
 * a picture whose door is a day old can never be put on anything. A picture is taken only when this call's own ZREM
 * took it off the list of unclaimed pictures (exactly 1): an attach that lost it to the sweep or to another request
 * takes nothing.
 *
 * When the take cannot be confirmed (a read or the removal failed, or its
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
  const scores = await redisPipeline(unique.map((path) => ["ZSCORE", UNCLAIMED_KEY, path]));
  if (!Array.isArray(scores) || scores.length !== unique.length) throw new Error("could not confirm the pictures taken from the door");
  // Each score only in its exact shape (CX-123, rule 24): null or a score (a number, or the numeric string the REST API
  // sends). Anything else is unknown and throws, never "taken".
  const fresh: [string, number][] = [];
  unique.forEach((path, i) => {
    const score = scores[i];
    if (score !== null && !(typeof score === "number" || (typeof score === "string" && /^\d{1,16}(\.\d+)?$/.test(score)))) {
      throw new UnknownReplyError("taking a picture from the door: ZSCORE");
    }
    const at = score === null ? NaN : Number(score);
    if (Number.isFinite(at) && at > 0 && at >= now - PICTURE_DOOR_SECONDS * 1000) fresh.push([path, at]);
  });
  if (fresh.length === 0) return taken;
  const answers = await redisPipeline(fresh.flatMap(([path]) => [["ZREM", UNCLAIMED_KEY, path], ["ZREM", doorsKey(path) as string, path]]));
  if (!Array.isArray(answers) || answers.length !== 2 * fresh.length) throw new Error("could not confirm the pictures taken from the door");
  // Read exactly (Codex P on #2156): the removal from the list of unclaimed pictures an exact 0 or 1, which alone says
  // who has the picture; anything else is not a confirmed take, and throws as an unconfirmed take does. The store's
  // own note only counts against its cap: one left there in an unknown state keeps a place taken, never a file.
  let unsure = 0;
  fresh.forEach(([path, at], i) => {
    const won = countOf(answers[2 * i]);
    if (won !== 0 && won !== 1) throw new UnknownReplyError("taking a picture from the door: ZREM");
    const freed = countOf(answers[2 * i + 1]);
    if (freed !== 0 && freed !== 1) unsure += 1;
    if (won === 1) taken.set(path, at);
  });
  if (unsure) console.error(`${unsure} pictures taken from the door: their store notes came back in an unknown shape and may still count against the store's cap`);
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
 * Deletes, with `remove` (the file store's delete), the pictures a door signed for more than
 * PICTURE_SWEEP_AFTER_SECONDS ago that nothing took: the creator closed the editor, chose another picture, or the
 * attach failed after its take was lost. At most `limit` a run, oldest first; the next run goes on where this one
 * stopped, so the list is the job's place. Answers the paths deleted.
 *
 * Each picture is taken off the list of unclaimed pictures by this run's own ZREM, and only one this run removed
 * itself (exactly 1) is deleted: an attach that took it after the list was read keeps its file (as
 * lib/assignment.ts sweepTaskUploads does). Its store's note is taken off only once its file is gone, so the store's
 * cap counts it until then. A delete that fails puts its pictures back on the list for the next run. The list, the
 * pipeline and each ZREM are read in their exact shape (CX-123 rule 24): a read in another shape throws and deletes
 * nothing; a removal in another shape deletes nothing, keeps the file (storage, never a picture deleted from under a
 * record), and is logged. A name that is not a picture door's is taken off the list and deleted from nowhere.
 */
export async function sweepPictureDoors(remove: (paths: string[]) => Promise<void>, now = Date.now(), limit = PICTURE_SWEEP_PER_RUN): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const before = now - PICTURE_SWEEP_AFTER_SECONDS * 1000;
  const found = repliesFor(await redisPipeline([["ZRANGEBYSCORE", UNCLAIMED_KEY, 0, before, "LIMIT", 0, limit]]), 1)?.[0];
  const listed = Array.isArray(found) ? repliesFor(found, found.length) : null;
  if (!listed || !listed.every((path): path is string => typeof path === "string")) throw new UnknownReplyError("the pictures never put on anything");
  const deleted: string[] = [];
  let unknown = 0;
  for (let at = 0; at < listed.length; at += SWEEP_BATCH) {
    const batch = listed.slice(at, at + SWEEP_BATCH);
    let takes: unknown[] | null;
    try {
      takes = repliesFor(await redisPipeline(batch.map((path) => ["ZREM", UNCLAIMED_KEY, path])), batch.length);
    } catch (error) {
      console.error(`taking ${batch.length} unclaimed pictures off their list: no reply, their files are kept`, error);
      unknown += batch.length;
      continue;
    }
    if (!takes) {
      unknown += batch.length;
      continue;
    }
    const won = batch.filter((path, i) => {
      if (takes[i] === 1) return doorsKey(path) !== null;
      if (takes[i] !== 0) unknown += 1;
      return false;
    });
    if (won.length === 0) continue;
    try {
      await remove(won);
    } catch (error) {
      console.error(`could not delete ${won.length} unclaimed pictures; they are put back for the next run`, error);
      const back = await redisPipeline([["ZADD", UNCLAIMED_KEY, ...won.flatMap((path) => [before, path])]]).then((replies) => repliesFor(replies, 1)?.[0], () => null);
      if (countOf(back) === null) console.error(`putting back ${won.length} unclaimed pictures: unknown reply, they may be left`);
      continue;
    }
    deleted.push(...won);
    // Gone from the file store: only now does the store's note stop counting against its cap.
    const freed = await redisPipeline(won.map((path) => ["ZREM", doorsKey(path) as string, path])).then((replies) => repliesFor(replies, won.length), () => null);
    if (!freed || freed.some((reply) => reply !== 0 && reply !== 1)) console.error(`${won.length} swept pictures: their store notes came back in an unknown shape and may still count against the store's cap`);
  }
  if (unknown) console.error(`${unknown} unclaimed pictures: whether they were taken off their list came back in an unknown shape; their files are kept`);
  return deleted;
}
