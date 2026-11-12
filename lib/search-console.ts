/**
 * Which Google searches found a store (added 11 October 2026), as DataFast
 * reads Google Search Console beside its own numbers: the searches that
 * showed the store's pages, how many people clicked, and where the store
 * stood. A creator learns which words buyers use, for their titles and their
 * posts, and which searches already almost bring them people.
 *
 * Every store lives at marktmorgen.com/@handle, a site that is ours, so the
 * searches are read from our own Search Console, page by page, and a creator
 * connects nothing. Our side is connected once, by the person who runs the
 * site, with Google's consent page asking for read-only access to Search
 * Console (webmasters.readonly) on the account that holds the site; the
 * refresh token is sealed before it is kept (lib/secret-box.ts) and never
 * shown again. The redirect is the one already registered for Google
 * (lib/meet-providers.ts); a state starting "gsc." is this flow's own.
 *
 * Read for a store when its studio opens, at most once a day (a failed read
 * waits an hour), over the 28 days that end three days ago, because Google
 * settles its figures about two days late. Google leaves out searches made by
 * very few people, to protect them, so the rows are the searches it shows,
 * not every one. A store on its own domain is found there, not here, and is
 * not read.
 *
 *   nl:gsc:conn            JSON { refresh: sealed, account, at }
 *   nl:gsc:state:<state>   JSON { email } for ten minutes, while the consent page is open
 *   nl:gsc:q:<statsId>     the store's last reading, a day (an hour after a failure)
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { seal, unseal } from "@/lib/secret-box";
import { REDIRECT_URIS, googleAccount, refreshTokens } from "@/lib/meet-providers";
import { configuredDemoStudioAdmin } from "@/lib/house-store";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";

export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
/** The property every store lives under: the URL-prefix property verified by public/google*.html. */
export const SEARCH_CONSOLE_SITE = "https://marktmorgen.com/";
/** Who may connect it: the person who runs the site, signed in to the studio. */

const CONN = "nl:gsc:conn";
const stateKey = (state: string) => `nl:gsc:state:${state}`;
const cacheKey = (statsId: string) => `nl:gsc:q:${statsId}`;
const CONTEXT = "search-console|marktmorgen";
const STATE = /^gsc\.[A-Za-z0-9_-]{20,64}$/;
export const SEARCH_ROWS = 25;
const DAY_MS = 86_400_000;

export const isOperator = (email: string | null | undefined) => {
  const operator = configuredDemoStudioAdmin();
  return Boolean(operator && email && email.trim().toLowerCase() === operator);
};
const env = (name: string) => process.env[name]?.trim() ?? "";
export const searchConsoleConfigured = () => Boolean(env("GOOGLE_OAUTH_CLIENT_ID") && env("GOOGLE_OAUTH_CLIENT_SECRET"));
export const isSearchConsoleState = (state: string) => STATE.test(state);

/** A single SET kept only on its exact "OK" (CX-123 rule 24); any other reply is unknown and throws. */
async function kept(command: (string | number)[], what: string): Promise<void> {
  const replies = repliesFor(await redisPipeline([command]), 1);
  if (!replies || replies[0] !== "OK") throw new UnknownReplyError(what);
}

export type SearchRow = { query: string; clicks: number; impressions: number; position: number };
export type StoreSearches = { from: string; to: string; rows: SearchRow[] };

/** Whether our side is connected, and with which Google account. */
export async function searchConsoleStatus(): Promise<{ connected: boolean; account: string }> {
  if (!isRedisConfigured()) return { connected: false, account: "" };
  const [raw] = await redisPipeline([["GET", CONN]]);
  try {
    const value = typeof raw === "string" ? (JSON.parse(raw) as { refresh?: string; account?: string }) : null;
    return { connected: Boolean(value?.refresh), account: value?.account ?? "" };
  } catch {
    return { connected: false, account: "" };
  }
}

/** Google's consent page, for the operator: read-only Search Console, and who they are. */
export async function beginSearchConsole(email: string): Promise<string | null> {
  if (!isOperator(email) || !searchConsoleConfigured() || !isRedisConfigured()) return null;
  const state = `gsc.${randomBytes(24).toString("base64url")}`;
  await kept(["SET", stateKey(state), JSON.stringify({ email: email.toLowerCase() }), "EX", 600], "keeping the consent page's state");
  const query = new URLSearchParams({
    client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
    redirect_uri: REDIRECT_URIS.google,
    response_type: "code",
    scope: ["openid", "email", SEARCH_CONSOLE_SCOPE].join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    hl: "en",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

/**
 * Back from Google's page: the state must be this flow's, unspent, and
 * started by the same operator; the answer must grant Search Console and
 * carry a refresh token. Keeps it sealed.
 */
export async function finishSearchConsole(state: string, code: string, email: string | null): Promise<"connected" | "expired" | "declined" | "scope" | "error"> {
  if (!STATE.test(state) || !isRedisConfigured()) return "expired";
  const [raw] = await redisPipeline([["GETDEL", stateKey(state)]]);
  let started = "";
  try {
    started = typeof raw === "string" ? String((JSON.parse(raw) as { email?: unknown }).email ?? "") : "";
  } catch {
    started = "";
  }
  if (!started || !email || started !== email.toLowerCase() || !isOperator(email)) return "expired";
  if (!code) return "declined";
  if (code.length > 2048 || !/^[A-Za-z0-9._~/+=-]+$/.test(code)) return "error";
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
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return "error";
    const scope = typeof json.scope === "string" ? json.scope : "";
    const refresh = typeof json.refresh_token === "string" ? json.refresh_token : "";
    if (!scope.split(/\s+/).includes(SEARCH_CONSOLE_SCOPE)) return "scope";
    if (!refresh || refresh.length > 4000) return "error";
    const account = googleAccount(json.id_token)?.email ?? "";
    await kept(["SET", CONN, JSON.stringify({ refresh: seal(refresh, CONTEXT), account, at: Date.now() })], "keeping the Search Console connection");
    return "connected";
  } catch {
    return "error";
  }
}

/**
 * Takes the connection away. Done only on DEL's count (0: it was not there);
 * any other reply throws, so nobody is told it is disconnected while the
 * sealed token may still be kept and read (CX-123 rule 24).
 */
export async function disconnectSearchConsole(): Promise<void> {
  if (!isRedisConfigured()) return;
  const replies = repliesFor(await redisPipeline([["DEL", CONN]]), 1);
  if (!replies || countOf(replies[0]) === null) throw new UnknownReplyError("taking the Search Console connection away");
}

/** The page filter for one store: its own address and everything under it, nothing else. */
export function storePattern(handle: string): string {
  const site = SEARCH_CONSOLE_SITE.replace(/\/$/, "").replace(/[.]/g, "\\.");
  return `^${site}/@${handle.replace(/[^a-z0-9_-]/gi, "")}(/|\\?|$)`;
}

/** The 28 days a reading covers, ending three days before `now`. */
export function searchWindow(now = Date.now()): { from: string; to: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: day(now - 30 * DAY_MS), to: day(now - 3 * DAY_MS) };
}

/** Google's rows, made ours: the search, clicks, how often shown, and the average place, rounded to a tenth. */
export function readRows(json: unknown): SearchRow[] {
  // Google leaves `rows` out when nothing was found; anything else out of its shape is not known, never 0 clicks
  // or no searches (CX-123 rule 24): thrown, so the caller keeps "Google did not answer" for an hour.
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("Search Console answered in a shape that could not be read");
  const rows = (json as { rows?: unknown }).rows;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new Error("Search Console's rows could not be read");
  const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return rows
    .map((row) => {
      const r = (row ?? {}) as { keys?: unknown; clicks?: unknown; impressions?: unknown; position?: unknown };
      if (!count(r.clicks) || !count(r.impressions) || !count(r.position)) throw new Error("A Search Console row could not be read");
      // Its search is the first of its keys, as text (asked by query); one without it is not known (review of Codex J).
      if (!Array.isArray(r.keys) || typeof r.keys[0] !== "string") throw new Error("A Search Console row came without its search");
      const query = r.keys[0].slice(0, 200);
      return { query, clicks: r.clicks as number, impressions: r.impressions as number, position: Math.round((r.position as number) * 10) / 10 };
    })
    .filter((r) => r.query && r.impressions > 0)
    .slice(0, SEARCH_ROWS);
}

/**
 * A kept answer, read back only in the shape it was written (Codex T on
 * #2684): null ("Google did not answer", kept an hour) or the window and its
 * rows. Anything else is not used (undefined) and Google is asked again.
 */
function keptSearches(raw: string): StoreSearches | null | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const day = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!day(v.from) || !day(v.to) || !Array.isArray(v.rows) || v.rows.length > SEARCH_ROWS) return undefined;
  const rows: SearchRow[] = [];
  for (const row of v.rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
    const r = row as Record<string, unknown>;
    if (typeof r.query !== "string" || !r.query || !count(r.clicks) || !count(r.impressions) || !count(r.position)) return undefined;
    rows.push({ query: r.query, clicks: r.clicks as number, impressions: r.impressions as number, position: r.position as number });
  }
  return { from: v.from as string, to: v.to as string, rows };
}

/**
 * The searches that found one store, kept a day. Null when our side is not
 * connected, the store is on a domain of its own, or Google did not answer.
 */
export async function storeSearches(store: Store, now = Date.now()): Promise<StoreSearches | null> {
  if (!store.statsId || !isRedisConfigured() || !searchConsoleConfigured() || store.domain) return null;
  if (!SITE_URL.startsWith(SEARCH_CONSOLE_SITE.replace(/\/$/, ""))) return null;
  const reply: unknown = await redisPipeline([["GET", cacheKey(store.statsId)], ["GET", CONN]]);
  // Two answers or not known: never a guess at the store's searches.
  if (!Array.isArray(reply) || reply.length !== 2) return null;
  const [cached, conn] = reply as unknown[];
  if (typeof cached === "string") {
    const kept = keptSearches(cached);
    if (kept !== undefined) return kept;
    // Not in its shape: read again below.
  }
  let refresh = "";
  try {
    const value = typeof conn === "string" ? (JSON.parse(conn) as { refresh?: string }) : null;
    const opened = value?.refresh ? unseal(value.refresh, CONTEXT) : null;
    refresh = opened && opened.ok ? opened.value : "";
  } catch {
    refresh = "";
  }
  if (!refresh) return null;
  const window = searchWindow(now);
  const keep = (value: StoreSearches | null, seconds: number) =>
    redisPipeline([["SET", cacheKey(store.statsId as string), JSON.stringify(value), "EX", seconds]]).catch(() => undefined);
  try {
    const { access } = await refreshTokens("google", refresh);
    const response = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SEARCH_CONSOLE_SITE)}/searchAnalytics/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
      body: JSON.stringify({
        startDate: window.from,
        endDate: window.to,
        dimensions: ["query"],
        dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "includingRegex", expression: storePattern(store.handle) }] }],
        rowLimit: SEARCH_ROWS,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error("reading Search Console failed", response.status, (await response.text().catch(() => "")).slice(0, 300));
      await keep(null, 3600);
      return null;
    }
    const value = { ...window, rows: readRows(await response.json()) };
    await keep(value, 86_400);
    return value;
  } catch (error) {
    console.error("reading Search Console failed", error);
    await keep(null, 3600);
    return null;
  }
}
