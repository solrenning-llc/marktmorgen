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
import type { PresignedUrlPayload } from "@vercel/blob";
import { uploadPresigned } from "@vercel/blob/client";
import { MULTIPART_ABOVE_BYTES, fileFolder, safeFileName } from "@/lib/product-file";
import { DOOR_ECHO_HEADER, doorFrom } from "@/lib/upload-door";
import { VaultUploadError, vaultUpload } from "@/lib/vault-upload";

/** The host's route that hands out doors into its file store. */
const UPLOAD_ROUTE = "/api/store/file";

/** The longest sentence of the studio's own that a refusal may carry. */
const MAX_WORDS = 1_000;

/** A reason is one lower-case word with underscores, as the route sends it. */
const REASON = /^[a-z][a-z_]{0,39}$/;

/** The host's route refused the door: its reason and, when it sent them, the studio's words. */
export class UploadRefused extends Error {
  constructor(readonly reason: string, readonly words: string | undefined) {
    super(reason);
    this.name = "UploadRefused";
  }
}

/**
 * Asks the host's route for a door, once, exactly as the client would
 * (lib/upload-door.ts says why the studio asks itself). A refusal comes back
 * as `UploadRefused` with the route's reason and words; an answer that is not
 * a refusal body is a server error, never words from elsewhere.
 */
async function askForDoor(pathname: string, clientPayload: string, multipart: boolean): Promise<PresignedUrlPayload> {
  const response = await fetch(UPLOAD_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname, clientPayload, multipart } }),
  });
  const body: unknown = await response.json().catch(() => null);
  const answer = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (!response.ok) {
    const reason = typeof answer.error === "string" && REASON.test(answer.error) ? answer.error : "server_error";
    const words = reason !== "server_error" && typeof answer.message === "string" && answer.message.trim() && answer.message.length <= MAX_WORDS ? answer.message : undefined;
    throw new UploadRefused(reason, words);
  }
  const door = doorFrom(answer.presignedUrlPayload);
  if (!door) throw new UploadRefused("server_error", undefined);
  return door;
}

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
  const door = await askForDoor(pathname, clientPayload, multipart);
  const result = await uploadPresigned(pathname, file, {
    access: "private",
    handleUploadUrl: UPLOAD_ROUTE,
    // The client asks the route again; this door is what it hands back.
    headers: { [DOOR_ECHO_HEADER]: JSON.stringify(door) },
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
