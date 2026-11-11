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
 *   nl:cimg:<hash of path>   who was given the door, for a day
 *   nl:cimg:n:<folder>       pictures the community keeps, doors not yet used included
 *   nl:cimg:doors            doors given and not yet used in a post, by when
 */
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { del, get, head } from "@/lib/blob";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import type { ImageStore } from "@/lib/community-image";

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

/** Notes who was given the door for a picture's path, when it is given. */
export async function noteCommunityUpload(path: string, author: string, now = Date.now()): Promise<void> {
  await redisPipeline([
    ["SET", uploadKey(path), author, "NX", "EX", UPLOAD_TTL_SECONDS],
    ["ZADD", DOORS_KEY, "NX", Math.floor(now / 1000), path],
  ]);
}

/**
 * Whether this picture was sent by this member and not used yet; it is then
 * theirs for this one post only. Somebody else's picture, or one already in
 * a post, is refused and left alone.
 */
export async function takeCommunityUpload(path: string, author: string): Promise<boolean> {
  const [held] = await redisPipeline([["GETDEL", uploadKey(path)]]);
  if (held === author) {
    // In a post now: no longer a door to sweep.
    await redisPipeline([["ZREM", DOORS_KEY, path]]).catch(() => null);
    return true;
  }
  if (typeof held === "string" && held) {
    await redisPipeline([["SET", uploadKey(path), held, "NX", "EX", UPLOAD_TTL_SECONDS]]).catch(() => null);
  }
  return false;
}

/** Deletes a picture a post no longer needs, and gives its place back. Best effort: never throws. */
export async function dropCommunityImage(path: string | undefined | null): Promise<void> {
  if (!path) return;
  await removeCommunityImage(path);
}

/**
 * Deletes a picture, then, once the file is gone, lets `forget` take away what names it (a held post's line), and only
 * once that is confirmed gives its place back: a picture whose file could not be deleted keeps its name where an
 * erasure finds it again (Codex G on #3020, 6751455863), and one tried again is never given back twice. True only when
 * the file and the name are both confirmed gone. Never throws.
 */
export async function removeCommunityImage(path: string, forget: () => Promise<boolean> = async () => true): Promise<boolean> {
  try {
    await del(path);
  } catch (error) {
    console.error("could not delete a community picture", error);
    return false;
  }
  const forgot = await forget().catch(() => false);
  if (forgot) await givePicturePlace(path);
  return forgot;
}

/**
 * Pictures whose door was given more than a day ago and that were never put
 * in a post: deleted, and their places given back. A few hundred a run at
 * most, for the courses job.
 */
export async function sweepCommunityUploads(now = Date.now(), limit = 300): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const before = Math.floor(now / 1000) - UPLOAD_TTL_SECONDS;
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
