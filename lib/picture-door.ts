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
 * (dropTakenPictures): the door notes each name it signs for, and the first
 * route that tries to put it on anything takes it off, whether that succeeds
 * or not. A picture already on something was taken then (or
 * signed before this list existed, and never written down), so a failed
 * request naming it deletes nothing. Unknown is kept: a file left behind costs
 * storage, a picture deleted from under a product costs the creator's page.
 *
 * Notes older than PICTURE_DOOR_SECONDS, and past the newest PICTURE_DOOR_MAX,
 * are dropped as new ones come in, so the list stays bounded; their files are
 * then never deleted by a failure (each costs storage, at most MAX_IMAGE_BYTES
 * in lib/product-image.ts), never deleted wrongly.
 */
const DOORS_KEY = "nl:pictures:doors";
export const PICTURE_DOOR_SECONDS = 24 * 60 * 60;
/** The most notes kept, newest first: past it the oldest go, and their files are kept, not deleted. */
export const PICTURE_DOOR_MAX = 20_000;

/** Writes down a picture the door just signed for; old notes are dropped with it. */
export async function notePictureDoor(path: string, now = Date.now()): Promise<void> {
  if (!isRedisConfigured()) return;
  const at = Math.floor(now / 1000);
  await redisPipeline([
    ["ZREMRANGEBYSCORE", DOORS_KEY, 0, at - PICTURE_DOOR_SECONDS],
    ["ZADD", DOORS_KEY, at, path],
    ["ZREMRANGEBYRANK", DOORS_KEY, 0, -(PICTURE_DOOR_MAX + 1)],
  ]);
}

/**
 * Takes each of these pictures off the list, and returns those this call took,
 * with when the door signed for each: the ones let in through the door that
 * nothing had tried to put on yet. A failed read takes none.
 */
export async function takePictureDoor(paths: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(paths.filter((path) => typeof path === "string" && path !== ""))];
  const taken = new Map<string, number>();
  if (unique.length === 0 || !isRedisConfigured()) return taken;
  try {
    const answers = await redisPipeline(unique.flatMap((path) => [["ZSCORE", DOORS_KEY, path], ["ZREM", DOORS_KEY, path]]));
    unique.forEach((path, i) => {
      const at = Number(answers[2 * i]);
      if (Number(answers[2 * i + 1]) === 1 && Number.isFinite(at) && at > 0) taken.set(path, at * 1000);
    });
  } catch {
    return new Map();
  }
  return taken;
}

/**
 * Deletes those of these pictures that this request took from the door and
 * that were stored after the door signed for them. The door signs for any
 * fresh-looking name, even one that is already a picture (the upload itself
 * could never write over it), so a note alone does not make a file new: a
 * file stored before its note is somebody's picture and is kept. Anything that
 * cannot be read is kept. Best effort: nothing here throws.
 */
export async function dropTakenPictures(taken: Map<string, number>, paths: string[]): Promise<void> {
  const ours: string[] = [];
  for (const path of new Set(paths)) {
    const noted = taken.get(path);
    if (noted === undefined) continue;
    const stored = await head(path).then((found) => new Date(found.uploadedAt).getTime(), () => NaN);
    if (Number.isFinite(stored) && stored >= noted) ours.push(path);
  }
  if (ours.length) await del(ours).catch(() => {});
}
