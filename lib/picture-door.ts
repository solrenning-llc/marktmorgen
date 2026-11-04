import { del, head } from "@/lib/blob";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

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
 * One list per store's picture folder, so one store's doors never push out
 * another's. Notes older than PICTURE_DOOR_SECONDS, and past the newest
 * PICTURE_DOOR_MAX of the store, are dropped as new ones come in, and the list
 * itself expires a window after its last note; a dropped or stale note is
 * never taken, so its file is never deleted by a failure (it costs storage, at
 * most MAX_IMAGE_BYTES in lib/product-image.ts), never deleted wrongly.
 */
export const PICTURE_DOOR_SECONDS = 24 * 60 * 60;
/** The most notes a store keeps, newest first: past it the oldest go, and their files are kept, not deleted. */
export const PICTURE_DOOR_MAX = 1_000;

/** A picture's path is images/<folder>/<file>; its store's list is named by the folder. */
function doorsKey(path: string): string | null {
  const parts = path.split("/");
  return parts.length === 3 && parts[0] === "images" && /^[0-9a-f]{24}$/.test(parts[1]) ? `nl:pictures:doors:${parts[1]}` : null;
}

/**
 * Writes down a picture the door just signed for, in milliseconds; old notes are dropped with it. False when it
 * could not be written: such an upload could never be put on anything, so the door is not opened for it.
 */
export async function notePictureDoor(path: string, now = Date.now()): Promise<boolean> {
  const key = doorsKey(path);
  if (!key || !isRedisConfigured()) return false;
  await redisPipeline([
    ["ZREMRANGEBYSCORE", key, 0, now - PICTURE_DOOR_SECONDS * 1000],
    ["ZADD", key, now, path],
    ["ZREMRANGEBYRANK", key, 0, -(PICTURE_DOOR_MAX + 1)],
    ["EXPIRE", key, PICTURE_DOOR_SECONDS],
  ]);
  return true;
}

/**
 * Takes each of these pictures off its store's list, and returns those this
 * call took, with when the door signed for each (ms): the ones let in through
 * the door within PICTURE_DOOR_SECONDS that nothing had tried to put on yet.
 * A stale note is taken off but not returned. A failed read takes none.
 */
export async function takePictureDoor(paths: string[], now = Date.now()): Promise<Map<string, number>> {
  const unique = [...new Set(paths.filter((path) => typeof path === "string" && doorsKey(path) !== null))];
  const taken = new Map<string, number>();
  if (unique.length === 0 || !isRedisConfigured()) return taken;
  try {
    const answers = await redisPipeline(unique.flatMap((path) => {
      const key = doorsKey(path) as string;
      return [["ZSCORE", key, path], ["ZREM", key, path]];
    }));
    unique.forEach((path, i) => {
      const at = Number(answers[2 * i]);
      const fresh = Number.isFinite(at) && at > 0 && at >= now - PICTURE_DOOR_SECONDS * 1000;
      if (Number(answers[2 * i + 1]) === 1 && fresh) taken.set(path, at);
    });
  } catch {
    return new Map();
  }
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
