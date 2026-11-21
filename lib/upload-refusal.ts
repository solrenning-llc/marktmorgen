/**
 * Why an upload from the studio's browser was refused, in words the creator can act on.
 *
 * Every studio upload asks its door first, through the one protocol (lib/upload-through-door.ts: main's, from
 * ff29bd12cf), so a door that says no says why: a spent studio window (with the window's own sentence), requests that
 * could not be counted, a team that requires a second step, a session held until its second step, a role without the
 * permission, a full storage, a paused plan. Before, every refusal read as "Something went wrong on our side".
 *
 * Here are only the words; the upload itself goes through lib/upload-through-door.ts (#3171, decision of the author
 * family, option (a): one protocol, no hand-back of this file's own).
 */
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { UploadRefused, uploadThroughDoor as throughDoor } from "@/lib/upload-through-door";

export { UploadRefused };

/** What an upload that failed for a reason nobody gave says: true of every studio uploader, which changes nothing until its upload is in. */
export const UPLOAD_DID_NOT_FINISH = "The upload did not finish, and nothing was changed. Try again in a moment.";

/** The door's own sentence is the one shown for these: the window it counts in, or why it could not count. */
const SAID_BY_THE_DOOR = new Set(["studio_used", "studio_unavailable"]);

/** Who may upload, and whether the studio could count it: the same everywhere, so these come before a form's own words. */
const ACCESS: Record<string, string> = {
  studio_used: "Your studio has used its requests for now, so the upload did not start. Try again later.",
  studio_unavailable: "We could not check your studio's requests just now, so the upload did not start. Try again in a moment.",
  two_step_required:
    "This store's owner asks everyone on the team to log in with a second step. Log in again with your passkey, or with the emailed link and your app's code, then try again.",
  locked: STUDIO_MESSAGES.locked,
  role: STUDIO_MESSAGES.role,
  forbidden: STUDIO_MESSAGES.role,
  store_gone: STUDIO_MESSAGES.store_gone,
  gone: STUDIO_MESSAGES.store_gone,
};

/** The doors' other words, when the form has none of its own. */
const GENERIC: Record<string, string> = {
  ...STUDIO_MESSAGES,
  signed_out: "Your session ended. Log in again.",
  none: "This account has no store yet.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  unknown: "What this upload was for is no longer on your store. Reload this page to see it as it is now.",
  invalid: "The upload was not accepted. Reload this page, then choose your file again.",
  too_big: "That file is larger than this upload allows.",
  wrong_type: "That kind of file cannot be uploaded here.",
};

/** The door's word and sentence behind anything an upload threw; an empty reason when nobody gave one. */
export function refusalOf(thrown: unknown): { reason: string; said: string } {
  if (thrown instanceof UploadRefused) return { reason: thrown.reason, said: thrown.words ?? "" };
  // The file store itself turning a file's type away (its own error names the content type).
  if (thrown instanceof Error && /content type|not allowed/i.test(thrown.message)) return { reason: "wrong_type", said: "" };
  return { reason: "", said: "" };
}

/**
 * The sentence for a failed upload: the door's own for a spent window or an uncounted one; then who may upload; then
 * the form's own words (`own`); then the studio's; and for a reason nobody gave, or a server error, that the upload did
 * not finish and nothing was changed (never a guess about whose side it was on).
 */
export function uploadMessage(thrown: unknown, own: Record<string, string> = {}): string {
  const { reason, said } = refusalOf(thrown);
  if (!reason || reason === "server_error") return UPLOAD_DID_NOT_FINISH;
  if (SAID_BY_THE_DOOR.has(reason) && said.trim()) return said;
  return ACCESS[reason] ?? own[reason] ?? GENERIC[reason] ?? UPLOAD_DID_NOT_FINISH;
}

/**
 * Uploads `body` to `pathname` through `door`, by the one protocol (lib/upload-through-door.ts): asked first, so a
 * refusal throws the door's own reason, then sent with the door carried back. Throws an UploadRefused for a refusal,
 * or what the file store's client throws once the upload itself is under way.
 */
export function uploadThroughDoor(
  pathname: string,
  body: Blob,
  options: Parameters<typeof throughDoor>[3] & { door: string },
): ReturnType<typeof throughDoor> {
  const { door, ...rest } = options;
  return throughDoor(door, pathname, body, rest);
}
