/**
 * The session cookie and a session id's shape, with no import, so a route can refuse a caller holding no session
 * before anything is read (lib/auth.ts keeps the sessions themselves and re-exports these).
 */

export const SESSION_COOKIE = "nl_session";

/** A session id's shape (64 hex characters, as lib/auth.ts openSession issues); anything else is no session. */
export function sessionIdShaped(id: string | undefined): id is string {
  return typeof id === "string" && /^[0-9a-f]{64}$/.test(id);
}
