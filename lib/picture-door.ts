import { BlobNotFoundError } from "@vercel/blob";
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
 * deletes one only when its own ZREM did, PICTURE_SWEEP_AFTER_SECONDS (30
 * days, owner decision DONO-8 of 9 November 2026) after its door, only while
 * its store's note is still there (the code before this list took a picture
 * off the store's list only, so a picture with no store note was taken, and
 * is kept), and only once the file itself was read and was stored after that
 * door's note.
 * One ZREM answers 1 once, so an attach and the sweep never both win a
 * picture: a picture the sweep deleted was never put on a product, a link or
 * a page. A buyer's review photo, an email's picture and a picture put on
 * before this list existed were never written on it, so the sweep never
 * touches them.
 *
 * A picture put on something is never on the list again (Claude 2 on #3347,
 * 9 November 2026: a second door for the same name, whose note landed after
 * the first upload had been attached, wrote the name back, and the sweep
 * deleted a picture a product showed). The take marks the name as taken
 * (takenKey, PICTURE_TAKEN_SECONDS) before it removes it, and a note reads
 * that mark after it writes: a note that finds it is taken back off both
 * lists and opens no door. Either the note was written before the take's
 * removal (and the take removed it), or it reads the mark. Should taking it
 * back fail, the sweep still keeps the file: one stored before its note is
 * not that door's upload. An unknown answer about the file never deletes it.
 *
 * A store's note stays until its picture is taken or swept, never dropped by
 * age while its picture is still on the list of unclaimed pictures: so
 * PICTURE_DOOR_MAX bounds every picture the store's doors let in that nothing
 * has taken, fresh or waiting for the sweep, and the file store never holds
 * more than PICTURE_DOOR_MAX of a store's untaken pictures, each at most
 * MAX_IMAGE_BYTES (lib/product-image.ts). A store note whose picture is no
 * longer on that list (taken or swept while the store's own removal was lost)
 * is dropped when the store reaches its cap, so it can never keep the door
 * shut, and the store's list expires PICTURE_DOORS_KEPT_SECONDS after its
 * last note.
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
/** How long after its door an untaken picture is swept: 30 days (owner decision DONO-8, 9 November 2026), far past its day (PICTURE_DOOR_SECONDS). */
export const PICTURE_SWEEP_AFTER_SECONDS = 30 * 24 * 60 * 60;
/** How long a store's list is kept after its last note: the grace and two days more for the daily sweep to reach it. */
export const PICTURE_DOORS_KEPT_SECONDS = 32 * 24 * 60 * 60;
/** How long a taken name stays marked: longer than any door request between its check of the file store and its note. */
export const PICTURE_TAKEN_SECONDS = 24 * 60 * 60;
/** The most unclaimed pictures one run of the sweep takes off the list and deletes, oldest first; the next run goes on. */
export const PICTURE_SWEEP_PER_RUN = 1_000;
/** The company's list of every picture a door signed for that nothing has taken yet, by when (ms). */
const UNCLAIMED_KEY = "nl:pictures:unclaimed";
/** How many unclaimed pictures go to one pipeline of ZREMs and one delete, so a lost reply keeps at most these. */
const SWEEP_BATCH = 25;
/** The most store notes past their day one door at the cap looks at, to drop those left behind. */
const LEFT_BEHIND_BATCH = 100;
/** A picture's mark that a record took it: a later note for the name opens no door. */
const takenKey = (path: string) => `nl:pictures:taken:${path}`;
/** A sorted-set score in its exact shape (a number, or the numeric string the REST API sends), or null. */
function scoreOf(reply: unknown): number | null {
  if (typeof reply !== "number" && !(typeof reply === "string" && /^\d{1,16}(\.\d+)?$/.test(reply))) return null;
  const at = Number(reply);
  return Number.isFinite(at) ? at : null;
}

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
 * Drops, from a store's list at its cap, notes past their day whose picture is no longer on the list of unclaimed
 * pictures: taken or swept while the store's own removal was lost, so no file of theirs waits for the sweep (Claude 2
 * on #3347: such notes kept the door shut for good). A note whose picture is still there keeps counting. Answers how
 * many were dropped, or null when an answer came back in another shape (rule 24): then nothing is decided from it.
 */
async function dropLeftBehind(key: string, path: string, now: number): Promise<number | null> {
  const found = await redisPipeline([["ZRANGEBYSCORE", key, 0, now - PICTURE_DOOR_SECONDS * 1000, "LIMIT", 0, LEFT_BEHIND_BATCH]])
    .then((replies) => repliesFor(replies, 1)?.[0], () => null);
  const old = Array.isArray(found) ? repliesFor(found, found.length) : null;
  if (!old || !old.every((name): name is string => typeof name === "string")) return null;
  const names = old.filter((name) => name !== path);
  if (names.length === 0) return 0;
  const scores = await redisPipeline(names.map((name) => ["ZSCORE", UNCLAIMED_KEY, name])).then((replies) => repliesFor(replies, names.length), () => null);
  if (!scores) return null;
  const gone: string[] = [];
  for (let i = 0; i < names.length; i += 1) {
    if (scores[i] === null) gone.push(names[i]);
    else if (scoreOf(scores[i]) === null) return null;
  }
  if (gone.length === 0) return 0;
  const removed = await redisPipeline(gone.map((name) => ["ZREM", key, name])).then((replies) => repliesFor(replies, gone.length), () => null);
  if (!removed) return null;
  let freed = 0;
  for (const reply of removed) {
    const one = countOf(reply);
    if (one !== 0 && one !== 1) return null;
    freed += one;
  }
  return freed;
}

/**
 * Writes down a picture the door is about to sign for, in milliseconds, on the store's list and on the company's list
 * of unclaimed pictures. False when it could not be written, its count could not be read, or the name was already
 * taken by a record: such an upload could never be put on anything, so the door is not opened for it. Throws
 * PictureDoorFull, with nothing noted, when the store already held PICTURE_DOOR_MAX untaken notes.
 */
export async function notePictureDoor(path: string, now = Date.now()): Promise<boolean> {
  const key = doorsKey(path);
  if (!key || !isRedisConfigured()) return false;
  const replies = repliesFor(await redisPipeline([
    ["ZADD", key, now, path],
    ["ZADD", UNCLAIMED_KEY, now, path],
    ["EXPIRE", key, PICTURE_DOORS_KEPT_SECONDS],
    // Read after the adds: a take marks before it removes, so a note either was removed by it or sees its mark.
    ["EXISTS", takenKey(path)],
    ["ZCARD", key],
  ]), 5);
  // Noted only on its whole acknowledgement (Codex P on #2156): 0 or 1 for each add, the expiry set, an exact 0 or 1
  // for the mark, and the store list's exact count. Anything else is not a note, and the upload is not opened (a name
  // written with no file is swept as nothing).
  if (!replies) return false;
  const [added, listed, expiry, marked, count] = replies.map(countOf);
  if ((added !== 0 && added !== 1) || (listed !== 0 && listed !== 1) || expiry !== 1 || (marked !== 0 && marked !== 1) || count === null) return false;
  if (marked === 1) {
    // Taken by a record already: this note must never put the name back for the sweep. Best effort; should it fail,
    // the sweep keeps the file, stored before this note.
    await redisPipeline([["ZREM", UNCLAIMED_KEY, path], ["ZREM", key, path]]).catch(() => {});
    return false;
  }
  let held = count;
  if (held > PICTURE_DOOR_MAX) {
    const freed = await dropLeftBehind(key, path, now);
    if (freed === null) return false;
    held -= freed;
  }
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
  // Each name is marked as taken before it is removed (Claude 2 on #3347): a late note for it then reads the mark and
  // never puts it back on the list for the sweep.
  const answers = await redisPipeline(fresh.flatMap(([path]) => [
    ["SET", takenKey(path), "1", "EX", PICTURE_TAKEN_SECONDS],
    ["ZREM", UNCLAIMED_KEY, path],
    ["ZREM", doorsKey(path) as string, path],
  ]));
  if (!Array.isArray(answers) || answers.length !== 3 * fresh.length) throw new Error("could not confirm the pictures taken from the door");
  // Read exactly (Codex P on #2156): the mark an exact OK and the removal from the list of unclaimed pictures an exact
  // 0 or 1, which alone says who has the picture; anything else is not a confirmed take, and throws as an unconfirmed
  // take does. The store's own note only counts against its cap: one left there in an unknown state keeps a place
  // taken, never a file, and is dropped once the store reaches its cap (dropLeftBehind).
  let unsure = 0;
  fresh.forEach(([path, at], i) => {
    if (answers[3 * i] !== "OK") throw new UnknownReplyError("taking a picture from the door: SET");
    const won = countOf(answers[3 * i + 1]);
    if (won !== 0 && won !== 1) throw new UnknownReplyError("taking a picture from the door: ZREM");
    const freed = countOf(answers[3 * i + 2]);
    if (freed !== 0 && freed !== 1) unsure += 1;
    if (won === 1) taken.set(path, at);
  });
  if (unsure) console.error(`${unsure} pictures taken from the door: their store notes came back in an unknown shape; they count against the store's cap until it reaches it`);
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
 * Only a picture proven unused is deleted (owner decision DONO-8, 9 November 2026; Claude 2 on #3347):
 *   - this run's own ZREM took it off the list of unclaimed pictures (exactly 1): an attach that took it after the
 *     list was read keeps its file (as lib/assignment.ts sweepTaskUploads does);
 *   - its note is still on its store's list (ZSCORE a score): a store note is kept until its picture is taken or
 *     swept, and the code before the list of unclaimed pictures took a picture off the store's list only, so a
 *     picture with no store note was taken there (after a rollback; Claude 2 on #3347 @1eef9e91e1) and is kept,
 *     its file left (storage, never a picture deleted from under a record); a store note read in another shape is
 *     unknown, and the picture is put back for the next run;
 *   - its file, read with `look` (the file store's head), was stored strictly after its note, as dropTakenPictures
 *     checks: a file stored before it is not that door's upload, and is kept;
 *   - a file check that fails or answers in another shape is unknown, never "unused": the picture is put back for the
 *     next run, and its store note keeps counting.
 * The file store's clock and the function's are not the same: should the file store's run ahead, a file stored just
 * before a late note could read as stored after it. The taken mark the late note reads, and its taking itself back
 * off both lists, still keep such a picture; a deletion needs both to miss.
 * Its store's note is taken off once its file is gone (or proven not to be the door's), so the store's cap counts it
 * until then; a removal of the note answered in another shape leaves it to dropLeftBehind and the list's expiry. A
 * delete that fails puts its pictures back on the list for the next run. The list, the pipeline and each ZREM are read
 * in their exact shape (CX-123 rule 24): a read in another shape throws and deletes nothing; a removal in another
 * shape deletes nothing, keeps the file (storage, never a picture deleted from under a record), and is logged. A name
 * that is not a picture door's is taken off the list and deleted from nowhere.
 *
 * The run's cap is the company's, oldest first: a store with many untaken pictures may take a run, and the others go
 * on the next day; each store's untaken pictures stay bounded by PICTURE_DOOR_MAX meanwhile.
 */
export async function sweepPictureDoors(
  remove: (paths: string[]) => Promise<void>,
  now = Date.now(),
  limit = PICTURE_SWEEP_PER_RUN,
  look: (path: string) => Promise<{ uploadedAt: Date }> = head,
): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const before = now - PICTURE_SWEEP_AFTER_SECONDS * 1000;
  const found = repliesFor(await redisPipeline([["ZRANGEBYSCORE", UNCLAIMED_KEY, 0, before, "WITHSCORES", "LIMIT", 0, limit]]), 1)?.[0];
  const flat = Array.isArray(found) ? repliesFor(found, found.length) : null;
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("the pictures never put on anything");
  const listed: [string, number][] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const path = flat[i];
    const noted = scoreOf(flat[i + 1]);
    if (typeof path !== "string" || noted === null) throw new UnknownReplyError("the pictures never put on anything");
    listed.push([path, noted]);
  }
  const deleted: string[] = [];
  let unknown = 0;
  /** Puts these back on the list of unclaimed pictures at their own door's time, for the next run. */
  const putBack = async (back: [string, number][], why: string) => {
    if (back.length === 0) return;
    const reply = await redisPipeline([["ZADD", UNCLAIMED_KEY, ...back.flatMap(([path, noted]) => [noted, path])]]).then((replies) => repliesFor(replies, 1)?.[0], () => null);
    if (countOf(reply) === null) console.error(`putting back ${back.length} unclaimed pictures (${why}): unknown reply, they may be left`);
  };
  for (let at = 0; at < listed.length; at += SWEEP_BATCH) {
    const batch = listed.slice(at, at + SWEEP_BATCH);
    let takes: unknown[] | null;
    try {
      takes = repliesFor(await redisPipeline(batch.map(([path]) => ["ZREM", UNCLAIMED_KEY, path])), batch.length);
    } catch (error) {
      console.error(`taking ${batch.length} unclaimed pictures off their list: no reply, their files are kept`, error);
      unknown += batch.length;
      continue;
    }
    if (!takes) {
      unknown += batch.length;
      continue;
    }
    const won = batch.filter(([path], i) => {
      if (takes[i] === 1) return doorsKey(path) !== null;
      if (takes[i] !== 0) unknown += 1;
      return false;
    });
    if (won.length === 0) continue;
    // Each store note read before the file: a picture taken off its store's list only (by the code before the list
    // of unclaimed pictures, after a rollback; Claude 2 on #3347) has no note there, and is kept. Exact shapes only:
    // null is no note, a score is a note, anything else (or no reply) is unknown, kept and put back.
    const notes = await redisPipeline(won.map(([path]) => ["ZSCORE", doorsKey(path) as string, path])).then((replies) => repliesFor(replies, won.length), () => null);
    if (!notes) {
      console.error(`${won.length} unclaimed pictures: their store notes could not be read, so they are kept and put back for the next run`);
      await putBack(won, "store notes unknown");
      continue;
    }
    const stillNoted = won.filter((_, i) => notes[i] !== null && scoreOf(notes[i]) !== null);
    const oddNotes = won.filter((_, i) => notes[i] !== null && scoreOf(notes[i]) === null);
    const unnoted = won.length - stillNoted.length - oddNotes.length;
    if (oddNotes.length) {
      console.error(`${oddNotes.length} unclaimed pictures: their store notes came back in another shape, so they are kept and put back for the next run`);
      await putBack(oddNotes, "store note unknown");
    }
    if (unnoted) console.error(`${unnoted} unclaimed pictures: no longer on their store's list (taken there), so they are kept`);
    if (stillNoted.length === 0) continue;
    // Each file read before anything is deleted: stored after its note is the door's own upload, never taken.
    const read = await Promise.all(stillNoted.map(([path, noted]) => look(path).then(
      (file) => {
        const stored = file && typeof file === "object" ? new Date(file.uploadedAt).getTime() : NaN;
        return Number.isFinite(stored) ? (stored > noted ? "unused" : "older") : "unknown";
      },
      (error: unknown) => (error instanceof BlobNotFoundError ? "gone" : "unknown"),
    )));
    const unused = stillNoted.filter((_, i) => read[i] === "unused");
    const notOurs = stillNoted.filter((_, i) => read[i] === "gone" || read[i] === "older");
    const unsure = stillNoted.filter((_, i) => read[i] === "unknown");
    if (unsure.length) {
      console.error(`${unsure.length} unclaimed pictures: their files could not be read, so they are kept and put back for the next run`);
      await putBack(unsure, "file check unknown");
    }
    const older = stillNoted.filter((_, i) => read[i] === "older").length;
    if (older) console.error(`${older} unclaimed pictures: their files were stored before their notes, so they are kept`);
    let gone = notOurs;
    if (unused.length) {
      try {
        await remove(unused.map(([path]) => path));
        deleted.push(...unused.map(([path]) => path));
        gone = [...notOurs, ...unused];
      } catch (error) {
        console.error(`could not delete ${unused.length} unclaimed pictures; they are put back for the next run`, error);
        await putBack(unused, "delete failed");
      }
    }
    if (gone.length === 0) continue;
    // Gone from the file store, or never the door's: only now does the store's note stop counting against its cap.
    const freed = await redisPipeline(gone.map(([path]) => ["ZREM", doorsKey(path) as string, path])).then((replies) => repliesFor(replies, gone.length), () => null);
    if (!freed || freed.some((reply) => reply !== 0 && reply !== 1)) console.error(`${gone.length} swept pictures: their store notes came back in an unknown shape; they are dropped once the store reaches its cap`);
  }
  if (unknown) console.error(`${unknown} unclaimed pictures: whether they were taken off their list came back in an unknown shape; their files are kept`);
  return deleted;
}
