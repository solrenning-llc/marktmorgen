/**
 * The studio session cookie's name, and the move from nl_session to __Host-nl_session (the security audit of 14
 * November 2026). A __Host- cookie is Secure, Path=/ and has no Domain, so a subdomain of ours can neither plant
 * nor overwrite it. Nobody is logged out by the move: until LEGACY_SESSION_COOKIE_UNTIL the old cookie still lets a
 * browser in, and the answer to it writes the new cookie and clears the old one. The code that reads the session
 * goes on reading SESSION_COOKIE: the proxy hands it the right value (carrySessionCookie). Over plain http (a laptop
 * running the site) a __Host- cookie cannot be kept, so the name stays nl_session there.
 *
 * Pure: read by proxy.ts, which runs before every page and every /api/ route.
 */

/** The name the code reads the session under, and the cookie's name over http. */
export const SESSION_COOKIE = "nl_session";
/** The cookie's name over https. */
export const HOST_SESSION_COOKIE = "__Host-nl_session";
/**
 * Until when the old cookie still lets a browser in over https: more than a session's whole life (30 days) after
 * the move can reach anyone, so every session opened before it has ended or been swapped by then. Moved forward,
 * never back, if the move ships later than the first days of January 2027.
 */
export const LEGACY_SESSION_COOKIE_UNTIL = Date.UTC(2027, 1, 1);

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_ID = /^[0-9a-f]{64}$/;

export function sessionCookieName(secure: boolean): string {
  return secure ? HOST_SESSION_COOKIE : SESSION_COOKIE;
}

/** The session cookie as written: HttpOnly, SameSite=Lax, Path=/, and over https Secure under the __Host- name. */
export function writtenSessionCookie(id: string, secure: boolean, maxAge = SESSION_SECONDS): string {
  return [`${sessionCookieName(secure)}=${id}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax", secure ? "Secure" : ""].filter(Boolean).join("; ");
}

/** What signing out sends: every name the session may be under, cleared. */
export function clearedSessionCookies(secure: boolean): string[] {
  const clear = (name: string, withSecure: boolean) => `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${withSecure ? "; Secure" : ""}`;
  return secure ? [clear(HOST_SESSION_COOKIE, true), clear(SESSION_COOKIE, true)] : [clear(SESSION_COOKIE, false)];
}

function pairs(header: string): [string, string][] {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf("=");
      return at < 0 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)];
    });
}

/**
 * The request's cookies as the code should read them, and the cookies the answer should set, over https:
 *   - a __Host-nl_session is the session, whatever nl_session says; a nl_session beside it is cleared;
 *   - an nl_session alone is the session until LEGACY_SESSION_COOKIE_UNTIL, and is swapped for the new cookie;
 *     from then on it is not read, and is cleared.
 * `headers` is null when nothing changes (the request goes on as it came), and so over http.
 */
export function carrySessionCookie(cookieHeader: string | null, secure: boolean, now = Date.now()): { headers: Headers | null; setCookies: string[] } {
  if (!secure || !cookieHeader) return { headers: null, setCookies: [] };
  const all = pairs(cookieHeader);
  const host = all.find(([name]) => name === HOST_SESSION_COOKIE)?.[1];
  const legacy = all.find(([name]) => name === SESSION_COOKIE)?.[1];
  if (host === undefined && legacy === undefined) return { headers: null, setCookies: [] };
  const setCookies: string[] = [];
  let session: string | null = null;
  if (host !== undefined) {
    session = host;
    if (legacy !== undefined) setCookies.push(clearedSessionCookies(true)[1]);
  } else if (legacy !== undefined) {
    if (now < LEGACY_SESSION_COOKIE_UNTIL && SESSION_ID.test(legacy)) {
      session = legacy;
      setCookies.push(writtenSessionCookie(legacy, true), clearedSessionCookies(true)[1]);
    } else {
      setCookies.push(clearedSessionCookies(true)[1]);
    }
  }
  const kept = all.filter(([name]) => name !== HOST_SESSION_COOKIE && name !== SESSION_COOKIE).map(([name, value]) => `${name}=${value}`);
  if (session !== null) kept.push(`${SESSION_COOKIE}=${session}`);
  const headers = new Headers();
  headers.set("cookie", kept.join("; "));
  return { headers, setCookies };
}
