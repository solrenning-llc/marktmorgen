/**
 * The file store that charges nothing for a download: the rules.
 *
 * A file a creator sells used to sit in the host's own file store, which
 * charges for every gigabyte that leaves it: five cents, and eleven for a
 * file too large to cache. A paid download is never refused (lib/delivery.ts),
 * so that was the one cost here with no ceiling, and inside the published
 * allowance alone it could take most of what the cheapest plan brings in.
 *
 * So the files that are sold live in a store that charges for keeping a file
 * and nothing for sending it (lib/vault.ts says which, and why). This file
 * holds what can be said without asking it anything, so the studio's browser
 * reads the same rules the server holds an upload to:
 *
 *   - where such a file is written down. A product, a price option, a lesson
 *     or an episode keeps one handle to a file, a path (lib/product-file.ts).
 *     A file in this store has a path of its own shape,
 *     `vault/<store's folder>/<what it hangs on>/<token>-<name>`, so
 *     everything that already carries a file carries this one, and the two
 *     stores are told apart by the path alone, as a lesson's video at the
 *     video service is (lib/stream-rules.ts);
 *   - how an upload is cut into pieces, and how large each one is.
 *
 * Nothing here touches the network or a secret.
 */

/**
 * Where the studio's browser sends a file's pieces and a lesson's page plays
 * a video from, as a page's policy names it (lib/csp.ts). The account is
 * part of the address and is not known to a page built ahead of time, so the
 * policy names every account's: the store answers nothing there without a
 * signature of ours.
 */
export const VAULT_FILES = "https://*.r2.cloudflarestorage.com";

/** The first piece of the path of a file this store keeps. */
export const VAULT_PREFIX = "vault";

const FOLDER_PATTERN = /^[0-9a-f]{32}$/;
/** What a file hangs on: a product, a price option, a lesson. Their ids are short and plain. */
const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const TOKEN_PATTERN = /^[0-9a-f]{16}$/;
/** A name the store keeps a file under: plain characters only, so its address never needs escaping. */
const KEY_NAME_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

/**
 * A file's name as the store keeps it. What the creator called the file is
 * kept beside the path and is what a buyer's download is saved as; this is
 * only the last piece of an address, where anything but plain characters is
 * one more thing to escape, sign and get wrong.
 */
export function keyName(name: string): string {
  const plain = name
    .normalize("NFKD")
    // An accent, once parted from its letter, is dropped: "é" is kept as "e".
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-+\./g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  return plain.slice(-120) || "file";
}

/** The folder of one store's files on one product, option or lesson. */
export function vaultFolder(storeFolder: string, ownerId: string): string {
  return `${VAULT_PREFIX}/${storeFolder}/${ownerId}/`;
}

/** The path a file is kept under. `token` is random, so two files of one name never meet. */
export function vaultPath(storeFolder: string, ownerId: string, token: string, name: string): string {
  return `${vaultFolder(storeFolder, ownerId)}${token}-${keyName(name)}`;
}

/** The store's folder, what the file hangs on and its name in such a path; null for any other path. */
export function readVaultPath(pathname: unknown): { folder: string; ownerId: string; name: string } | null {
  if (typeof pathname !== "string") return null;
  const parts = pathname.split("/");
  if (parts.length !== 4 || parts[0] !== VAULT_PREFIX) return null;
  const [, folder, ownerId, last] = parts;
  if (!FOLDER_PATTERN.test(folder) || !OWNER_PATTERN.test(ownerId)) return null;
  if (!TOKEN_PATTERN.test(last.slice(0, 16)) || last[16] !== "-" || !KEY_NAME_PATTERN.test(last.slice(17))) return null;
  return { folder, ownerId, name: last.slice(17) };
}

/** Whether a path names anything this store keeps: a file, or a copy made from one (lib/pdf-stamp.ts). */
export function isVaultPath(pathname: unknown): boolean {
  if (typeof pathname !== "string" || pathname.includes("..") || pathname.includes("//")) return false;
  const parts = pathname.split("/");
  return parts.length >= 4 && parts[0] === VAULT_PREFIX && FOLDER_PATTERN.test(parts[1]) && parts.slice(2).every((piece) => KEY_NAME_PATTERN.test(piece));
}

/** Whether a path is a file of this store, on this product, option or lesson. */
export function ownsVaultPath(pathname: unknown, storeFolder: string, ownerId: string): boolean {
  const parts = readVaultPath(pathname);
  return parts !== null && parts.folder === storeFolder && parts.ownerId === ownerId;
}

/**
 * One piece of an upload. The store wants every piece but the last to be the
 * same size, at least five megabytes, and at most ten thousand of them.
 * Sixteen megabytes makes the largest file here three hundred and twenty
 * pieces, and a dropped line costs one of them.
 */
export const PIECE_BYTES = 16 * 1024 * 1024;
/** How many pieces the browser is given addresses for at a time. */
export const PIECES_PER_ASK = 8;
/** How long an address for one piece is good for. */
export const PIECE_SECONDS = 60 * 60;
/** How long an upload may take from its first piece to its last. */
export const UPLOAD_SECONDS = 24 * 60 * 60;
/**
 * How many pages of a store's vault listing a measurement of what it keeps
 * reads at most (lib/vault.ts, vaultHeld), a thousand names to a page. Each
 * page is one ListObjectsV2, a Class A operation on R2; the cost table
 * prices an upload start from this (lib/spend-cost-table.ts).
 */
export const VAULT_LIST_PAGES = 20;
/**
 * Requests one measurement of a file makes at most (lib/vault.ts, headVault):
 * a HEAD, and a one-byte ranged GET when the answer states no plain length.
 * Both are Class B operations on R2.
 */
export const VAULT_MEASURE_REQUESTS = 2;

/** How many pieces a file of this size goes up in. A file of one piece or less goes up whole. */
export function pieceCount(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / PIECE_BYTES));
}

/** The size of piece `n` (from 1) of a file of `bytes`: every one full but the last. Zero for a piece there is none of. */
export function pieceSize(bytes: number, n: number): number {
  const count = pieceCount(bytes);
  if (!Number.isInteger(n) || n < 1 || n > count) return 0;
  return n < count ? PIECE_BYTES : bytes - PIECE_BYTES * (count - 1);
}
