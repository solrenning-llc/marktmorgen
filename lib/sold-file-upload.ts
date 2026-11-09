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
 * Resolves with the path to tell the product, lesson or episode. A door that
 * says no throws its own reason (lib/upload-refusal.ts), on either store:
 * `uploadReason` reads its word and `uploadMessage` the creator's sentence.
 */
import { MULTIPART_ABOVE_BYTES, fileFolder, safeFileName } from "@/lib/product-file";
import { refusalOf, uploadThroughDoor } from "@/lib/upload-refusal";
import { vaultUpload } from "@/lib/vault-upload";

export { uploadMessage } from "@/lib/upload-refusal";

export async function uploadSoldFile(
  file: File,
  where: { folder: string; ownerId: string },
  onProgress: (percent: number) => void,
): Promise<string> {
  const kept = await vaultUpload(file, where.ownerId, safeFileName(file.name), { onProgress });
  if (kept) return kept.pathname;

  // Through the door that reads its own answer, so a refusal says why (lib/upload-refusal.ts).
  const result = await uploadThroughDoor(fileFolder(where.folder, where.ownerId) + safeFileName(file.name), file, {
    access: "private",
    door: "/api/store/file",
    clientPayload: JSON.stringify({ productId: where.ownerId }),
    // In parts once it is worth it, so a dropped connection costs one part
    // rather than the whole upload.
    multipart: file.size > MULTIPART_ABOVE_BYTES,
    onUploadProgress: (progress) => onProgress(progress.percentage),
  });
  return result.pathname;
}

/**
 * Why an upload failed, as the word its door answered (`wrong_type`,
 * `too_big`, `storage_full`, `slow_down`, `upload_stopped`, `studio_used`,
 * `two_step_required`, `locked`, `renewal_unpaid`, `files_unavailable`,
 * `signed_out`, `unknown` and the rest), or `server_error` when nobody gave
 * one. For the sentence, `uploadMessage`.
 */
export function uploadReason(thrown: unknown): string {
  return refusalOf(thrown).reason || "server_error";
}
