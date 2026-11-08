/**
 * The door's half of lib/upload-refusal.ts, with no import, so a route reads it without the file store's browser
 * library: the browser asks a door first and reads its answer, then the library's own request to the same door
 * carries back what was issued, and `handedBack` gives it back unchanged.
 */

/** What a door issues for one upload (the library's own shape). */
export type Issued = { delegationToken: string; signature: string; params: Record<string, string> };

/** The key the issued upload rides back under, in the client payload of the library's request to the same door. */
export const HAND_BACK = "handBack";

/** An issued upload in its exact shape, within sizes no real one comes near; anything else is not one. */
export function isIssued(value: unknown): value is Issued {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { delegationToken, signature, params } = value as Record<string, unknown>;
  return (
    typeof delegationToken === "string" && delegationToken.length > 0 && delegationToken.length <= 8_000 &&
    typeof signature === "string" && signature.length > 0 && signature.length <= 1_000 &&
    !!params && typeof params === "object" && !Array.isArray(params) &&
    Object.entries(params).length <= 40 && Object.values(params).every((each) => typeof each === "string" && each.length <= 2_000)
  );
}

/**
 * On the door: the library's request carrying back what this door issued a moment ago (askDoor), answered with it
 * unchanged, nothing checked, counted or signed again; null for any other request, which the door handles as before.
 */
export function handedBack(body: unknown): { type: "blob.generate-presigned-url"; presignedUrlPayload: Issued } | null {
  if (!body || typeof body !== "object") return null;
  const { type, payload } = body as { type?: unknown; payload?: { clientPayload?: unknown } };
  if (type !== "blob.generate-presigned-url" || typeof payload?.clientPayload !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.clientPayload);
  } catch {
    return null;
  }
  const issued = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[HAND_BACK] : undefined;
  return isIssued(issued) ? { type, presignedUrlPayload: issued } : null;
}
