/**
 * "Continue with Google" on the login page (276 [H3-1], added 1 November 2026).
 *
 * Built and tested, and switched off: GOOGLE_SIGNIN_APPROVED is false until
 * the owner has done the steps in docs/google-signin.md in Google Cloud, as
 * ZOOM_APPROVED waits for Zoom (lib/meet-providers.ts). Nothing here was set
 * up at Google.
 *
 * It is one more way to prove an inbox, beside the emailed link and the
 * passkey, and opens exactly the session they open (lib/auth.ts), so
 * two-step login, "Log out of all devices", the email about a new browser
 * and the recovery address all cover it (lib/signin-finish.ts).
 *
 * What Google is asked for: `openid email`, nothing else. No access to the
 * person's mail, contacts, calendar or anything in their Google account, no
 * refresh token, and nothing from Google is kept after the login: the
 * address Google confirms is the account's address, as if the link had been
 * opened from that inbox.
 *
 * An address opens a session only when Google says it verified it AND Google
 * is the one that answers for that inbox: a Gmail address, or an address of
 * a domain run on Google Workspace, which Google names in the token (`hd`).
 * Any other address on a Google account (one made with an address from
 * elsewhere) is turned away to the emailed link, because the inbox is not
 * Google's to confirm, and such an account can outlive the person's hold on
 * that inbox. An address Google did not verify never opens anything.
 *
 * The flow is OAuth 2.0 with PKCE (S256) and an OpenID nonce. The state is
 * random, kept in Redis 10 minutes (keepGoogleState) and spent once, and the
 * same state rides in a cookie of this browser alone, so a login someone
 * else started cannot finish in this browser. The answer comes back to the
 * redirect already registered for Google
 * (app/api/integrations/google/callback), told apart by its "gsi." state as
 * Search Console's "gsc." is (lib/search-console.ts). The ID token is read
 * from Google's token endpoint over TLS, in this server's own request with
 * the client secret; its issuer, audience, expiry and nonce are checked.
 */
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, GOOGLE_STATE_SECONDS, keepGoogleState, normaliseEmail, takeGoogleState } from "@/lib/auth";
import { isRedisConfigured } from "@/lib/redis";
import { REDIRECT_URIS } from "@/lib/meet-providers";
import { isHouseAddress } from "@/lib/house-store";
import { prefillHandle } from "@/lib/handle-prefill";
import { SITE_URL } from "@/lib/site-url";

/**
 * Whether the owner has finished the Google Cloud steps (docs/google-signin.md)
 * and Google lets any account in. Kept in the code, so turning it on is one
 * reviewed change every deployment carries. Turn to true only after those
 * steps, never before.
 *
 * GOOGLE_SIGNIN_LIVE=1 is for the owner's own try before that: the routes
 * answer, but the button is shown only on /signin?google=test, so no
 * creator meets a button Google may still turn away (VR, item 2), and the
 * privacy policy says nothing until it is approved.
 */
export const GOOGLE_SIGNIN_APPROVED: boolean = false;

/** Only these two, so Google's page asks for nothing more. */
export const GOOGLE_SIGNIN_SCOPES = ["openid", "email"] as const;

/** The cookie that ties a login with Google to the browser that started it. */
export const GOOGLE_STATE_COOKIE = "nl_gsi";
/** Where it is sent: only to the address Google sends the person back to. */
export const GOOGLE_STATE_COOKIE_PATH = "/api/integrations/google";

const STATE = /^gsi\.[A-Za-z0-9_-]{32,64}$/;
/** Inboxes Google itself runs. */
const GOOGLE_MAIL = new Set(["gmail.com", "googlemail.com"]);
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** A little room for the two clocks; Google's tokens last an hour. */
const SKEW_SECONDS = 300;

const env = (name: string) => process.env[name]?.trim() ?? "";

export const isGoogleSignInState = (state: string) => STATE.test(state);

/** The routes answer: approved or on for a try, Google's keys set, and somewhere to keep the state. */
export function googleSignInOffered(): boolean {
  const open = GOOGLE_SIGNIN_APPROVED || env("GOOGLE_SIGNIN_LIVE") === "1";
  return open && Boolean(env("GOOGLE_OAUTH_CLIENT_ID") && env("GOOGLE_OAUTH_CLIENT_SECRET")) && isRedisConfigured();
}

/**
 * The query that shows the button for the owner's try (GOOGLE_SIGNIN_LIVE).
 */
export const GOOGLE_SIGNIN_TRY_QUERY = "test";

/**
 * Whether the login page shows the button: switched on, and on the site's own
 * address, the only one Google sends people back to (REDIRECT_URIS.google),
 * because the cookie that finishes the login is set where it starts. Before
 * approval, only on the owner's try link.
 */
export function googleSignInShown(host: string | null | undefined, tryQuery?: unknown): boolean {
  if (!googleSignInOffered() || (host ?? "").toLowerCase() !== new URL(SITE_URL).host) return false;
  return GOOGLE_SIGNIN_APPROVED || tryQuery === GOOGLE_SIGNIN_TRY_QUERY;
}

/** Whether a login started at this origin can finish: only at the site's own address. */
export const startsAtSite = (origin: string) => origin === SITE_URL;

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/**
 * Starts a login: Google's page, and the cookie for this browser. `handle` is
 * the store address typed on the home page, carried only in that cookie, as
 * the emailed link carries it only in itself (lib/handle-prefill.ts).
 */
export async function beginGoogleSignIn(handle?: unknown): Promise<{ url: string; cookie: string } | null> {
  if (!googleSignInOffered()) return null;
  const state = `gsi.${base64url(randomBytes(32))}`;
  const verifier = base64url(randomBytes(48));
  const nonce = base64url(randomBytes(24));
  await keepGoogleState(state, JSON.stringify({ v: verifier, n: nonce }));
  const query = new URLSearchParams({
    client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
    redirect_uri: REDIRECT_URIS.google,
    response_type: "code",
    scope: GOOGLE_SIGNIN_SCOPES.join(" "),
    state,
    nonce,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    include_granted_scopes: "false",
    // Which Google account, every time: a shared computer's last account is never assumed.
    prompt: "select_account",
    hl: "en",
  });
  const kept = prefillHandle(handle);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const value = kept ? `${state}~${kept}` : state;
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${query}`,
    cookie: `${GOOGLE_STATE_COOKIE}=${value}; Path=${GOOGLE_STATE_COOKIE_PATH}; Max-Age=${GOOGLE_STATE_SECONDS}; HttpOnly; SameSite=Lax${secure}`,
  };
}

/** The cookie that ends it, set on every answer back. */
export function clearGoogleStateCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${GOOGLE_STATE_COOKIE}=; Path=${GOOGLE_STATE_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

/** What the browser's cookie holds: the state it started, and the store address if one was typed. */
export function readGoogleStateCookie(raw: string | undefined): { state: string; handle: string } {
  const [state = "", handle = ""] = (raw ?? "").split("~", 2);
  return { state, handle: prefillHandle(handle) ?? "" };
}

export type GoogleClaims = Record<string, unknown>;

/**
 * Why an address may not open a session, or null when it may. Every check
 * on the ID token is here, so the tests can put each to the proof.
 */
export function refusalFor(claims: GoogleClaims, nonce: string, now = Date.now()): "unverified" | "elsewhere" | "invalid" | null {
  const client = env("GOOGLE_OAUTH_CLIENT_ID");
  const audience = Array.isArray(claims.aud) ? claims.aud.includes(client) && claims.azp === client : claims.aud === client && (claims.azp === undefined || claims.azp === client);
  const seconds = Math.floor(now / 1000);
  const fresh = typeof claims.exp === "number" && claims.exp + SKEW_SECONDS > seconds && typeof claims.iat === "number" && claims.iat - SKEW_SECONDS <= seconds;
  if (!client || typeof claims.iss !== "string" || !ISSUERS.has(claims.iss) || !audience || !fresh) return "invalid";
  if (!nonce || claims.nonce !== nonce || typeof claims.sub !== "string" || !claims.sub) return "invalid";
  const email = typeof claims.email === "string" ? normaliseEmail(claims.email) : "";
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return "invalid";
  // Only a plain true: a missing claim, false, or "true" written as text is not Google saying so.
  if (claims.email_verified !== true) return "unverified";
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const hosted = typeof claims.hd === "string" ? claims.hd.trim().toLowerCase() : "";
  if (!GOOGLE_MAIL.has(domain) && !(hosted && hosted === domain)) return "elsewhere";
  return null;
}

/**
 * The claims of an ID token, read WITHOUT checking its signature. Right only
 * for the token this server itself got from Google's token endpoint, over
 * TLS and with the client secret (OpenID Connect Core 1.0, 3.1.3.7, item 6);
 * never for a token that came from a browser.
 */
export function claimsFromTokenEndpoint(idToken: unknown): GoogleClaims | null {
  if (typeof idToken !== "string" || idToken.length > 8_000) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? (claims as GoogleClaims) : null;
  } catch {
    return null;
  }
}

export type GoogleSignInResult =
  | { ok: true; email: string }
  | { ok: false; reason: "expired" | "declined" | "unverified" | "elsewhere" | "error" };

/**
 * Back from Google's page. The state must be this browser's, unspent; the
 * code is traded once, with the verifier; the token must pass refusalFor.
 * Says which address proved itself, and keeps nothing from Google.
 */
export async function finishGoogleSignIn(state: string, browserState: string, code: string, declined: boolean): Promise<GoogleSignInResult> {
  if (!googleSignInOffered() || !STATE.test(state) || state !== browserState) return { ok: false, reason: "expired" };
  const raw = await takeGoogleState(state);
  let kept: { v?: unknown; n?: unknown } = {};
  try {
    kept = raw ? (JSON.parse(raw) as typeof kept) : {};
  } catch {
    kept = {};
  }
  if (typeof kept.v !== "string" || typeof kept.n !== "string") return { ok: false, reason: "expired" };
  if (declined || !code) return { ok: false, reason: "declined" };
  if (code.length > 2048 || !/^[A-Za-z0-9._~/+=-]+$/.test(code)) return { ok: false, reason: "error" };
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
        client_secret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URIS.google,
        code_verifier: kept.v,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return { ok: false, reason: "error" };
    const claims = claimsFromTokenEndpoint(json.id_token);
    if (!claims) return { ok: false, reason: "error" };
    const refused = refusalFor(claims, kept.n);
    if (refused === "invalid") return { ok: false, reason: "error" };
    if (refused) return { ok: false, reason: refused };
    const email = normaliseEmail(String(claims.email));
    // The demo store's owner is nobody (lib/house-store.ts), whatever proves it.
    if (isHouseAddress(email)) return { ok: false, reason: "elsewhere" };
    return { ok: true, email };
  } catch {
    return { ok: false, reason: "error" };
  }
}
