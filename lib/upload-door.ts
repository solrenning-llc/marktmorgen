/**
 * The signed door into the host's file store, carried from the studio's own
 * ask to the @vercel/blob client without asking the route twice.
 *
 * Why: the client fetches its door from `/api/store/file` itself and, on any
 * refusal, throws a fixed "Failed to retrieve the presigned URL" without the
 * answer's body (@vercel/blob 2.8.0, retrievePresignedUrlPayload), so the
 * studio's own words for a refusal never reached the creator. And in the
 * browser it binds `fetch` once, when it loads, so the answer cannot be read
 * on its way either.
 *
 * So the studio asks for the door itself (lib/sold-file-upload.ts) and reads a
 * refusal there. With a door in hand it calls the client as before, which asks
 * the route again; that second ask carries the door in `DOOR_ECHO_HEADER`, and
 * the route hands back exactly that door, nothing else: no admission, no
 * count, no budget, no signing, no store read (app/api/store/file/route.ts).
 * A door is only good for the browser that holds it, so returning a caller's
 * own door to it gives that caller nothing it did not already have.
 */
import type { PresignedUrlPayload } from "@vercel/blob";

/** The request header that carries a door the studio already holds. */
export const DOOR_ECHO_HEADER = "x-upload-door";

/** A door is a delegation token, a signature and a few parameters: well under this. */
export const MAX_DOOR_BYTES = 8_000;

/** At most this many parameters in a door. */
const MAX_DOOR_PARAMS = 32;

/** Printable ASCII only: what a header can carry unchanged. */
const PRINTABLE = /^[\x20-\x7e]*$/;

/**
 * The door in `value`, when it is exactly the shape the client uses
 * (`PresignedUrlPayload`) and fits a header; null for anything else.
 */
export function doorFrom(value: unknown): PresignedUrlPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { delegationToken, signature, params, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (typeof delegationToken !== "string" || !delegationToken || !PRINTABLE.test(delegationToken)) return null;
  if (typeof signature !== "string" || !signature || !PRINTABLE.test(signature)) return null;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const entries = Object.entries(params as Record<string, unknown>);
  if (entries.length > MAX_DOOR_PARAMS) return null;
  const kept: Record<string, string> = {};
  for (const [name, param] of entries) {
    if (typeof param !== "string" || !PRINTABLE.test(name) || !PRINTABLE.test(param)) return null;
    kept[name] = param;
  }
  const door = { delegationToken, signature, params: kept };
  return JSON.stringify(door).length <= MAX_DOOR_BYTES ? door : null;
}

/** The door a header carries, or null when it is absent, too long or not a door. */
export function doorFromHeader(header: string | null): PresignedUrlPayload | null {
  if (header === null || header.length > MAX_DOOR_BYTES) return null;
  try {
    return doorFrom(JSON.parse(header));
  } catch {
    return null;
  }
}
