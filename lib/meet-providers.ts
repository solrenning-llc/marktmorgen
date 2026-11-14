/**
 * Speaking to Google and to Zoom: signing a creator in with OAuth, and
 * making, moving and removing the meetings for their bookings.
 *
 * Nothing here is a dependency: both are plain https with JSON (Google's
 * token endpoint takes a form). Every request goes to one of a fixed list of
 * hosts, checked before it is sent, follows no redirect, gives up after
 * CALL_TIMEOUT_MS and reads at most MAX_ANSWER_BYTES, so an answer can never
 * send a request carrying a token anywhere else. Work that has a hard end —
 * the five-minute job — runs inside withCutoff, and then every request is
 * also given up by that moment, however many one piece of work makes.
 *
 *   Google   accounts.google.com       the consent page (the browser goes there, we never call it)
 *            oauth2.googleapis.com     tokens, and giving a token back (revoke)
 *            www.googleapis.com        Calendar API v3: the creator's primary calendar only
 *   Zoom     zoom.us                   the consent page, tokens, revoke
 *            api.zoom.us               API v2: the connected user's own meetings only
 *
 * What is asked for, and nothing more:
 *
 *   Google   openid email https://www.googleapis.com/auth/calendar.events
 *            — to see which account was connected, and to create, change and
 *            delete events on calendars the account can edit. A store's own
 *            connection only ever touches its primary calendar, and only
 *            events we made.
 *
 *            A team host's own connection (lib/host-calendar.ts) asks for two
 *            more, and only once the deployment says the owner has added them
 *            to the app's consent screen (hostSyncOn):
 *            https://www.googleapis.com/auth/calendar.freebusy, to read when
 *            they are busy (never what), and
 *            https://www.googleapis.com/auth/calendar.calendarlist.readonly,
 *            to list their calendars so they can pick which ones count and
 *            which one bookings are written to. Events are still only ours.
 *   Zoom     the scopes set on the app (a user-managed app): create, read,
 *            update and delete meetings of the user who installs it, and
 *            read that user's own profile, for the account name shown.
 *
 * Both flows use the authorization code with PKCE (S256) and a state value
 * (lib/meet-connect.ts keeps both), and the redirect address is fixed:
 * https://marktmorgen.com/api/integrations/google/callback and
 * .../zoom/callback, the ones registered with each.
 *
 * Local checks may point every host at one stand-in on 127.0.0.1
 * (GOOGLE_API_BASE, ZOOM_API_BASE); nothing else is accepted, so a check can
 * never reach the real services.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lockWait, timeLeft, withCutoff } from "@/lib/fetch-timeout";
import type { MeetProvider } from "@/lib/call-setup";
import { isHouseAddress } from "@/lib/house-store";
import { SITE_URL } from "@/lib/site-url";

const LOCAL = /^http:\/\/127\.0\.0\.1:\d+$/;
const googleBase = () => (LOCAL.test(process.env.GOOGLE_API_BASE ?? "") ? (process.env.GOOGLE_API_BASE as string) : "");
const zoomBase = () => (LOCAL.test(process.env.ZOOM_API_BASE ?? "") ? (process.env.ZOOM_API_BASE as string) : "");

const GOOGLE = {
  auth: () => (googleBase() ? `${googleBase()}/google/auth` : "https://accounts.google.com/o/oauth2/v2/auth"),
  token: () => (googleBase() ? `${googleBase()}/google/token` : "https://oauth2.googleapis.com/token"),
  revoke: () => (googleBase() ? `${googleBase()}/google/revoke` : "https://oauth2.googleapis.com/revoke"),
  calendar: () => (googleBase() ? `${googleBase()}/google/calendar/v3` : "https://www.googleapis.com/calendar/v3"),
};
const ZOOM = {
  auth: () => (zoomBase() ? `${zoomBase()}/zoom/oauth/authorize` : "https://zoom.us/oauth/authorize"),
  token: () => (zoomBase() ? `${zoomBase()}/zoom/oauth/token` : "https://zoom.us/oauth/token"),
  revoke: () => (zoomBase() ? `${zoomBase()}/zoom/oauth/revoke` : "https://zoom.us/oauth/revoke"),
  api: () => (zoomBase() ? `${zoomBase()}/zoom/v2` : "https://api.zoom.us/v2"),
};

/** The only hosts a request of this file goes to. */
const HOSTS = new Set(["oauth2.googleapis.com", "www.googleapis.com", "zoom.us", "api.zoom.us"]);

export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events"];
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/** Reading when a host is busy, never what they are busy with. */
export const FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
/** Listing a host's calendars, so they choose which ones are read and which one is written to. */
export const CALENDARLIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
/** What a team host's own connection asks for: the store's, and the two above. */
export const GOOGLE_HOST_SCOPES = [...GOOGLE_SCOPES, FREEBUSY_SCOPE, CALENDARLIST_SCOPE];

/**
 * Whether team hosts may connect their own Google Calendar for two-way sync.
 * The two extra scopes have to be on the Google Cloud app's OAuth consent
 * screen first, which only the owner of the deployment can do; until they
 * set GOOGLE_CALENDAR_SYNC_SCOPES=1, hosts are offered the iCal address
 * instead and the studio says why.
 */
export function hostSyncOn(): boolean {
  return isConfigured("google") && env("GOOGLE_CALENDAR_SYNC_SCOPES") === "1";
}

/** Whether a granted scope string covers each part of a host's sync. */
export function grantedParts(scope: string): { events: boolean; freebusy: boolean; calendars: boolean } {
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return {
    events: granted.has(CALENDAR_SCOPE),
    // The broader read scopes also cover free/busy, if a grant ever carries one.
    freebusy: granted.has(FREEBUSY_SCOPE) || granted.has("https://www.googleapis.com/auth/calendar.events.freebusy") || granted.has("https://www.googleapis.com/auth/calendar.readonly"),
    calendars: granted.has(CALENDARLIST_SCOPE),
  };
}

export const REDIRECT_URIS: Record<MeetProvider, string> = {
  google: `${SITE_URL}/api/integrations/google/callback`,
  zoom: `${SITE_URL}/api/integrations/zoom/callback`,
};

const CALL_TIMEOUT_MS = 8_000;
const MAX_ANSWER_BYTES = 1_000_000;

/**
 * The hard end shared with every other request (lib/fetch-timeout.ts): work
 * run inside withCutoff gives up each request to Google or Zoom by then, and
 * waits on the locks of lib/meet-links.ts and lib/meet-connect.ts only while
 * there is time. For the five-minute job, whose sixty seconds are shared
 * (app/api/cron/mail).
 */
export { lockWait, timeLeft, withCutoff };

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Whether each is switched on: only when the owner has set its keys. */
export function isConfigured(provider: MeetProvider): boolean {
  if (provider === "google") return Boolean(env("GOOGLE_OAUTH_CLIENT_ID") && env("GOOGLE_OAUTH_CLIENT_SECRET"));
  // Zoom also needs the secret token that signs its notices, so an
  // uninstall in Zoom is always heard (app/api/integrations/zoom/deauthorize).
  return Boolean(env("ZOOM_CLIENT_ID") && env("ZOOM_CLIENT_SECRET") && env("ZOOM_WEBHOOK_SECRET_TOKEN"));
}

export function configuredProviders(): MeetProvider[] {
  return (["google", "zoom"] as const).filter(isConfigured);
}

/**
 * Zoom lets an app it has not yet published be added only from the account
 * that built it, so until the Marketplace listing is approved Zoom is offered
 * to the preview stores alone, and to stores signed in with a Zoom address,
 * which is how Zoom's own reviewers test the app before approving it;
 * ZOOM_APPROVED (or ZOOM_LIVE=1) opens it to every store. A store that already has Zoom
 * connected keeps it either way (usableProviders).
 *
 * The demo store is open to Zoom too (lib/house-store.ts): it is the one
 * store here that is ours, it sells a call like a creator's, and its
 * meetings are what somebody trying Marktmorgen — or reviewing it — books
 * and moves. Its studio is opened by whoever is on its team (lib/team.ts).
 *
 * A reviewer does not always sign up with a Zoom address, so there is also
 * the review link: the Video calls page opened with `?zoom=review`, or with
 * `?from=zoom` as the listing in Zoom's Marketplace opens it, offers Zoom on
 * that visit, whatever the store (arrivedForZoom). It opens nothing
 * Zoom itself keeps shut: an account Zoom does not let add the app is still
 * turned away on Zoom's own page.
 */
const ZOOM_PREVIEW_STORES = new Set(["dc83ed016f0d4a83b71461bca159d8f5"]);

/**
 * Whether Zoom's App Marketplace has approved the app, which is what lets any
 * Zoom account add it. Kept in the code rather than only in a setting, so
 * opening Zoom to every store is one reviewed change that every deployment
 * carries; ZOOM_LIVE=1 still opens it where it is set.
 *
 * Resubmitted for review on 11 October 2026. Turn to true the day Zoom
 * approves it, and not before: until then Zoom turns away every account but
 * the one that built the app, on its own consent page.
 */
export const ZOOM_APPROVED: boolean = false;
/** Zoom's App Marketplace reviewers sign up with their work address. */
const ZOOM_REVIEWER = /@([a-z0-9-]+\.)*(zoom\.us|zoom\.com)$/i;

export { ZOOM_ARRIVAL_COOKIE, ZOOM_ARRIVAL_SECONDS, ZOOM_REVIEW_QUERY, arrivedForZoom, cameForZoom, isZoomReview } from "@/lib/zoom-arrival";

/** A store, or just its id, as a studio page has it. */
export type OfferedTo = { sid?: string | null; email?: string | null } | string | null | undefined;

/**
 * What a store's studio offers to connect: switched on, and Zoom only once
 * it is open to that store, or on a visit by the review link (`review`).
 */
export function offeredProviders(store: OfferedTo, review = false): MeetProvider[] {
  const sid = typeof store === "string" ? store : (store?.sid ?? null);
  const email = typeof store === "object" && store ? (store.email ?? "").trim() : "";
  const zoomOpen =
    review ||
    ZOOM_APPROVED ||
    env("ZOOM_LIVE") === "1" ||
    Boolean(sid && ZOOM_PREVIEW_STORES.has(sid)) ||
    isHouseAddress(email) ||
    ZOOM_REVIEWER.test(email);
  return configuredProviders().filter((p) => p !== "zoom" || zoomOpen);
}

/** Why a request did not do what it was sent to do. */
export class ProviderError extends Error {
  /**
   * "auth": the connection no longer works (reconnect). "scope": the access
   * given does not cover this. "gone": the event or meeting is not there.
   * "conflict": an event with that id exists already (Google). "limit":
   * slow down. "server", "network": try again later. "bad": refused as sent.
   */
  readonly kind: "auth" | "scope" | "gone" | "conflict" | "limit" | "server" | "network" | "bad";
  readonly status: number;
  constructor(kind: ProviderError["kind"], status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

type Answer = { status: number; json: Record<string, unknown> };

async function call(
  url: string,
  init: { method: "GET" | "POST" | "PATCH" | "DELETE"; headers?: Record<string, string>; body?: string },
): Promise<Answer> {
  const parsed = new URL(url);
  const local = parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && (googleBase() || zoomBase());
  if (!local && (parsed.protocol !== "https:" || !HOSTS.has(parsed.hostname))) {
    throw new ProviderError("bad", 0, `refused to call ${parsed.hostname}`);
  }
  const room = Math.min(CALL_TIMEOUT_MS, timeLeft());
  if (room < 250) throw new ProviderError("network", 0, "there was no time left to ask");
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
      body: init.body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(room),
    });
  } catch {
    throw new ProviderError("network", 0, "did not answer in time");
  }
  const raw = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
  if (raw.byteLength > MAX_ANSWER_BYTES) throw new ProviderError("server", response.status, "answered with too much");
  let json: Record<string, unknown> = {};
  if (raw.byteLength) {
    try {
      const value = JSON.parse(Buffer.from(raw).toString("utf8")) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) json = value as Record<string, unknown>;
    } catch {
      json = {};
    }
  }
  return { status: response.status, json };
}

function problem(answer: Answer, what: string): ProviderError {
  const { status, json } = answer;
  const error = json.error;
  const reason =
    typeof error === "string"
      ? error
      : error && typeof error === "object"
        ? String((error as { status?: unknown; message?: unknown }).status ?? (error as { message?: unknown }).message ?? "")
        : String(json.reason ?? json.message ?? "");
  const text = `${what}: ${status}${reason ? ` ${reason.slice(0, 120)}` : ""}`;
  if (status === 401 || reason === "invalid_grant" || reason === "invalid_client") return new ProviderError("auth", status, text);
  if (status === 403 && /insufficient|scope|permission/i.test(reason + JSON.stringify(json).slice(0, 400))) return new ProviderError("scope", status, text);
  if (status === 403 && /rate|quota|limit/i.test(JSON.stringify(json).slice(0, 400))) return new ProviderError("limit", status, text);
  if (status === 404 || status === 410) return new ProviderError("gone", status, text);
  if (status === 409) return new ProviderError("conflict", status, text);
  if (status === 429) return new ProviderError("limit", status, text);
  if (status >= 500 || status === 0) return new ProviderError("server", status, text);
  if (status >= 300 && status < 400) return new ProviderError("server", status, `${what}: redirected`);
  return new ProviderError("bad", status, text);
}

// ---- OAuth -----------------------------------------------------------------

/** A PKCE pair: the verifier we keep, and the challenge sent with the consent page. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Where the creator is sent to say yes. */
export function consentUrl(provider: MeetProvider, state: string, challenge: string, scopes: string[] = GOOGLE_SCOPES): string {
  if (provider === "google") {
    const query = new URLSearchParams({
      client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
      redirect_uri: REDIRECT_URIS.google,
      response_type: "code",
      scope: scopes.join(" "),
      // A refresh token, so meetings can be made while the creator is away,
      // and asked again each time so one always comes back.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      // The whole product is in English, so Google's pages are too.
      hl: "en",
    });
    return `${GOOGLE.auth()}?${query}`;
  }
  const query = new URLSearchParams({
    response_type: "code",
    client_id: env("ZOOM_CLIENT_ID"),
    redirect_uri: REDIRECT_URIS.zoom,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${ZOOM.auth()}?${query}`;
}

export type Tokens = {
  access: string;
  /** When the access token stops working, in milliseconds. */
  expires: number;
  /** Empty when the answer carried none (Google, on a refresh). */
  refresh: string;
  scope: string;
};

function readTokens(json: Record<string, unknown>): Tokens | null {
  const access = typeof json.access_token === "string" ? json.access_token : "";
  if (!access || access.length > 4000) return null;
  const seconds = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in ?? 3600);
  return {
    access,
    expires: Date.now() + Math.max(60, Math.min(seconds || 3600, 86_400)) * 1000,
    refresh: typeof json.refresh_token === "string" && json.refresh_token.length <= 4000 ? json.refresh_token : "",
    scope: typeof json.scope === "string" ? json.scope.slice(0, 2000) : "",
  };
}

function zoomBasic(): string {
  return `Basic ${Buffer.from(`${env("ZOOM_CLIENT_ID")}:${env("ZOOM_CLIENT_SECRET")}`).toString("base64")}`;
}

export type Account = {
  /** Google's subject id, or Zoom's user id: what never changes about the account. */
  id: string;
  email: string;
  name: string;
};

/**
 * Reads who signed in from Google's ID token. It came straight from Google's
 * token endpoint over TLS, in answer to our own request, which OpenID
 * Connect accepts in place of checking its signature; what it says is still
 * checked: that Google issued it, for us, recently, about a verified address.
 */
export function googleAccount(idToken: unknown): Account | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const issuer = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    const audience = Array.isArray(claims.aud) ? claims.aud.includes(env("GOOGLE_OAUTH_CLIENT_ID")) : claims.aud === env("GOOGLE_OAUTH_CLIENT_ID");
    const fresh = typeof claims.exp === "number" && claims.exp * 1000 > Date.now() - 300_000;
    if (!issuer || !audience || !fresh || typeof claims.sub !== "string" || !claims.sub) return null;
    const email = typeof claims.email === "string" && claims.email_verified !== false ? claims.email.slice(0, 254) : "";
    return { id: claims.sub.slice(0, 200), email, name: typeof claims.name === "string" ? claims.name.slice(0, 120) : "" };
  } catch {
    return null;
  }
}

/**
 * Trades the code from the consent page for tokens, and says whose account
 * it is. Refuses when the creator unticked calendar access on Google's page.
 */
export async function exchangeCode(
  provider: MeetProvider,
  code: string,
  verifier: string,
): Promise<{ tokens: Tokens; account: Account } | { error: "scope" | "refused" | "account" }> {
  if (provider === "google") {
    const answer = await call(GOOGLE.token(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
        client_secret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URIS.google,
      }).toString(),
    });
    const tokens = answer.status === 200 ? readTokens(answer.json) : null;
    if (!tokens || !tokens.refresh) return { error: "refused" };
    if (!tokens.scope.split(/\s+/).includes(CALENDAR_SCOPE)) {
      await revoke("google", tokens.refresh).catch(() => {});
      return { error: "scope" };
    }
    const account = googleAccount(answer.json.id_token);
    if (!account) {
      await revoke("google", tokens.refresh).catch(() => {});
      return { error: "account" };
    }
    return { tokens, account };
  }
  const answer = await call(ZOOM.token(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: zoomBasic() },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URIS.zoom, code_verifier: verifier }).toString(),
  });
  const tokens = answer.status === 200 ? readTokens(answer.json) : null;
  if (!tokens || !tokens.refresh) return { error: "refused" };
  // Granular scopes ("meeting:write:meeting") or the classic one ("meeting:write").
  if (tokens.scope && !/(^|\s)meeting:write(:|\s|$)/.test(tokens.scope)) {
    await revoke("zoom", tokens.access).catch(() => {});
    return { error: "scope" };
  }
  const me = await call(`${ZOOM.api()}/users/me`, { method: "GET", headers: { Authorization: `Bearer ${tokens.access}` } });
  const id = typeof me.json.id === "string" ? me.json.id : "";
  if (me.status !== 200 || !id) {
    await revoke("zoom", tokens.access).catch(() => {});
    return { error: "account" };
  }
  const name = [me.json.first_name, me.json.last_name].filter((x) => typeof x === "string" && x).join(" ") || String(me.json.display_name ?? "");
  return {
    tokens,
    account: { id: id.slice(0, 200), email: typeof me.json.email === "string" ? me.json.email.slice(0, 254) : "", name: name.slice(0, 120) },
  };
}

/** A new access token. Zoom hands a new refresh token back each time, and the old one stops working. */
export async function refreshTokens(provider: MeetProvider, refresh: string): Promise<Tokens> {
  const answer =
    provider === "google"
      ? await call(GOOGLE.token(), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
            client_secret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
            grant_type: "refresh_token",
            refresh_token: refresh,
          }).toString(),
        })
      : await call(ZOOM.token(), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: zoomBasic() },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }).toString(),
        });
  // Google says invalid_grant, Zoom invalid_grant or 401: the connection is over.
  if (answer.status === 400 && (answer.json.error === "invalid_grant" || answer.json.reason === "Invalid Token!")) {
    throw new ProviderError("auth", 400, "the connection was withdrawn or ran out");
  }
  const tokens = answer.status === 200 ? readTokens(answer.json) : null;
  if (!tokens) throw problem(answer, "refreshing the connection");
  return tokens;
}

/**
 * Gives a token back, so the access ends on their side too. True only when
 * the access is known to be over: the provider confirmed the revocation (200),
 * or Google answered 400 invalid_token, its code for a token that is already
 * invalid, expired or given back. Any other answer (another 400 code, a 400
 * with no readable code, 5xx) is false: the grant may still be live, so a
 * caller that forgets the token only on true keeps it for a retry (CX-123
 * rule 24).
 */
export async function revoke(provider: MeetProvider, token: string): Promise<boolean> {
  if (!token) return false;
  const answer =
    provider === "google"
      ? await call(GOOGLE.revoke(), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
        })
      : await call(`${ZOOM.revoke()}?${new URLSearchParams({ token })}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: zoomBasic() },
        });
  if (answer.status === 200) return true;
  // Google answers 400 invalid_token for one already given back: done either
  // way. A 400 with any other code (invalid_request, ...) or none was refused
  // before anything was revoked, so it is not done.
  return provider === "google" && answer.status === 400 && answer.json.error === "invalid_token";
}

// ---- Meetings ----------------------------------------------------------------

export type MeetingSpec = {
  /** Google: the event id we choose (see eventId). Zoom ignores it. */
  eventId: string;
  title: string;
  description: string;
  start: number;
  end: number;
  tz: string;
  /** Google: who is on the guest list. Nobody is emailed by Google. */
  guests: string[];
  group: boolean;
};

export type Meeting = { id: string; link: string };

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/**
 * The id our Google event for a scope has: "nimbus" and 26 characters of a
 * hash, which Google accepts as an event id (base32hex, 5 to 1024
 * characters). The same scope always makes the same id, so a request that
 * timed out after Google made the event cannot make a second one, and the
 * prefix lets a calendar read back in (lib/ics-parse.ts) know these are ours.
 */
export function eventId(scope: string): string {
  const digest = createHash("sha256").update(`nimbus-meet:${scope}`).digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= 0xff;
  }
  return `nimbus${out}`;
}

const MEET_LINK = /^https:\/\/meet\.google\.com\/[a-z0-9-]{3,64}(\?[A-Za-z0-9=&_.-]{0,200})?$/;
const ZOOM_LINK = /^https:\/\/([a-z0-9-]+\.)*zoom\.(us|com)\/[jw]\/\d{9,12}(\?[A-Za-z0-9=&_.-]{0,300})?$/;
const ZOOM_START = /^https:\/\/([a-z0-9-]+\.)*zoom\.(us|com)\/s\/\d{9,12}(\?[A-Za-z0-9=&_.%-]{0,3000})?$/;

export function isMeetLink(link: string): boolean {
  return MEET_LINK.test(link);
}
export function isZoomLink(link: string): boolean {
  return ZOOM_LINK.test(link);
}

function meetLinkOf(event: Record<string, unknown>): string {
  if (typeof event.hangoutLink === "string" && MEET_LINK.test(event.hangoutLink)) return event.hangoutLink;
  const data = event.conferenceData as { entryPoints?: { entryPointType?: unknown; uri?: unknown }[] } | undefined;
  const video = data?.entryPoints?.find((p) => p.entryPointType === "video" && typeof p.uri === "string");
  return video && MEET_LINK.test(video.uri as string) ? (video.uri as string) : "";
}

function conferenceState(event: Record<string, unknown>): string {
  const data = event.conferenceData as { createRequest?: { status?: { statusCode?: unknown } } } | undefined;
  const code = data?.createRequest?.status?.statusCode;
  return typeof code === "string" ? code : "";
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function googleBody(spec: MeetingSpec): Record<string, unknown> {
  return {
    summary: spec.title.slice(0, 250),
    description: spec.description.slice(0, 4000),
    start: { dateTime: iso(spec.start), timeZone: spec.tz },
    end: { dateTime: iso(spec.end), timeZone: spec.tz },
    attendees: spec.guests.map((email) => ({ email })),
    // Buyers of a group call never see each other's addresses, and nobody
    // but the creator adds people.
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: !spec.group,
    guestsCanModify: false,
    source: { title: "Marktmorgen", url: SITE_URL },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Makes the Google Calendar event for a scope, with a Meet link, on the
 * creator's primary calendar — or finds the one made before. Nobody is
 * emailed by Google (sendUpdates=none): the buyer's confirmation, reminders
 * and calendar file come from us, as for every other call, so nobody gets
 * the same news twice. They are on the guest list all the same, which is
 * what lets them into the Meet without waiting to be let in, when they are
 * signed in to Google with that address.
 */
export async function googleCreate(token: string, spec: MeetingSpec, calendar = "primary"): Promise<Meeting> {
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const events = `${GOOGLE.calendar()}/calendars/${calendarPath(calendar)}/events`;
  const request = () => ({ createRequest: { requestId: `${spec.eventId}-${randomBytes(4).toString("hex")}`, conferenceSolutionKey: { type: "hangoutsMeet" } } });
  let answer = await call(`${events}?conferenceDataVersion=1&sendUpdates=none`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: spec.eventId, ...googleBody(spec), conferenceData: request() }),
  });
  let event: Record<string, unknown>;
  if (answer.status === 200) {
    event = answer.json;
  } else if (answer.status === 409) {
    // Made by an earlier try that did not hear back: carry on with it.
    answer = await call(`${events}/${spec.eventId}`, { method: "GET", headers: auth });
    if (answer.status !== 200) throw problem(answer, "reading the event");
    event = answer.json;
    const stale = event.status === "cancelled" || !meetLinkOf(event);
    if (stale) {
      answer = await call(`${events}/${spec.eventId}?conferenceDataVersion=1&sendUpdates=none`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({
          status: "confirmed",
          ...googleBody(spec),
          ...(meetLinkOf(event) || conferenceState(event) === "pending" ? {} : { conferenceData: request() }),
        }),
      });
      if (answer.status !== 200) throw problem(answer, "restoring the event");
      event = answer.json;
    }
  } else {
    throw problem(answer, "making the event");
  }
  // Google usually adds the Meet at once; when it says "pending", it is
  // asked again a few times, briefly.
  for (let i = 0; i < 3 && !meetLinkOf(event) && conferenceState(event) === "pending"; i += 1) {
    await wait(700);
    const again = await call(`${events}/${spec.eventId}`, { method: "GET", headers: auth });
    if (again.status === 200) event = again.json;
  }
  const link = meetLinkOf(event);
  if (!link) {
    throw new ProviderError(
      "bad",
      200,
      conferenceState(event) === "failure"
        ? "Google made the event but could not add a Meet link to it (Google Meet may be off for this account)"
        : "Google made the event but has not added a Meet link yet",
    );
  }
  return { id: spec.eventId, link };
}

/** Moves the event to a new time. */
export async function googleMove(token: string, id: string, spec: Pick<MeetingSpec, "start" | "end" | "tz">, calendar = "primary"): Promise<void> {
  const answer = await call(`${GOOGLE.calendar()}/calendars/${calendarPath(calendar)}/events/${encodeURIComponent(id)}?sendUpdates=none`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ start: { dateTime: iso(spec.start), timeZone: spec.tz }, end: { dateTime: iso(spec.end), timeZone: spec.tz } }),
  });
  if (answer.status !== 200) throw problem(answer, "moving the event");
}

/**
 * Puts the guest list right: our buyers who should be on it (`want`) are
 * added, those we put there before and who should not be any more (`had`
 * less `want`) are taken off, and anyone the creator added themselves is
 * left alone.
 */
export async function googleGuests(token: string, id: string, want: string[], had: string[], calendar = "primary"): Promise<void> {
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const url = `${GOOGLE.calendar()}/calendars/${calendarPath(calendar)}/events/${encodeURIComponent(id)}`;
  const read = await call(url, { method: "GET", headers: auth });
  if (read.status !== 200) throw problem(read, "reading the event");
  const lower = (s: string) => s.toLowerCase();
  const wanted = new Set(want.map(lower));
  const ours = new Set(had.map(lower));
  const current = Array.isArray(read.json.attendees) ? (read.json.attendees as { email?: unknown }[]) : [];
  const kept = current.filter((a) => typeof a.email === "string" && (wanted.has(lower(a.email)) || !ours.has(lower(a.email))));
  const present = new Set(kept.map((a) => lower(a.email as string)));
  const attendees = [...kept, ...[...wanted].filter((e) => !present.has(e)).map((email) => ({ email }))];
  const answer = await call(`${url}?sendUpdates=none`, { method: "PATCH", headers: auth, body: JSON.stringify({ attendees }) });
  if (answer.status !== 200) throw problem(answer, "changing the guest list");
}

/** Deletes the event. One already gone counts as done. */
export async function googleDelete(token: string, id: string, calendar = "primary"): Promise<void> {
  const answer = await call(`${GOOGLE.calendar()}/calendars/${calendarPath(calendar)}/events/${encodeURIComponent(id)}?sendUpdates=none`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (answer.status === 204 || answer.status === 200 || answer.status === 404 || answer.status === 410) return;
  throw problem(answer, "deleting the event");
}

/** A calendar id as a path segment: "primary", or an id Google gave us (an address-like string), encoded. */
function calendarPath(calendar: string): string {
  return calendar && calendar.length <= 300 ? encodeURIComponent(calendar) : "primary";
}

/** The longest stretch asked of free/busy in one request; a longer horizon is asked in pieces. */
export const FREEBUSY_CHUNK_DAYS = 30;
/** Calendars read for one host, at most (Google answers for up to 50). */
export const MAX_READ_CALENDARS = 10;

/**
 * When the host is busy on each calendar given, from `from` to `to`: busy
 * stretches only, never a title, a guest or a place. Asked in pieces of
 * FREEBUSY_CHUNK_DAYS. A calendar Google answers with an error for makes the
 * whole reading fail, so a calendar that could not be read never looks free;
 * so does an answer in any other shape than Google's (tests/r24-google-freebusy-exact.test.ts).
 */
export async function googleFreeBusy(token: string, calendars: string[], from: number, to: number): Promise<[number, number][]> {
  const ids = (calendars.length ? calendars : ["primary"]).slice(0, MAX_READ_CALENDARS);
  const busy: [number, number][] = [];
  for (let at = from; at < to; at += FREEBUSY_CHUNK_DAYS * 86_400_000) {
    const until = Math.min(to, at + FREEBUSY_CHUNK_DAYS * 86_400_000);
    const answer = await call(`${GOOGLE.calendar()}/freeBusy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: iso(at), timeMax: iso(until), items: ids.map((id) => ({ id })) }),
    });
    if (answer.status !== 200) throw problem(answer, "reading free/busy");
    const found = (answer.json.calendars ?? {}) as Record<string, unknown>;
    for (const id of ids) {
      const entry = found[id] as { busy?: unknown; errors?: unknown } | undefined;
      if (!entry) throw new ProviderError("bad", 200, `Google did not answer for one of your calendars`);
      // Read in its exact shape (CX-123 rule 24): only an absent `busy` or a confirmed empty list is
      // "nothing busy"; any other shape is unknown and throws, so a calendar never reads as free.
      const unreadable = () => new ProviderError("bad", 200, `Google answered for one of your calendars in a shape we cannot read`);
      if (typeof entry !== "object" || Array.isArray(entry)) throw unreadable();
      if (entry.errors !== undefined && !Array.isArray(entry.errors)) throw unreadable();
      if (Array.isArray(entry.errors) && entry.errors.length) {
        const first = entry.errors[0] as { reason?: unknown } | null | undefined;
        const reason = String(first?.reason ?? "error").slice(0, 60);
        throw new ProviderError(reason === "notFound" ? "gone" : "server", 200, `Google could not read one of your calendars (${reason})`);
      }
      if (entry.busy === undefined) continue;
      if (!Array.isArray(entry.busy) || entry.busy.length > 5_000) throw unreadable();
      for (const b of entry.busy as unknown[]) {
        if (!b || typeof b !== "object" || Array.isArray(b)) throw unreadable();
        const { start, end } = b as { start?: unknown; end?: unknown };
        const s = rfc3339(start);
        const e = rfc3339(end);
        if (s === null || e === null || e <= s) throw unreadable();
        busy.push([s, e]);
      }
    }
  }
  return busy;
}

/**
 * Google's TimePeriod start/end are RFC 3339 date-times (`date-time` in the API discovery document): a full date, a
 * time and an explicit zone, `Z` or `±hh:mm`. Anything else is not read (CX-123 rule 24): Date.parse would take "1"
 * for 2001, a date alone, locale text, a time without a zone in the server's own zone, and 30 February as 2 March.
 * The calendar fields are checked before conversion, so no time is moved. Returns the instant in ms, or null.
 */
function rfc3339(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const last = new Date(0);
  last.setUTCFullYear(year, month, 0);
  const days = last.getUTCDate();
  if (day > days) return null;
  let offset = 0;
  if (m[8] !== "Z") {
    const oh = Number(m[8].slice(1, 3));
    const om = Number(m[8].slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offset = (m[8][0] === "+" ? 1 : -1) * (oh * 60 + om) * 60_000;
  }
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  // setUTCFullYear keeps a year below 100 as given (Date.UTC would move it into the 1900s).
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, ms);
  return at.getTime() - offset;
}

export type GoogleCalendar = { id: string; name: string; primary: boolean; writable: boolean };

/** The host's calendars, for them to pick from: at most 100, primary first. */
export async function googleCalendars(token: string): Promise<GoogleCalendar[]> {
  const answer = await call(`${GOOGLE.calendar()}/users/me/calendarList?maxResults=100&minAccessRole=freeBusyReader`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (answer.status !== 200) throw problem(answer, "listing your calendars");
  const items = Array.isArray(answer.json.items) ? (answer.json.items as Record<string, unknown>[]) : [];
  return items
    .filter((c) => typeof c.id === "string" && c.id && (c.id as string).length <= 300)
    .map((c) => ({
      id: c.id as string,
      name: String(c.summaryOverride ?? c.summary ?? c.id).slice(0, 120),
      primary: c.primary === true,
      writable: c.accessRole === "owner" || c.accessRole === "writer",
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

function zoomBody(spec: Pick<MeetingSpec, "start" | "end" | "tz">) {
  return {
    start_time: iso(spec.start),
    duration: Math.max(1, Math.round((spec.end - spec.start) / 60_000)),
    timezone: spec.tz,
  };
}

/**
 * Makes a scheduled Zoom meeting for the connected user. Its join link is
 * what buyers get; the host's start link is never stored or sent — the
 * studio asks Zoom for a fresh one when the creator presses Start.
 */
export async function zoomCreate(token: string, spec: MeetingSpec): Promise<Meeting> {
  const answer = await call(`${ZOOM.api()}/users/me/meetings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: spec.title.slice(0, 200),
      type: 2,
      ...zoomBody(spec),
      agenda: spec.description.slice(0, 2000),
      settings: { join_before_host: false, mute_upon_entry: spec.group, approval_type: 2 },
    }),
  });
  if (answer.status !== 201 && answer.status !== 200) throw problem(answer, "making the meeting");
  const id = typeof answer.json.id === "number" || typeof answer.json.id === "string" ? String(answer.json.id) : "";
  const link = typeof answer.json.join_url === "string" ? answer.json.join_url : "";
  if (!/^\d{9,12}$/.test(id) || !ZOOM_LINK.test(link)) throw new ProviderError("bad", answer.status, "Zoom answered without a join link");
  return { id, link };
}

export async function zoomMove(token: string, id: string, spec: Pick<MeetingSpec, "start" | "end" | "tz">): Promise<void> {
  const answer = await call(`${ZOOM.api()}/meetings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(zoomBody(spec)),
  });
  if (answer.status !== 204 && answer.status !== 200) throw problem(answer, "moving the meeting");
}

export async function zoomDelete(token: string, id: string): Promise<void> {
  const answer = await call(`${ZOOM.api()}/meetings/${encodeURIComponent(id)}?cancel_meeting_reminder=false`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (answer.status === 204 || answer.status === 200 || answer.status === 404) return;
  throw problem(answer, "deleting the meeting");
}

/** A fresh host link, for the creator only, the moment they ask for it. */
export async function zoomStartUrl(token: string, id: string): Promise<string> {
  const answer = await call(`${ZOOM.api()}/meetings/${encodeURIComponent(id)}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  if (answer.status !== 200) throw problem(answer, "reading the meeting");
  const url = typeof answer.json.start_url === "string" ? answer.json.start_url : "";
  if (!ZOOM_START.test(url)) throw new ProviderError("bad", 200, "Zoom answered without a start link");
  return url;
}

// ---- Zoom's notices ------------------------------------------------------------

/**
 * Whether a notice really came from Zoom: its signature is HMAC-SHA256 of
 * "v0:<timestamp>:<body>" under the app's secret token, and the timestamp is
 * within five minutes, so an old notice cannot be played again.
 */
export function zoomSigned(body: string, timestamp: string | null, signature: string | null, now = Date.now()): boolean {
  const secret = env("ZOOM_WEBHOOK_SECRET_TOKEN");
  if (!secret || !timestamp || !signature || !/^\d{9,13}$/.test(timestamp)) return false;
  const seconds = timestamp.length > 11 ? Number(timestamp) / 1000 : Number(timestamp);
  if (Math.abs(now / 1000 - seconds) > 300) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The answer to Zoom's check of the notice address. */
export function zoomValidation(plainToken: string): { plainToken: string; encryptedToken: string } {
  return { plainToken, encryptedToken: createHmac("sha256", env("ZOOM_WEBHOOK_SECRET_TOKEN")).update(plainToken).digest("hex") };
}

export function zoomClientId(): string {
  return env("ZOOM_CLIENT_ID");
}
