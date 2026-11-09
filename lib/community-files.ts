/**
 * The real file store behind lib/community-image.ts: Vercel Blob, private,
 * the same one product pictures and paid files live in. Kept apart from the
 * checks so they can be tried against a stand-in without a network.
 *
 * Since 18 October 2026 the pictures a community keeps have a figure
 * (lib/community-picture-rules.ts): each door given takes one place, at the
 * most a picture may weigh, before the picture can be sent; a picture taken
 * out of a post, a post deleted and a door never used (deleted a day on, by
 * the courses job) give it back.
 *
 *   nl:cimg:<hash of path>   who was given the door, for a day; once the picture is in a
 *                            post, a mark that it was taken, kept as long as the post keeps
 *                            it (taken from the store's data room with the post, PICTURE_MARK_BYTES)
 *   nl:cimg:n:<folder>       pictures the community keeps, doors not yet used included
 *   nl:cimg:doors            doors given and not yet used in a post, by when
 */
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { del, get, head } from "@/lib/blob";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import type { ImageStore } from "@/lib/community-image";
import { dataBytes } from "@/lib/store-data-rules";

async function firstBytes(path: string): Promise<Uint8Array | null> {
  const found = await get(path, { access: "private" });
  if (!found || found.statusCode !== 200 || !found.stream) return null;
  const reader = found.stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < 16) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    length += value.length;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

export const blobImages: ImageStore = {
  async head(path) {
    const found = await head(path);
    return { size: found.size, contentType: found.contentType };
  },
  firstBytes,
  async del(path) {
    await del(path);
  },
};

/** A day: the door is open five minutes, the post can be written later. */
const UPLOAD_TTL_SECONDS = 24 * 60 * 60;

function uploadKey(path: string): string {
  return `nl:cimg:${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
}

/**
 * What a picture's note holds once a post took it (takeCommunityUpload), for as long as the post keeps it: no door can
 * be noted for its name, and the sweep never deletes it. Since the security reviews of #3414 (Claude 2 and Claude 6,
 * 9 November 2026) it is never let lapse: plan closing removes a community's files and keeps its posts, which print
 * each picture's name, so after it neither the file nor a short mark held the name. Only deleting the picture
 * (dropCommunityImage, when the post goes or never got it) takes the mark away. It names the member only by a short
 * hash of their key (markOf), so only the member whose post took it can give it back, and no key of theirs is kept.
 * A tab never appears in a member's key.
 */
const TAKEN = "\ttaken\t";
const markOf = (author: string) => `${TAKEN}${createHash("sha256").update(`nimbus-cimg-taken:${author}`).digest("hex").slice(0, 16)}`;
/**
 * What a picture's mark keeps in the database, taken from the store's data room with the post that shows the picture
 * (lib/community.ts, postBytes): its key and its value, as one entry.
 */
export const PICTURE_MARK_BYTES = dataBytes([`nl:cimg:${"0".repeat(32)}`, markOf("")], 1);
/** How much longer than a door's day the sweep waits before it deletes the door's picture. */
const SWEEP_MARGIN_SECONDS = 60 * 60;

const countKey = (folder: string) => `nl:cimg:n:${folder}`;
const DOORS_KEY = "nl:cimg:doors";
/** The community's folder a picture's path is in: community/<folder>/<file>. */
const folderOf = (path: string) => (/^community\/([0-9a-f]{24})\//.exec(path) ?? [])[1] ?? "";

/**
 * Takes one of the pictures a community may keep, before its door is given:
 * false when they are all taken, or cannot be counted.
 */
export async function takePicturePlace(path: string, limit: number): Promise<boolean> {
  const folder = folderOf(path);
  if (!folder || !Number.isSafeInteger(limit) || limit <= 0 || !isRedisConfigured()) return false;
  try {
    const reply = await redisPipeline([["INCR", countKey(folder)]]);
    if (
      typeof reply !== "object" ||
      reply === null ||
      isProxy(reply) ||
      !Array.isArray(reply) ||
      Object.getPrototypeOf(reply) !== Array.prototype ||
      reply.length !== 1
    )
      return false;
    const keys = Reflect.ownKeys(reply);
    if (keys.length !== 2 || !keys.includes("0") || !keys.includes("length")) return false;
    const slot = Object.getOwnPropertyDescriptor(reply, "0");
    if (!slot || !Object.hasOwn(slot, "value")) return false;
    const count = slot.value;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) return false;
    if (count <= limit) return true;
    await redisPipeline([["DECR", countKey(folder)]]);
  } catch (error) {
    console.error("could not count a community picture", error);
  }
  return false;
}

/** Gives a picture's place back: it is deleted. Best effort: never throws. */
async function givePicturePlace(path: string): Promise<void> {
  const folder = folderOf(path);
  if (!folder || !isRedisConfigured()) return;
  try {
    const [left] = await redisPipeline([["DECR", countKey(folder)]]);
    if (Number(left) < 0) await redisPipeline([["SET", countKey(folder), 0]]);
  } catch (error) {
    console.error("could not give a community picture's place back", error);
  }
}

/** The pictures a community keeps now, doors not yet used included, for the studio. */
export async function picturesKept(communityFolder: string): Promise<number> {
  if (!/^[0-9a-f]{24}$/.test(communityFolder) || !isRedisConfigured()) return 0;
  try {
    const [raw] = await redisPipeline([["GET", countKey(communityFolder)]]);
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** A community whose pictures were all removed (lib/plan-closing.ts) keeps none. */
export async function forgetPictures(communityFolder: string): Promise<void> {
  if (!/^[0-9a-f]{24}$/.test(communityFolder) || !isRedisConfigured()) return;
  await redisPipeline([["DEL", countKey(communityFolder)]]);
}

/**
 * The note and its listing, in one step (Claude 6 on #3414, 9 November 2026: done in two, the member's own post
 * taking the name between them made the door give its place back while the take kept it, and the sweep gave it back
 * again). Only a name with no note and no mark is noted for the member, for a day, and listed for the sweep at this
 * door's own time (a plain ZADD: a listing left from an earlier door never makes this one look older); 1. A name
 * with a note or a mark: nothing changes; 0.
 *
 * KEYS[1] the picture's note, KEYS[2] the doors' list; ARGV[1] the member, ARGV[2] the note's seconds, ARGV[3] the
 * door's time in seconds, ARGV[4] the path. Modelled in lib/redis-memory.ts; not yet run on a real Redis.
 */
export const NOTE_PICTURE = `-- marktmorgen:community-picture-note:v1
if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', tonumber(ARGV[2])) then return 0 end
redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[4])
return 1`;

/**
 * Notes who was given the door for a picture's path, before it is given, and lists the path for the sweep, in one
 * script (NOTE_PICTURE): true only when this member's note is written and the path listed; false, with nothing
 * written, when the name already has a note (another door still open) or a mark (a picture a post took). Read
 * exactly (CX-123 rule 24): any other answer throws UnknownReplyError, and no door may be given then.
 */
export async function noteCommunityUpload(path: string, author: string, now = Date.now()): Promise<boolean> {
  const replies = repliesFor(
    await redisPipeline([["EVAL", NOTE_PICTURE, 2, uploadKey(path), DOORS_KEY, author, UPLOAD_TTL_SECONDS, Math.floor(now / 1000), path]]),
    1,
  );
  const noted = replies ? countOf(replies[0]) : null;
  if (noted !== 0 && noted !== 1) throw new UnknownReplyError("a community picture's door");
  return noted === 1;
}

/**
 * The take, in one step (pre-review of 9 November 2026: done in two, a sweep reading the note between them found it
 * gone and deleted the picture the post was taking). Only the member whose note it is takes it: the note becomes
 * the picture's mark, kept with no end (TAKEN), and the path comes off the sweep's list, together; 1. Any other
 * note, none, or a mark already: nothing changes; 0.
 *
 * KEYS[1] the picture's note, KEYS[2] the doors' list; ARGV[1] the member, ARGV[2] the mark, ARGV[3] the path.
 * Modelled in lib/redis-memory.ts; not yet run on a real Redis.
 */
export const TAKE_PICTURE = `-- marktmorgen:community-picture-take:v2
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[3])
return 1`;

/**
 * Whether this picture was sent by this member and not used yet; it is then
 * theirs for this one post only. Somebody else's picture, or one already in
 * a post, is refused and left alone.
 *
 * One script (TAKE_PICTURE): its note becomes the picture's mark (no later door can be noted for the name, and the
 * sweep keeps the picture, for as long as the post keeps it) and the path comes off the sweep's list at once, read exactly: an answer in another shape throws
 * UnknownReplyError, and the post is not made.
 */
export async function takeCommunityUpload(path: string, author: string): Promise<boolean> {
  const replies = repliesFor(
    await redisPipeline([["EVAL", TAKE_PICTURE, 2, uploadKey(path), DOORS_KEY, author, markOf(author), path]]),
    1,
  );
  const took = replies ? countOf(replies[0]) : null;
  if (took !== 0 && took !== 1) throw new UnknownReplyError("a community picture taken into a post");
  return took === 1;
}

/**
 * Gives a picture back to the member whose post took it, in one step: only their own mark becomes their note again,
 * for a day, and the path is listed for the sweep at that time; 1. Anything else: nothing changes; 0.
 *
 * KEYS[1] the picture's note, KEYS[2] the doors' list; ARGV[1] the mark, ARGV[2] the member, ARGV[3] the note's
 * seconds, ARGV[4] the time in seconds, ARGV[5] the path. Modelled in lib/redis-memory.ts; not yet run on a real Redis.
 */
export const UNTAKE_PICTURE = `-- marktmorgen:community-picture-untake:v1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
redis.call('ZADD', KEYS[2], tonumber(ARGV[4]), ARGV[5])
return 1`;

/**
 * Gives a picture this member's post took back to them, when the post could not use it (its file not there yet, or
 * not readable): theirs again, listed for the sweep, for when they send the form again, in one script
 * (UNTAKE_PICTURE), so the note is never written without its listing. Only the member whose post took it: any other
 * note or mark is left alone. Best effort.
 */
export async function untakeCommunityUpload(path: string, author: string, now = Date.now()): Promise<void> {
  await redisPipeline([["EVAL", UNTAKE_PICTURE, 2, uploadKey(path), DOORS_KEY, markOf(author), author, UPLOAD_TTL_SECONDS, Math.floor(now / 1000), path]]);
}

/** Gives back the place a door took when the door is not given after all. Best effort: never throws. */
export async function giveDoorPlaceBack(path: string): Promise<void> {
  await givePicturePlace(path);
}

/** Deletes a picture a post no longer needs, and gives its place back. Best effort: never throws. */
export async function dropCommunityImage(path: string | undefined | null): Promise<void> {
  if (!path) return;
  try {
    await del(path);
    // Its mark and any listing left for it go with the file (security reviews of #3414): the name is free again only
    // once nothing holds it, and a listing left behind can never give its place back a second time.
    await redisPipeline([
      ["DEL", uploadKey(path)],
      ["ZREM", DOORS_KEY, path],
    ]);
    await givePicturePlace(path);
  } catch (error) {
    console.error("could not delete a community picture", error);
  }
}

/**
 * Pictures whose door was given more than a day ago and that were never put
 * in a post: deleted, and their places given back. A few hundred a run at
 * most, for the courses job.
 */
export async function sweepCommunityUploads(now = Date.now(), limit = 300): Promise<number> {
  if (!isRedisConfigured()) return 0;
  // A day and an hour after its door (pre-review of 9 November 2026): its note, which lives a day by the database's
  // clock, is gone by then whatever the skew between the app's clock and the database's.
  const before = Math.floor(now / 1000) - UPLOAD_TTL_SECONDS - SWEEP_MARGIN_SECONDS;
  // Read exactly (CX-123 rule 24): a list in another shape is unknown, never "none to sweep".
  const found = repliesFor(await redisPipeline([["ZRANGEBYSCORE", DOORS_KEY, 0, before, "LIMIT", 0, limit]]), 1);
  const paths = found ? stringList(found[0]) : null;
  if (!paths) throw new UnknownReplyError("the community pictures to sweep");
  let swept = 0;
  for (const path of paths) {
    // Taken off the list first, so a run that stops halfway never gives a place back twice.
    // A throw (a timeout after it was sent) may have taken it off as well: unknown, the same as an odd answer.
    const answered = await redisPipeline([["ZREM", DOORS_KEY, path]]).then((replies) => repliesFor(replies, 1), () => null);
    const removed = answered ? countOf(answered[0]) : null;
    if (removed === 0) continue;
    if (removed !== 1) {
      // It may have been taken off the list: put back, so a later sweep deletes it and gives its place back once.
      // Its door ran out a day ago (UPLOAD_TTL_SECONDS), so nobody can have put it in a post since.
      console.error("could not tell whether an unused community picture was taken off the list; listed again");
      await redisPipeline([["ZADD", DOORS_KEY, before, path]]).catch(() => null);
      continue;
    }
    // Only a door's own picture that no post took is deleted (the audit of 9 November 2026): its note gone, read
    // exactly after the path came off the list, so no post can take it any more. A note that says a post took it
    // (TAKEN) keeps the file, and its place stays with the post; a note still open (its member may still post it) or
    // one that cannot be read is listed again for a later sweep. Unknown never deletes.
    const read = await redisPipeline([["GET", uploadKey(path)]]).then((replies) => repliesFor(replies, 1), () => null);
    const note = read ? read[0] : undefined;
    if (typeof note === "string" && note.startsWith(TAKEN)) {
      console.error("a community picture a post took was listed for the sweep; kept");
      continue;
    }
    if (note !== null) {
      await redisPipeline([["ZADD", DOORS_KEY, before, path]]).catch(() => null);
      continue;
    }
    try {
      // A door never used may never have been sent a file: deleting nothing is fine.
      await del(path);
    } catch (error) {
      console.error("could not delete an unused community picture", error);
      await redisPipeline([["ZADD", DOORS_KEY, before, path]]).catch(() => null);
      continue;
    }
    await givePicturePlace(path);
    swept += 1;
  }
  return swept;
}
