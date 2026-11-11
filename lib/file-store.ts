/**
 * One file, whichever store keeps it.
 *
 * A file that is sold lives in one of two stores: the one that charges
 * nothing for a download (lib/vault.ts), where every new one goes once that
 * store is set up, or the host's own (lib/blob.ts), where files uploaded
 * before then stay and go on working. Which one is read from the file's
 * path (lib/vault-rules.ts), so nothing that carries a file has to know.
 *
 * Every server file that measures, deletes, reads or hands out a sold file
 * does it through here. A caller that went to one store directly would be
 * right for the files of that store and silently wrong for the rest.
 */
import * as blob from "@/lib/blob";
import { deleteVault, headVault, listVault, readVault, vaultHeld, vaultUrl, writeVault } from "@/lib/vault";
import { BLOB_LIST_PAGES } from "@/lib/storage-rules";
import { VAULT_PREFIX, isVaultPath } from "@/lib/vault-rules";

export type Measured = { pathname: string; size: number; contentType: string };

/** How big a file is and what it is, by its store's own measure. Throws when it is not there or cannot be asked about. */
export async function headFile(pathname: string): Promise<Measured> {
  if (isVaultPath(pathname)) {
    const found = await headVault(pathname);
    if (!found || found === "unreachable") throw new Error(found ? "the file store could not be reached" : "the file is not there");
    return { pathname, size: found.bytes, contentType: found.contentType };
  }
  const found = await blob.head(pathname);
  return { pathname: found.pathname, size: found.size, contentType: found.contentType };
}

/** Deletes files, each from the store that keeps it. Throws when one could not be. */
export async function deleteFile(pathnames: string | string[]): Promise<void> {
  const all = Array.isArray(pathnames) ? pathnames : [pathnames];
  const here = all.filter((pathname) => isVaultPath(pathname));
  const there = all.filter((pathname) => !isVaultPath(pathname));
  if (here.length && !(await deleteVault(here))) throw new Error("a file could not be deleted");
  if (there.length) await blob.del(there);
}

/**
 * An address a browser can fetch the file from for `seconds`, straight from
 * its store. Null when it could not be made.
 *
 * `saveAs` means the file is handed over to be saved, never opened in the
 * tab, whichever store keeps it. The store that charges nothing to send
 * (lib/vault.ts) saves it under that name. The host's own (Vercel Blob) is
 * asked for a download with `download=1`, the switch the SDK's own
 * `downloadUrl` uses (MM-SA-29); it saves the file under the last part of
 * its path, not under `saveAs`. The switch sits outside the signed part, as
 * the SDK's `cache=0` does, so the signature is the SDK's, untouched.
 * Without `saveAs` (a lesson's video, a podcast episode) the address is for
 * playing in place.
 */
export async function fileUrl(pathname: string, seconds: number, saveAs?: string): Promise<string | null> {
  if (isVaultPath(pathname)) return vaultUrl(pathname, seconds, saveAs);
  try {
    const token = await blob.issueSignedToken({ pathname, operations: ["get"], validUntil: Date.now() + seconds * 1000 });
    const { presignedUrl } = await blob.presignUrl(token, { operation: "get", pathname, access: "private" });
    if (saveAs === undefined) return presignedUrl;
    const url = new URL(presignedUrl);
    url.searchParams.set("download", "1");
    return url.toString();
  } catch (error) {
    console.error("signing a file's address failed", error);
    return null;
  }
}

/** Reads a small file whole, refusing to hold more than `limit` bytes. Null when it is missing or too big. */
export async function readFileWhole(pathname: string, limit: number): Promise<Uint8Array | null> {
  if (isVaultPath(pathname)) return readVault(pathname, limit);
  const result = await blob.get(pathname, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const reader = result.stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
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

/** Writes a small file whole, private, in place of whatever was at that path. Throws when it could not be. */
export async function writeFileWhole(pathname: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if (isVaultPath(pathname)) {
    if (!(await writeVault(pathname, bytes, contentType))) throw new Error("a file could not be written");
    return;
  }
  await blob.put(pathname, Buffer.from(bytes), { access: "private", contentType, addRandomSuffix: false, allowOverwrite: true });
}

/**
 * Every path kept under a prefix, in the store the prefix belongs to. Throws when it cannot be read, or when a
 * page is not in its exact shape (CX-123 rule 24): "has more" without a new cursor, a cursor handed out twice, a
 * page that does not say whether more follows, or a path outside the prefix is unknown, never the end of the
 * folder, so a caller deleting what is listed never takes a partial folder for the whole one.
 */
export async function listFiles(prefix: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  if (prefix.startsWith(`${VAULT_PREFIX}/`)) {
    let cursor: string | undefined;
    do {
      const page = await listVault(prefix, cursor);
      if (!page) throw new Error("the file store could not be listed");
      out.push(...page.files.map((file) => file.pathname));
      cursor = page.cursor ?? undefined;
      if (cursor !== undefined && seen.has(cursor)) throw new Error("incomplete file store listing");
      if (cursor !== undefined) seen.add(cursor);
    } while (cursor);
    return out;
  }
  let cursor: string | undefined;
  for (;;) {
    const page = await blob.list({ prefix, cursor, limit: 1000 });
    if (!page || !Array.isArray(page.blobs) || typeof page.hasMore !== "boolean") throw new Error("invalid storage listing");
    for (const entry of page.blobs) {
      if (!entry || typeof entry.pathname !== "string" || !entry.pathname.startsWith(prefix)) throw new Error("invalid storage entry");
      out.push(entry.pathname);
    }
    if (!page.hasMore) return out;
    if (typeof page.cursor !== "string" || !page.cursor || seen.has(page.cursor)) throw new Error("incomplete storage listing");
    seen.add(page.cursor);
    cursor = page.cursor;
  }
}

/**
 * Complete bytes in both file stores. Throws on unavailable, invalid or
 * incomplete listings: a partial total cannot authorize another upload.
 */
export async function filesHeld(folder: string): Promise<number> {
  let bytes = 0;
  let cursor: string | undefined;
  const seen = new Set<string>();
  const paths = new Set<string>();
  let complete = false;
  for (let page = 0; page < BLOB_LIST_PAGES; page += 1) {
    const answer = await blob.list({ prefix: `stores/${folder}/`, limit: 1000, cursor });
    if (!answer || !Array.isArray(answer.blobs) || answer.blobs.length > 1000 || typeof answer.hasMore !== "boolean") throw new Error("invalid storage listing");
    for (const entry of answer.blobs) {
      if (!entry || typeof entry.pathname !== "string" || !entry.pathname.startsWith(`stores/${folder}/`) ||
          paths.has(entry.pathname) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("invalid storage entry");
      paths.add(entry.pathname);
      bytes += entry.size;
      if (!Number.isSafeInteger(bytes)) throw new Error("invalid storage total");
    }
    if (!answer.hasMore) { complete = true; break; }
    if (!answer.cursor || seen.has(answer.cursor)) throw new Error("incomplete storage listing");
    seen.add(answer.cursor);
    cursor = answer.cursor;
  }
  if (!complete) throw new Error("storage listing exceeded page limit");
  const vault = await vaultHeld(folder);
  if (vault === null || !Number.isSafeInteger(vault) || vault < 0 || !Number.isSafeInteger(bytes + vault)) throw new Error("incomplete vault measurement");
  return bytes + vault;
}
