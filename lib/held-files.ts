/**
 * Files kept for a child-safety report (C1-20261109-1546-TODOS-70, unit 3b;
 * procedure in docs/incident-response.md section 8).
 *
 * When a report takes a product off the store (lib/child-safety.ts), every
 * file it hands over is marked here for HELD_FILE_SECONDS: its file, its
 * options' files, its pictures, its lessons' videos and files and its
 * episodes. The mark is checked where every file passes, so no caller has to
 * know about it:
 *
 *   - deleting: lib/blob.ts del, lib/vault.ts deleteVault and the video
 *     service (lib/stream.ts) leave a marked file where it is, so closing a
 *     store, erasing a person, a plan's end or a creator's edit never
 *     destroys what the law asks to be kept (18 U.S.C. § 2258A(h));
 *   - handing out: lib/file-store.ts fileUrl, lib/serve-file.ts and the
 *     public picture route refuse a marked file, so nobody, buyer or visitor,
 *     gets it from Marktmorgen while it is held.
 *
 * The key is a hash of the file's identity, never its path, so a listing of
 * keys says nothing about which store or file it is. A reply that cannot be
 * read throws: the caller keeps the file and refuses to hand it out.
 *
 *   nl:csa:file:<sha256(identity)>   "1"   400 days
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { readStreamPath } from "@/lib/stream-rules";

/** A year from the report, as 18 U.S.C. § 2258A(h) asks, and a margin. Same as the product's keep mark. */
export const HELD_FILE_SECONDS = 400 * 86_400;

/** A video the service keeps is known by its id, which is all a store-wide removal sees; any other file by its path. */
export function heldFileIdentity(pathname: string): string {
  const video = readStreamPath(pathname);
  return video ? `v:${video.id}` : `p:${pathname}`;
}

const keyOf = (identity: string) => `nl:csa:file:${createHash("sha256").update(identity).digest("hex")}`;

/** Marks files as kept. True only when every mark was written. */
export async function holdFiles(pathnames: string[]): Promise<boolean> {
  const identities = [...new Set(pathnames.filter(Boolean).map(heldFileIdentity))];
  if (!identities.length) return true;
  const replies = repliesFor(
    await redisPipeline(identities.map((identity) => ["SET", keyOf(identity), "1", "EX", HELD_FILE_SECONDS])),
    identities.length,
  );
  return replies !== null && replies.every((reply) => reply === "OK");
}

/** Which of these identities are kept. Throws when a reply cannot be read. */
export async function heldAmong(identities: string[]): Promise<Set<string>> {
  const unique = [...new Set(identities)];
  // With no store there can be no mark.
  if (!unique.length || !isRedisConfigured()) return new Set();
  const replies = repliesFor(await redisPipeline(unique.map((identity) => ["GET", keyOf(identity)])), unique.length);
  if (!replies) throw new Error("A held-file mark could not be read");
  const held = new Set<string>();
  unique.forEach((identity, n) => {
    if (replies[n] === "1") held.add(identity);
    else if (replies[n] !== null) throw new Error("A held-file mark could not be read");
  });
  return held;
}

/** Whether a file is kept for a report. Throws when that cannot be read. */
export async function isFileHeld(pathname: string): Promise<boolean> {
  return (await heldAmong([heldFileIdentity(pathname)])).size > 0;
}

/** A blob address as a path: the SDK takes either, the marks are by path. */
function asPath(pathname: string): string {
  if (!/^https?:\/\//i.test(pathname)) return pathname;
  try {
    return decodeURIComponent(new URL(pathname).pathname.replace(/^\/+/, ""));
  } catch {
    return pathname;
  }
}

/** The files that may be deleted: the ones not kept. Throws when that cannot be read, so nothing is deleted. */
export async function deletable(pathnames: string[]): Promise<string[]> {
  const held = await heldAmong(pathnames.map((pathname) => heldFileIdentity(asPath(pathname))));
  if (!held.size) return pathnames;
  return pathnames.filter((pathname) => !held.has(heldFileIdentity(asPath(pathname))));
}
