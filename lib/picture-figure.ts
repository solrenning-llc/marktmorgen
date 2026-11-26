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

/** 1 or 0 from what a script answered, or null. */
function flagReply(reply: unknown): 0 | 1 | null {
  const replies = repliesFor(reply, 1);
  const value = replies ? replies[0] : undefined;
  return value === 0 || value === 1 ? value : null;
}

/**
 * Takes ARGV[1] bytes when the count stays within ARGV[2], in one step: the
 * count another picture sees is never raised only for a moment (Codex X6,
 * 7059448151). A count that is not a whole number refuses and writes nothing.
 */
export const TAKE_PICTURE_BYTES = `-- marktmorgen:picture-bytes-take:v1
local bytes=tonumber(ARGV[1])
local limit=tonumber(ARGV[2])
if #KEYS~=1 or #ARGV~=2 or not bytes or not limit or bytes<=0 or limit<=0 or bytes~=math.floor(bytes) or limit~=math.floor(limit) then return 0 end
local raw=redis.call('GET',KEYS[1])
local count=0
if raw then
  count=tonumber(raw)
  if not count or count<0 or count~=math.floor(count) then return 0 end
end
if count+bytes>limit then return 0 end
redis.call('INCRBY',KEYS[1],bytes)
return 1
`;

/**
 * Gives back ARGV[1] bytes in one step, never below zero: the count another
 * picture sees is never lowered past zero only for a moment. A count that is
 * not a whole number is left as it is.
 */
export const GIVE_PICTURE_BYTES = `-- marktmorgen:picture-bytes-give:v1
local bytes=tonumber(ARGV[1])
if #KEYS~=1 or #ARGV~=1 or not bytes or bytes<=0 or bytes~=math.floor(bytes) then return 0 end
local raw=redis.call('GET',KEYS[1])
if not raw then return 1 end
local count=tonumber(raw)
if not count or count<0 or count~=math.floor(count) then return 0 end
if count<=bytes then redis.call('DEL',KEYS[1]) else redis.call('DECRBY',KEYS[1],bytes) end
return 1
`;

/**
 * Takes `bytes` of the store's pictures figure `limit` before a picture is
 * kept: true only when it fits and was counted. A reply that does not read
 * refuses the picture (rule 24); if the step did run, that picture's bytes
 * stay counted, which only ever refuses room and never lets a store past its
 * figure (an exact undo would need a record per picture, with its own cost).
 */
export async function takePictureBytes(folder: string, bytes: number, limit: number): Promise<boolean> {
  if (!IMAGE_FOLDER_PATTERN.test(folder) || !Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(limit) || limit <= 0 || !isRedisConfigured()) return false;
  try {
    return flagReply(await redisPipeline([["EVAL", TAKE_PICTURE_BYTES, 1, PICTURES_BYTES_KEY(folder), bytes, limit]])) === 1;
  } catch (error) {
    console.error("could not count a store's pictures", error);
  }
  return false;
}

/** Gives back `bytes` when a picture is deleted, never below zero. Best effort: never throws. */
export async function givePictureBytes(folder: string, bytes: number): Promise<void> {
  if (!IMAGE_FOLDER_PATTERN.test(folder) || !Number.isSafeInteger(bytes) || bytes <= 0 || !isRedisConfigured()) return;
  try {
    await redisPipeline([["EVAL", GIVE_PICTURE_BYTES, 1, PICTURES_BYTES_KEY(folder), bytes]]);
  } catch (error) {
    console.error("could not give back a store's pictures", error);
  }
}
