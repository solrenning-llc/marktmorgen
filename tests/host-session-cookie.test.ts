/**
 * The studio session cookie is written as __Host-nl_session over https (the security audit of 14 November 2026;
 * Claude 3's decision of the same day), so no subdomain of ours can plant or overwrite it: a __Host- cookie must be
 * Secure, Path=/ and carry no Domain. Nobody is logged out by the change: a browser holding the old nl_session is
 * still let in until LEGACY_SESSION_COOKIE_UNTIL, and its next answer writes the new cookie and clears the old one.
 * The code that reads the session goes on reading nl_session: the proxy hands it the right value (lib/
 * session-cookie.ts, carrySessionCookie). Over plain http (a laptop running the site) the name is unchanged.
 */
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { HOST_SESSION_COOKIE, LEGACY_SESSION_COOKIE_UNTIL, SESSION_COOKIE, carrySessionCookie, clearedSessionCookies, sessionCookieName } from "@/lib/session-cookie";
import { sessionCookie } from "@/lib/auth";
import { done, is, part } from "./check";

const A = "a".repeat(64);
const B = "b".repeat(64);
const BEFORE = LEGACY_SESSION_COOKIE_UNTIL - 1;
const AFTER = LEGACY_SESSION_COOKIE_UNTIL;
const forwardedSession = (headers: Headers | null) => {
  const cookie = headers?.get("cookie") ?? "";
  return cookie.split(/;\s*/).filter((pair) => pair.startsWith(`${SESSION_COOKIE}=`)).map((pair) => pair.slice(SESSION_COOKIE.length + 1));
};

async function main(): Promise<void> {
  part("Written as __Host-nl_session over https, as before over http");
  is("the names", [sessionCookieName(true), sessionCookieName(false)], ["__Host-nl_session", "nl_session"]);
  const written = sessionCookie(A, true);
  is("a __Host- cookie: Secure, Path=/, no Domain", [written.startsWith(`${HOST_SESSION_COOKIE}=${A};`), /; Secure(;|$)/.test(written), /; Path=\/(;|$)/.test(written), /Domain=/i.test(written)], [true, true, true, false]);
  is("over http, the old name and no Secure", sessionCookie(A, false).startsWith(`${SESSION_COOKIE}=${A};`) && !/Secure/.test(sessionCookie(A, false)), true);
  is("signing out clears both names over https", clearedSessionCookies(true).map((c) => c.split("=")[0]).sort(), ["__Host-nl_session", "nl_session"]);

  part("What the code reads: the new cookie first, the old one only until the date");
  const both = carrySessionCookie(`${HOST_SESSION_COOKIE}=${A}; ${SESSION_COOKIE}=${B}; other=1`, true, BEFORE);
  is("the new cookie wins over a planted old one", forwardedSession(both.headers), [A]);
  is("other cookies are kept", both.headers?.get("cookie")?.includes("other=1"), true);
  is("and the planted old one is cleared", both.setCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`)), true);
  const old = carrySessionCookie(`${SESSION_COOKIE}=${B}`, true, BEFORE);
  is("only the old one, before the date: still let in", forwardedSession(old.headers ?? new Headers({ cookie: `${SESSION_COOKIE}=${B}` })), [B]);
  is("and swapped for the new one in the answer", [old.setCookies.some((c) => c.startsWith(`${HOST_SESSION_COOKIE}=${B};`) && /; Secure/.test(c)), old.setCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`))], [true, true]);
  const late = carrySessionCookie(`${SESSION_COOKIE}=${B}`, true, AFTER);
  is("only the old one, from the date on: not read", forwardedSession(late.headers), []);
  is("over http nothing changes", carrySessionCookie(`${SESSION_COOKIE}=${B}`, false, AFTER), { headers: null, setCookies: [] });
  is("no session cookie at all: nothing changes", carrySessionCookie("other=1", true, BEFORE), { headers: null, setCookies: [] });

  part("Through the proxy");
  const page = await proxy(new NextRequest("https://marktmorgen.com/studio", { headers: { host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${B}` } }));
  const set = page.headers.getSetCookie();
  is("a page answered to an old cookie writes the new one", set.some((c) => c.startsWith(`${HOST_SESSION_COOKIE}=${B};`)), Date.now() < LEGACY_SESSION_COOKIE_UNTIL);
  const api = await proxy(new NextRequest("https://marktmorgen.com/api/store/links", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-length": "2", cookie: `${HOST_SESSION_COOKIE}=${A}; ${SESSION_COOKIE}=${B}` }, body: "{}" }));
  is("an API call hands the route the new cookie's session", (api.headers.get("x-middleware-request-cookie") ?? "").includes(`${SESSION_COOKIE}=${A}`), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
