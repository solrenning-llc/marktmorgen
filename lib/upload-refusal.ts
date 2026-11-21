/**
 * Why an upload from the studio's browser was refused, in words the creator can act on.
 *
 * Every upload asks a door on our server first (app/api/store/image/upload for a picture,
 * app/api/store/file and app/api/store/vault for a file that is sold), and a door that says no says
 * why: a spent studio window (with the window's own sentence), requests that could not be counted, a
 * team that requires a second step, a session held until its second step, a role without the
 * permission, a full storage, a paused plan. The file store's browser library (`uploadPresigned`)
 * reads only whether its door said yes and throws one fixed error otherwise, so the reason was lost
 * and every refusal read as "Something went wrong on our side".
 *
 * So the door is asked here, by a request that reads its answer (`askDoor`), and only a door that
 * said yes hands the library what it issued: the library's own request to the same door carries it
 * back in its client payload, and the door returns it unchanged without checking or signing anything
 * again (`handedBack`), so a studio request is counted once and nothing is issued twice. What it hands
 * back grants nothing the browser does not already hold.
 *
 * Runs in the browser; the door's half is lib/upload-hand-back.ts.
 */
import { uploadPresigned } from "@vercel/blob/client";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { HAND_BACK, type Issued, isIssued } from "@/lib/upload-hand-back";

/** A door, or the file store behind it, said no: `reason` is the door's word, `said` its own sentence when it sent one. */
export class UploadRefused extends Error {
  readonly reason: string;
  readonly said: string;
  /** Both read from a door's JSON, so anything but text (or a word past 60 characters) counts as none given. */
  constructor(reason: unknown, said: unknown = "") {
    const word = typeof reason === "string" && reason.length <= 60 ? reason : "";
    super(`upload ${word || "failed"}`);
    this.reason = word;
    this.said = typeof said === "string" ? said.slice(0, 600) : "";
  }
}

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
  if (thrown instanceof UploadRefused) return { reason: thrown.reason, said: thrown.said };
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
 * Asks `door` for one upload, by the library's own event, and reads its answer: what it issued when it said yes, or an
 * UploadRefused with its word (and sentence) when it said no. A door that cannot be reached or answers no word throws
 * an UploadRefused with an empty reason.
 */
export async function askDoor(door: string, pathname: string, clientPayload: string, multipart = false): Promise<Issued> {
  let response: Response;
  try {
    response = await fetch(door, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname, clientPayload, multipart } }),
    });
  } catch {
    throw new UploadRefused("");
  }
  const answer = (await response.json().catch(() => null)) as { presignedUrlPayload?: unknown; error?: unknown; message?: unknown } | null;
  if (response.ok && isIssued(answer?.presignedUrlPayload)) return answer.presignedUrlPayload;
  // A door that said yes without anything usable gave no reason.
  throw response.ok ? new UploadRefused("") : new UploadRefused(answer?.error, answer?.message);
}

type LibraryOptions = Parameters<typeof uploadPresigned>[2];

/**
 * Uploads `body` to `pathname` through `door`: asked first (askDoor), so a refusal throws the door's own reason, then
 * sent by the file store's library with what the door issued. Throws an UploadRefused for a refusal, or what the
 * library throws once the upload itself is under way.
 */
export async function uploadThroughDoor(
  pathname: string,
  body: Blob,
  options: Omit<LibraryOptions, "handleUploadUrl" | "clientPayload"> & { door: string; clientPayload: string },
): ReturnType<typeof uploadPresigned> {
  const { door, clientPayload, ...rest } = options;
  const issued = await askDoor(door, pathname, clientPayload, rest.multipart === true);
  return uploadPresigned(pathname, body, { ...rest, handleUploadUrl: door, clientPayload: JSON.stringify({ [HAND_BACK]: issued }) });
}
