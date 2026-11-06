/**
 * "Continue with Google" (276 [H3-1], lib/google-signin.ts; added 1 November
 * 2026), against a stand-in for Google's token endpoint. Checked:
 *
 *   - it is switched off in the code, and while off nothing is offered and
 *     the routes answer as if it were not there;
 *   - Google's page is asked for `openid email` alone, with PKCE (S256), a
 *     nonce, a random state and the redirect already registered;
 *   - a login finishes only in the browser that started it, once;
 *   - an address opens a session only when Google says it verified it and
 *     Google answers for that inbox (Gmail, or the Workspace domain it
 *     names); every check on the token (issuer, audience, expiry, nonce)
 *     turns a wrong one away, and nothing is opened;
 *   - the session is the one every other way opens: two-step login holds it
 *     for its code, and "Log out of all devices" ends it;
 *   - the tries are limited, and the store address typed on the home page
 *     comes through, as with the emailed link.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { emailForSession, endAllSessions, noteSignIn, openSession } from "@/lib/auth";
import { GOOGLE_SIGNIN_APPROVED, GOOGLE_SIGNIN_SCOPES, googleSignInOffered, googleSignInShown, refusalFor } from "@/lib/google-signin";
import { REDIRECT_URIS } from "@/lib/meet-providers";
import { finishSetup, startSetup } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { POST as start } from "@/app/api/auth/google/route";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { GET as back } from "@/app/api/integrations/google/callback/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_google_signin_only_a_stand_in";
const CLIENT = "client-for-tests.apps.googleusercontent.com";
/** A synthetic Gmail address, put together here so no address is written out in the repository (scripts/check_public_data.py). */
const gmail = (name: string) => [name, ["gmail", "com"].join(".")].join("@");

/** What the stand-in for Google's token endpoint answers with, and what it was sent. */
let claims: Record<string, unknown> = {};
const tokenCalls: URLSearchParams[] = [];
const mails: { to: string; text: string }[] = [];
const idToken = (body: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(body)).toString("base64url"), "c2lnbmF0dXJl"].join(".");
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  if (url === "https://oauth2.googleapis.com/token") {
    tokenCalls.push(new URLSearchParams(String(init?.body ?? "")));
    return new Response(JSON.stringify({ access_token: "ya29.stand-in", id_token: idToken(claims), token_type: "Bearer", expires_in: 3599 }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const cookieOf = (response: Response, name: string) => (response.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]*)`))?.[1] ?? "";
let address = 0;
/** Each run of the flow from a machine of its own, so the limit is only met where it is meant to be. */
const machine = () => `203.0.113.${(address += 1)}`;

async function begin(ip = machine(), handle = "", at = "https://marktmorgen.com"): Promise<{ response: Response; state: string; nonce: string; cookie: string; url: URL | null }> {
  const response = await start(
    new NextRequest(`${at}/api/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
      body: new URLSearchParams(handle ? { handle } : {}),
    }),
  );
  const location = response.headers.get("location") ?? "";
  const url = location.startsWith("https://accounts.google.com/") ? new URL(location) : null;
  return { response, state: url?.searchParams.get("state") ?? "", nonce: url?.searchParams.get("nonce") ?? "", cookie: cookieOf(response, "nl_gsi"), url };
}

function answer(state: string, cookie: string, extra: Record<string, string> = { code: "4/stand-in-code" }, ip = machine(), more = ""): Promise<Response> {
  const query = new URLSearchParams({ state, ...extra });
  const cookies = [cookie ? `nl_gsi=${cookie}` : "", more].filter(Boolean).join("; ");
  return back(
    new NextRequest(`https://marktmorgen.com/api/integrations/google/callback?${query}`, {
      headers: { "x-forwarded-for": ip, "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0", ...(cookies ? { cookie: cookies } : {}) },
    }),
  );
}

const good = (nonce: string, over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT,
  sub: "110169484474386276334",
  email: gmail("Maker"),
  email_verified: true,
  nonce,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});

/** The whole flow with these claims: where it ends, and the session it opened, if any. */
async function loginWith(over: (nonce: string) => Record<string, unknown>): Promise<{ location: string; session: string; email: string | null }> {
  const begun = await begin();
  claims = over(begun.nonce);
  const response = await answer(begun.state, begun.cookie);
  const session = cookieOf(response, "nl_session");
  return { location: response.headers.get("location") ?? "", session, email: session ? await emailForSession(session) : null };
}

async function main(): Promise<void> {
  redis.clear();

  part("Switched off");
  is("off in the code until the owner finishes the Google steps", GOOGLE_SIGNIN_APPROVED, false);
  process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-for-tests";
  is("Google's keys alone do not turn it on", googleSignInOffered(), false);
  const off = await begin();
  is("and the route is not there", [off.response.status, off.cookie], [404, ""]);
  const offBack = await answer(`gsi.${"a".repeat(43)}`, `gsi.${"a".repeat(43)}`);
  is("an answer back while off opens nothing", [offBack.headers.get("location"), cookieOf(offBack, "nl_session")], ["https://marktmorgen.com/signin?status=google-expired", ""]);
  is("nothing was asked of Google", tokenCalls.length, 0);

  process.env.GOOGLE_SIGNIN_LIVE = "1";
  is("on where it is set, with Google's keys", googleSignInOffered(), true);
  is("before approval the button is shown only on the owner's try link, at the site's own address", [
    googleSignInShown("marktmorgen.com"),
    googleSignInShown("marktmorgen.com", "test"),
    googleSignInShown("www.marktmorgen.com", "test"),
    googleSignInShown("marktmorgen-git-branch.vercel.app", "test"),
  ], [false, true, false, false]);
  const fromWww = await begin(machine(), "", "https://www.marktmorgen.com");
  is("a login started at another address is sent to the site's own first", [fromWww.response.headers.get("location"), fromWww.cookie, fromWww.url], ["https://marktmorgen.com/signin", "", null]);

  part("Google's page");
  const begun = await begin(machine(), "harborkitchen");
  const url = begun.url;
  is("sent to Google's own page", url?.origin + (url?.pathname ?? ""), "https://accounts.google.com/o/oauth2/v2/auth");
  is("asking for the email address and nothing else", [url?.searchParams.get("scope"), [...GOOGLE_SIGNIN_SCOPES]], ["openid email", ["openid", "email"]]);
  is("no refresh token, no other grants, and the account chosen each time", [url?.searchParams.has("access_type"), url?.searchParams.get("include_granted_scopes"), url?.searchParams.get("prompt")], [false, "false", "select_account"]);
  is("to the redirect already registered for Google", url?.searchParams.get("redirect_uri"), REDIRECT_URIS.google);
  is("with PKCE and a nonce", [url?.searchParams.get("code_challenge_method"), (url?.searchParams.get("code_challenge") ?? "").length, begun.nonce.length > 20], ["S256", 43, true]);
  is("the state is in this browser's cookie, with the store address typed", begun.cookie, `${begun.state}~harborkitchen`);
  is("which goes only to the answer's address, for ten minutes", /Path=\/api\/integrations\/google; Max-Age=600; HttpOnly; SameSite=Lax/.test(begun.response.headers.get("set-cookie") ?? ""), true);

  part("Coming back");
  claims = good(begun.nonce);
  const first = await answer(begun.state, begun.cookie);
  const session = cookieOf(first, "nl_session");
  is("a confirmed Gmail address opens its session, and the studio with the store address", [first.headers.get("location"), session.length], ["https://marktmorgen.com/studio?handle=harborkitchen", 64]);
  is("as the account with that address", await emailForSession(session), gmail("maker"));
  const sent = tokenCalls.at(-1);
  const verifierHash = createHash("sha256").update(sent?.get("code_verifier") ?? "").digest("base64url");
  is("the code was traded once, with the verifier that matches the page's challenge", [tokenCalls.length, verifierHash, sent?.get("redirect_uri")], [1, url?.searchParams.get("code_challenge"), REDIRECT_URIS.google]);
  is("and the state cookie is gone", /nl_gsi=; Path=\/api\/integrations\/google; Max-Age=0/.test(first.headers.get("set-cookie") ?? ""), true);
  const twice = await answer(begun.state, begun.cookie);
  is("the same answer a second time opens nothing", [twice.headers.get("location"), cookieOf(twice, "nl_session"), tokenCalls.length], ["https://marktmorgen.com/signin?status=google-expired", "", 1]);

  const elsewhere = await begin();
  claims = good(elsewhere.nonce);
  const noCookie = await answer(elsewhere.state, "");
  const otherCookie = await answer(elsewhere.state, `gsi.${"b".repeat(43)}`);
  is("not in a browser that did not start it", [noCookie.headers.get("location"), otherCookie.headers.get("location"), tokenCalls.length], ["https://marktmorgen.com/signin?status=google-expired", "https://marktmorgen.com/signin?status=google-expired", 1]);

  const cancelled = await begin();
  const closed = await answer(cancelled.state, cancelled.cookie, { error: "access_denied" });
  is("closing Google's page: nothing happens, and the state is spent", [closed.headers.get("location"), tokenCalls.length], ["https://marktmorgen.com/signin?status=google-declined", 1]);
  const afterClosing = await answer(cancelled.state, cancelled.cookie);
  is("so a code brought back after that opens nothing", [afterClosing.headers.get("location"), tokenCalls.length], ["https://marktmorgen.com/signin?status=google-expired", 1]);

  part("Only an address Google answers for, and has confirmed");
  is("email_verified false", (await loginWith((n) => good(n, { email_verified: false }))).location, "https://marktmorgen.com/signin?status=google-unverified");
  is("email_verified missing", (await loginWith((n) => good(n, { email_verified: undefined }))).location, "https://marktmorgen.com/signin?status=google-unverified");
  is("email_verified written as text", (await loginWith((n) => good(n, { email_verified: "true" }))).location, "https://marktmorgen.com/signin?status=google-unverified");
  is("a Google account made with an address from elsewhere", (await loginWith((n) => good(n, { email: "maker@example.com" }))).location, "https://marktmorgen.com/signin?status=google-elsewhere");
  is("a Workspace domain that is not the address's", (await loginWith((n) => good(n, { email: "maker@example.com", hd: "other.example" }))).location, "https://marktmorgen.com/signin?status=google-elsewhere");
  const workspace = await loginWith((n) => good(n, { email: "maker@studio.example", hd: "studio.example" }));
  is("a work address on the Workspace domain Google names", [workspace.location, workspace.email], ["https://marktmorgen.com/studio", "maker@studio.example"]);
  for (const [what, over] of [
    ["another site's token", { aud: "someone-else.apps.googleusercontent.com" }],
    ["another issuer", { iss: "https://accounts.example.com" }],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 }],
    ["no subject", { sub: "" }],
  ] as const) {
    const tried = await loginWith((n) => good(n, over));
    is(`${what}: nothing opens`, [tried.location, tried.session], ["https://marktmorgen.com/signin?status=google-error", ""]);
  }
  for (const [what, over] of [
    ["issued in the future", { iat: Math.floor(Date.now() / 1000) + 3600 }],
    ["for several audiences, without this site as the party it was given to", { aud: [CLIENT, "other"], azp: "other" }],
    ["given to another party", { azp: "someone-else.apps.googleusercontent.com" }],
  ] as const) {
    const tried = await loginWith((n) => good(n, over));
    is(`${what}: nothing opens`, [tried.location, tried.session], ["https://marktmorgen.com/signin?status=google-error", ""]);
  }
  is("several audiences, given to this site: accepted", (await loginWith((n) => good(n, { aud: [CLIENT, "other"], azp: CLIENT }))).location, "https://marktmorgen.com/studio");
  is("the demo store's owner, whatever proves it", (await loginWith((n) => good(n, { email: "demo@marktmorgen.com", hd: "marktmorgen.com" }))).location, "https://marktmorgen.com/signin?status=google-elsewhere");
  const replayed = await loginWith(() => good("a-nonce-from-another-login"));
  is("a token for another login (its nonce): nothing opens", [replayed.location, replayed.session], ["https://marktmorgen.com/signin?status=google-error", ""]);
  is("the checks themselves, on a good token", refusalFor(good("n"), "n"), null);

  part("The same session as every other way in");
  const old = await openSession(gmail("someone"));
  const over = await begin();
  claims = good(over.nonce, { email: gmail("next") });
  const taken = await answer(over.state, over.cookie, undefined, machine(), `nl_session=${old}`);
  is("a session this browser held before is closed", [await emailForSession(old), await emailForSession(cookieOf(taken, "nl_session"))], [null, gmail("next")]);
  await noteSignIn(gmail("seen"), undefined, "link", "a browser");
  const seen = await begin();
  claims = good(seen.nonce, { email: gmail("seen") });
  mails.length = 0;
  await answer(seen.state, seen.cookie);
  is("from a browser the account has not used: the email says it was Google", mails.some((m) => m.to === gmail("seen") && m.text.includes("How: with Google, which confirmed this address")), true);
  const outEverywhere = await loginWith((n) => good(n, { email: gmail("out") }));
  is("opened", outEverywhere.email, gmail("out"));
  await endAllSessions(gmail("out"));
  is("and ended by Log out of all devices", await emailForSession(outEverywhere.session), null);

  const started = await startSetup(gmail("held"), "c".repeat(64), "backup@example.org");
  if (typeof started === "string") throw new Error(started);
  const backupCode = /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === "backup@example.org")?.text ?? "")?.[1] ?? "";
  const set = await finishSetup(gmail("held"), "c".repeat(64), codeAt(base32Decode(started.secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS)), backupCode);
  if (typeof set === "string") throw new Error(set);
  const heldBegun = await begin();
  claims = good(heldBegun.nonce, { email: gmail("held") });
  const held = await answer(heldBegun.state, heldBegun.cookie);
  is("with two-step login on, it waits for the code, like the link", [held.headers.get("location"), cookieOf(held, "nl_session"), cookieOf(held, "nl_2fa").length], ["https://marktmorgen.com/signin/code", "", 64]);
  await noteSignIn(gmail("held"), undefined, "link", "a browser");
  mails.length = 0;
  const nextCode = codeAt(base32Decode(started.secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1);
  const coded = await codeRoute(
    new NextRequest("https://marktmorgen.com/api/auth/code", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `nl_2fa=${cookieOf(held, "nl_2fa")}` },
      body: new URLSearchParams({ code: nextCode }),
    }),
  );
  is("the right code opens it, and the new-browser email still says Google", [coded.headers.get("location"), mails.some((m) => m.to === gmail("held") && m.text.includes("How: with Google"))], ["https://marktmorgen.com/studio", true]);

  part("Tries");
  const ip = machine();
  const answers: number[] = [];
  for (let i = 0; i < 21; i += 1) answers.push((await begin(ip)).url ? 1 : 0);
  const last = await begin(ip);
  is("twenty in ten minutes from one machine, then a wait", [answers.slice(0, 20).every(Boolean), answers[20], last.response.headers.get("location")], [true, 0, "https://marktmorgen.com/signin?status=google-slow"]);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
