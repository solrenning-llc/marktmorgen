/**
 * 313 [CV1] unit 4b: a product picture, and its smaller copy, copied to the pictures' own R2 bucket as they are
 * attached, when that bucket is on (lib/picture-r2.ts, pictureR2Config: off until the owner's settings and the
 * reviewed request ceiling exist). Off, nothing is read and nothing is sent. Each file is read once from the file
 * store, at most MAX_IMAGE_BYTES, and written create-only; a copy that fails leaves the picture as it was, served
 * from where it always was. Nothing serves from R2 yet: addressing marked pictures is unit 4c.
 */
import { get } from "@/lib/blob";
import { copyPictureToR2, deletePictureFromR2, pictureR2Config, type PictureR2Config } from "@/lib/picture-r2";
import { IMAGE_FILE_PATTERN, IMAGE_FOLDER_PATTERN, MAX_IMAGE_BYTES } from "@/lib/product-image";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";

/** The bucket's settings, for callers that pass them on (lib/picture-withdraw.ts): only this file and the served
 * address read lib/picture-r2.ts itself (tests/picture-r2.test.ts). */
export type { PictureR2Config };

/** A picture's whole file from the file store, at most MAX_IMAGE_BYTES; it throws on anything else. */
async function readPicture(path: string): Promise<Uint8Array> {
  const found = await get(path, { access: "private" });
  if (!found || found.statusCode !== 200 || !found.stream) throw new Error("Picture not found");
  const reader = found.stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Picture larger than a picture may be");
    }
    parts.push(value);
  }
  const whole = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
}

/** True when every file was copied (or was already there under its fresh name); false when off or on any failure. */
export async function copyAttachedPicture(
  paths: readonly string[],
  options: { config?: PictureR2Config | null; read?: (path: string) => Promise<Uint8Array> } = {},
): Promise<boolean> {
  const config = "config" in options ? options.config : pictureR2Config();
  if (!config || paths.length === 0) return false;
  const read = options.read ?? readPicture;
  // A copy also tries again a few deletes an earlier drop left behind (PICTURE_DROP_QUEUE), as a stamped copy does.
  await retryPictureDrops(RETRY_PER_CALL, { config }).catch((error: unknown) => console.error("pictures left in their bucket from before could not be deleted yet; they stay on the list", error));
  try {
    for (const path of paths) await copyPictureToR2(config, path, await read(path));
    return true;
  } catch (error) {
    console.error("copying a picture to its own bucket failed; it stays where it was", error);
    return false;
  }
}

/**
 * Pictures' files whose delete from the pictures' bucket failed, each tried again until it is confirmed gone (Codex U,
 * X5 and P and Claude 7 on #4357): a copy left there is paid storage and, once the images' domain serves the bucket,
 * a public copy of a picture the creator removed or a takedown moved away. The same shape as the stamped copies'
 * list (lib/pdf-stamp.ts, DROP_QUEUE): a set of names, drained a few at a time by the next drop or copy.
 */
export const PICTURE_DROP_QUEUE = "nl:picture-r2:drop";
/** How many such names one drop or one copy tries again: a few signed DELETEs at most, each a Class A operation. */
const RETRY_PER_CALL = 2;
/** A picture's own name, as lib/picture-r2.ts addresses it (pictureParts); nothing else read from the list is ever sent. */
function isPictureName(path: string): boolean {
  const [root, folder, file, ...rest] = path.split("/");
  return root === "images" && rest.length === 0 && IMAGE_FOLDER_PATTERN.test(folder ?? "") && IMAGE_FILE_PATTERN.test(file ?? "");
}

/** Puts a name down to be tried again. False when that could not be confirmed (rule 24: SADD answers 0 or 1). */
async function noteDrop(path: string): Promise<boolean> {
  if (!isRedisConfigured() || !isPictureName(path)) return false;
  try {
    const replies = repliesFor(await redisPipeline([["SADD", PICTURE_DROP_QUEUE, path]]), 1);
    const added = replies ? countOf(replies[0]) : null;
    return added === 0 || added === 1;
  } catch {
    return false;
  }
}

/**
 * Tries again up to `limit` names an earlier delete left in the bucket, and answers how many are now gone. A name
 * leaves the list only after its delete is confirmed (204, 200, or 404 for gone already); one that fails stops the
 * try and stays. A list read in any shape but an exact list of text throws (UnknownReplyError), and nothing is sent
 * on it. Off, nothing is read and nothing is sent: the names wait for the bucket to be on again.
 */
export async function retryPictureDrops(limit: number, options: { config?: PictureR2Config | null } = {}): Promise<number> {
  const config = "config" in options ? options.config : pictureR2Config();
  if (!config || !isRedisConfigured()) return 0;
  const replies = repliesFor(await redisPipeline([["SRANDMEMBER", PICTURE_DROP_QUEUE, limit]]), 1);
  const names = replies ? stringList(replies[0]) : null;
  if (!names || names.length > limit) throw new UnknownReplyError("the pictures to delete from their bucket");
  let gone = 0;
  for (const name of names) {
    if (!isPictureName(name)) continue;
    await deletePictureFromR2(config, name);
    const taken = repliesFor(await redisPipeline([["SREM", PICTURE_DROP_QUEUE, name]]), 1);
    const count = taken ? countOf(taken[0]) : null;
    if (count === null || count > 1) throw new UnknownReplyError("a deleted picture taken off the list");
    gone += 1;
  }
  return gone;
}

/**
 * What became of a picture's files in the pictures' bucket: "gone", every one confirmed deleted (or the bucket is
 * off, so nothing was ever copied there); "queued", every one not deleted is confirmed on PICTURE_DROP_QUEUE to be
 * tried again; "unknown", at least one is neither, and nothing will try it again.
 */
export type MirrorDrop = "gone" | "queued" | "unknown";

/**
 * Deletes a copied picture's files from the pictures' bucket, wherever they are deleted from the file store (#4237,
 * item 4): a picture replaced, removed with its product, dropped after a record that could not be written, or moved
 * away by a takedown. Every file is tried, whatever the one before it answered (Codex U on #4357), and each that
 * fails is put down on PICTURE_DROP_QUEUE; never thrown: the file store's own deletion goes on as before. A takedown
 * holds out for "gone" (lib/picture-withdraw.ts); the other callers keep on with "queued", and log "unknown".
 */
export async function dropMirroredPicture(paths: readonly string[], options: { config?: PictureR2Config | null } = {}): Promise<MirrorDrop> {
  const config = "config" in options ? options.config : pictureR2Config();
  if (!config || paths.length === 0) return "gone";
  await retryPictureDrops(RETRY_PER_CALL, { config }).catch((error: unknown) => console.error("pictures left in their bucket from before could not be deleted yet; they stay on the list", error));
  let result: MirrorDrop = "gone";
  for (const path of paths) {
    try {
      await deletePictureFromR2(config, path);
    } catch (error) {
      if (await noteDrop(path)) {
        console.error("deleting a picture from its own bucket failed; put down to be tried again", error);
        if (result === "gone") result = "queued";
      } else {
        console.error("deleting a picture from its own bucket failed, and nothing will try again: the list could not be written", error);
        result = "unknown";
      }
    }
  }
  return result;
}
