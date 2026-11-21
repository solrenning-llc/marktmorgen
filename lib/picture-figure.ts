/**
 * The count behind a store's pictures figure (507 [SG3]; lib/picture-figure-rules.ts):
 *
 *   nl:pimg:b:<folder>   string   the bytes of pictures the store keeps, as counted
 *
 * A place is taken, in bytes, before a picture is kept, and given back when it
 * is deleted. Past the figure the place is given back at once and the picture
 * refused. A reply that does not read refuses (rule 24): a count that may
 * already be over is never taken for room. Off: nothing calls it yet.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { IMAGE_FOLDER_PATTERN } from "@/lib/product-image";

export const PICTURES_BYTES_KEY = (folder: string) => `nl:pimg:b:${folder}`;

/** A whole number from what INCRBY or DECRBY answered, or null. */
function wholeReply(reply: unknown): number | null {
  const replies = repliesFor(reply, 1);
  const value = replies ? replies[0] : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Takes `bytes` of the store's pictures figure `limit` before a picture is kept: true only when it fits and was counted. */
export async function takePictureBytes(folder: string, bytes: number, limit: number): Promise<boolean> {
  if (!IMAGE_FOLDER_PATTERN.test(folder) || !Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(limit) || limit <= 0 || !isRedisConfigured()) return false;
  try {
    const count = wholeReply(await redisPipeline([["INCRBY", PICTURES_BYTES_KEY(folder), bytes]]));
    if (count === null) return false;
    if (count > 0 && count <= limit) return true;
    // Over the figure: the place is given back at once.
    await redisPipeline([["DECRBY", PICTURES_BYTES_KEY(folder), bytes]]);
  } catch (error) {
    console.error("could not count a store's pictures", error);
  }
  return false;
}

/** Gives back `bytes` when a picture is deleted, never below zero. Best effort: never throws. */
export async function givePictureBytes(folder: string, bytes: number): Promise<void> {
  if (!IMAGE_FOLDER_PATTERN.test(folder) || !Number.isSafeInteger(bytes) || bytes <= 0 || !isRedisConfigured()) return;
  try {
    const count = wholeReply(await redisPipeline([["DECRBY", PICTURES_BYTES_KEY(folder), bytes]]));
    if (count !== null && count < 0) await redisPipeline([["INCRBY", PICTURES_BYTES_KEY(folder), -count]]);
  } catch (error) {
    console.error("could not give back a store's pictures", error);
  }
}
