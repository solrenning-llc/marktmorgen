/**
 * The one way the studio's browser uploads a file through one of our doors
 * (main's protocol, ff29bd12cf; made shared for every studio uploader by
 * #3171, decision of the author family, option (a)).
 *
 * The file store's client asks a door for its signed upload itself and, on
 * any refusal, throws a fixed error without the door's answer; in the browser
 * it binds `fetch` once, so the answer cannot be read on its way
 * (lib/upload-door.ts). So the studio asks the door itself, once, and reads a
 * refusal there (`askForDoor`): the door's reason and, when it sent them, the
 * studio's own words. With a door in hand, the client is called as before and
 * asks the route again, carrying the door in `x-upload-door`; the route hands
 * back exactly that door, nothing else (app/api/store/file/route.ts,
 * app/api/store/image/upload/route.ts).
 *
 * Runs in the browser. lib/sold-file-upload.ts (sold files) and
 * lib/upload-refusal.ts (pictures, with the studio's words) go through here.
 */
import type { PresignedUrlPayload } from "@vercel/blob";
import { uploadPresigned } from "@vercel/blob/client";
import { DOOR_ECHO_HEADER, doorFrom } from "@/lib/upload-door";

/** The longest sentence of the studio's own that a refusal may carry. */
const MAX_WORDS = 1_000;

/** A reason is one lower-case word with underscores, as the route sends it. */
const REASON = /^[a-z][a-z_]{0,39}$/;

/** The route refused the door: its reason and, when it sent them, the studio's words. */
export class UploadRefused extends Error {
  constructor(readonly reason: string, readonly words: string | undefined = undefined) {
    super(reason);
    this.name = "UploadRefused";
  }
}

/**
 * A door's refusal as the studio reads it, from any of our doors (the file and picture routes here, the vault door in
 * lib/vault-upload.ts): its reason when it is one lower-case word, else a server error; and the studio's own words
 * only for a reason that is not a server error, when they are text, not blank, and at most MAX_WORDS long. Anything
 * else is no words, never words from elsewhere (Claude 5 iacVn3r on #3171).
 */
export function readRefusal(answer: unknown): { reason: string; words: string | undefined } {
  const body = answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {};
  const reason = typeof body.error === "string" && REASON.test(body.error) ? body.error : "server_error";
  const words = reason !== "server_error" && typeof body.message === "string" && body.message.trim() && body.message.length <= MAX_WORDS ? body.message : undefined;
  return { reason, words };
}

/**
 * Asks `route` for a door, once, exactly as the client would. A refusal comes
 * back as `UploadRefused` with the route's reason and words; an answer that is
 * not a refusal body is a server error, never words from elsewhere.
 */
export async function askForDoor(route: string, pathname: string, clientPayload: string, multipart: boolean): Promise<PresignedUrlPayload> {
  const response = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname, clientPayload, multipart } }),
  });
  const body: unknown = await response.json().catch(() => null);
  const answer = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (!response.ok) {
    const { reason, words } = readRefusal(answer);
    throw new UploadRefused(reason, words);
  }
  const door = doorFrom(answer.presignedUrlPayload);
  if (!door) throw new UploadRefused("server_error", undefined);
  return door;
}

type ClientOptions = Parameters<typeof uploadPresigned>[2];

/**
 * Uploads `body` to `pathname` through `route`: the door asked first
 * (askForDoor), so a refusal throws its reason, then the client called with
 * that door carried back in `x-upload-door`. Throws `UploadRefused` for a
 * refusal, or what the client throws once the upload itself is under way.
 */
export async function uploadThroughDoor(
  route: string,
  pathname: string,
  body: Blob,
  options: Omit<ClientOptions, "handleUploadUrl" | "headers" | "clientPayload"> & { clientPayload: string },
): ReturnType<typeof uploadPresigned> {
  const door = await askForDoor(route, pathname, options.clientPayload, options.multipart === true);
  return uploadPresigned(pathname, body, {
    ...options,
    handleUploadUrl: route,
    // The client asks the route again; this door is what it hands back.
    headers: { [DOOR_ECHO_HEADER]: JSON.stringify(door) },
  });
}
