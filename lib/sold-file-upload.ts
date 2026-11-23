/**
 * Uploads a file that is sold, from the studio's browser, to whichever file
 * store takes new files.
 *
 * The store that charges nothing for a download when it is set up
 * (lib/vault-upload.ts); the host's own when it is not, exactly as before.
 * Every place in the studio that uploads a sold file — a product's, a price
 * option's, a lesson's, an episode's — goes through here, so none of them
 * can be left sending files to the dearer store.
 *
 * Resolves with the path to tell the product, lesson or episode. Throws what
 * the store's own uploader throws, or `UploadRefused` when the host's route
 * refuses the door: `uploadReason` reads every kind, and `uploadWords` gives
 * the studio's own sentence for a refusal when the route sent one.
 */
import { MULTIPART_ABOVE_BYTES, fileFolder, safeFileName } from "@/lib/product-file";
import { UploadRefused, uploadThroughDoor } from "@/lib/upload-through-door";
import { VaultUploadError, vaultUpload } from "@/lib/vault-upload";

// The route refused the door: kept here too for the places that read it from this file (lib/upload-through-door.ts).
export { UploadRefused };

/** The host's route that hands out doors into its file store. */
const UPLOAD_ROUTE = "/api/store/file";

export async function uploadSoldFile(
  file: File,
  where: { folder: string; ownerId: string },
  onProgress: (percent: number) => void,
): Promise<string> {
  const kept = await vaultUpload(file, where.ownerId, safeFileName(file.name), { onProgress });
  if (kept) return kept.pathname;

  const pathname = fileFolder(where.folder, where.ownerId) + safeFileName(file.name);
  const clientPayload = JSON.stringify({ productId: where.ownerId });
  // In parts once it is worth it, so a dropped connection costs one part
  // rather than the whole upload.
  const multipart = file.size > MULTIPART_ABOVE_BYTES;
  // Asked first, so a refusal says why, then sent with the door carried back (lib/upload-through-door.ts).
  const result = await uploadThroughDoor(UPLOAD_ROUTE, pathname, file, {
    access: "private",
    clientPayload,
    multipart,
    onUploadProgress: (progress) => onProgress(progress.percentage),
  });
  return result.pathname;
}

/**
 * Why an upload failed, as one of the words the studio has a sentence for:
 * `wrong_type`, `too_big`, `storage_full`, `slow_down`, `upload_stopped`,
 * `files_unavailable`, `signed_out`, `unknown`, or `server_error` for
 * anything else.
 */
export function uploadReason(thrown: unknown): string {
  if (thrown instanceof VaultUploadError) return thrown.reason;
  if (thrown instanceof UploadRefused) return thrown.reason;
  if (thrown instanceof Error && /content type|not allowed/i.test(thrown.message)) return "wrong_type";
  return "server_error";
}

/**
 * The studio's own sentence for why the host's route refused an upload, when
 * it sent one: the editors show it before their own sentence for the reason,
 * so "used" that means "could not be counted" is not told as "used up".
 */
export function uploadWords(thrown: unknown): string | undefined {
  return thrown instanceof UploadRefused ? thrown.words : undefined;
}
