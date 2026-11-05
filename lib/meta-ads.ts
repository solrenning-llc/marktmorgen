/**
 * A store's own Meta ad account, connected with Facebook Login, so what its
 * campaigns spent is read once a day into the numbers (added 13 October
 * 2026): each channel's "Left", its recorded result after refunds, and the
 * days it took to pay back (lib/ad-spend-rules.ts) then use what Meta
 * charged, not only what was typed. The rows become lines by
 * lib/meta-ads-rules.ts.
 *
 * Off, and shown nowhere, until the deployment has the keys of its Meta app
 * (META_APP_ID and META_APP_SECRET), and Meta has granted that app the
 * ads_read permission. Only the store's owner and Admins connect or
 * disconnect ("settings"), and each change is told to the owner's inbox.
 *
 * Connecting: the studio posts to /api/integrations/meta/start, a state (32
 * random bytes) is kept for ten minutes bound to the signed-in session, the
 * person and the store, and the person is sent to Meta's consent page asking
 * for ads_read and nothing else. Meta sends them back to
 * /api/integrations/meta/callback; the state is taken once, must match that
 * session and person, who must still be allowed "settings" there; then the
 * code is traded for a token, the token for a long-lived one (about 60 days,
 * Meta's limit for a person's token), and the ad accounts the person can
 * read are listed. With one account, or one in the store's currency, it is
 * used at once; with more, the studio asks which.
 *
 * What is kept: the Meta user's ID (for Meta's notice that they removed the
 * app), the token sealed with lib/secret-box.ts and never sent anywhere but
 * Meta, the ad accounts' IDs, names and currencies, and, once a day, what
 * each campaign spent on each day and platform, for the last 30 days. Nothing
 * about anybody who saw or clicked an ad is asked for. Every call carries
 * appsecret_proof, so a token on its own is of no use to anyone else.
 *
 * Disconnecting gives the permission back (DELETE /me/permissions), so access
 * ends on Meta's side too, and deletes the connection and every line read
 * from it. Meta's notice that the person removed the app does the same.
 *
 *   nl:metaads:conn:<statsId>     the connection
 *   nl:metaads:read:<statsId>     when it was last read, and what went wrong
 *   nl:stats:<statsId>:spend:meta the lines read (lib/ad-spend.ts adds them in)
 *   nl:metaads:state:<hash>       one consent in progress, ten minutes
 *   nl:metaads:user:<hash>        the stores a Meta user connected
 *   nl:metaads:stores             the stores connected, for the daily read
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { storeForId } from "@/lib/store";
import { costsPaused } from "@/lib/plan-standing";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { canSeal, seal, unseal } from "@/lib/secret-box";
import { timed } from "@/lib/fetch-timeout";
import type { AdSpend } from "@/lib/ad-spend-rules";
import { linesFrom, mergeLines, parseLines, readWindow, type InsightRow } from "@/lib/meta-ads-rules";

export type MetaAccount = { id: string; name: string; currency: string };

type Connection = {
  user: string;
  /** Sealed. */
  token: string;
  /** When the token stops working, in seconds; 0 when Meta did not say. */
  expires: number;
  accounts: MetaAccount[];
  /** The account read, by its id ("act_…"); empty until one is chosen. */
  account: string;
  connectedAt: number;
  by: string;
  sid: string;
  owner: { email: string; handle: string };
  /** Why it stopped working, in words; empty while it works. */
  broken: string;
};

/** What the last read did. */
export type MetaRead = {
  /** The day (UTC) it last read; empty before the first read. */
  day: string;
  at: number;
  /** What stopped the last try: the currencies differ, Meta was busy or failed. Empty when it worked. */
  problem: "" | "currency" | "busy" | "error";
  /** No try before this, after a problem Meta may get over (seconds). */
  after: number;
  /** Lines read, and what they come to, over the 30 days read. */
  lines: number;
  cents: number;
  campaigns: number;
};

/** What the studio is shown. */
export type MetaAdsView = {
  connected: boolean;
  accounts: MetaAccount[];
  account: MetaAccount | null;
  /** The store's currency, to say why an account in another one is not read. */
  currency: string;
  read: MetaRead | null;
  broken: string;
  /** When Meta's permission ends and it must be connected again, in seconds; 0 when unknown. */
  expires: number;
  by: string;
  /**
   * Set by a caller that holds the store: its reads wait while the plan's
   * renewal is unpaid or its payment disputed (lib/integration-pause.ts).
   */
  readPaused?: boolean;
};

const STATE_SECONDS = 600;
const KEEP_SECONDS = 400 * 86_400;
const REQUEST_MS = 10_000;
// Marketing API's supported version, not the latest Graph API version.
// Checked 2026-11-04: docs/meta-marketing-api-version-2026-11-04.md.
const DEFAULT_VERSION = "v25.0";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const connKey = (statsId: string) => `nl:metaads:conn:${statsId}`;
const readKey = (statsId: string) => `nl:metaads:read:${statsId}`;
export const linesKey = (statsId: string) => `nl:stats:${statsId}:spend:meta`;
const stateKey = (state: string) => `nl:metaads:state:${hash(`metaads-state:${state}`)}`;
const userKey = (user: string) => `nl:metaads:user:${hash(`metaads-user:${user}`)}`;
const STORES_KEY = "nl:metaads:stores";
const readingKey = (statsId: string) => `nl:metaads:reading:${statsId}`;
const context = (statsId: string) => `metaads|${statsId}|token`;

// ---- The app's keys and addresses ------------------------------------------------

function appId(): string {
  const v = process.env.META_APP_ID?.trim() ?? "";
  return /^\d{5,25}$/.test(v) ? v : "";
}

function appSecret(): string {
  return process.env.META_APP_SECRET?.trim() ?? "";
}

/** Whether this deployment has a Meta app to connect with. */
export function isMetaConfigured(): boolean {
  return Boolean(appId() && appSecret());
}

/** Local checks may point Meta at a stand-in on 127.0.0.1; nothing else is taken. */
function localBase(): string {
  const v = process.env.META_GRAPH_BASE ?? "";
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(v) ? v : "";
}

/** The Graph API version asked for: META_GRAPH_VERSION when it is one, else the one this was written against. */
export function graphVersion(): string {
  const v = process.env.META_GRAPH_VERSION?.trim() ?? "";
  return /^v\d{2}\.\d$/.test(v) ? v : DEFAULT_VERSION;
}

const graph = (path: string) => `${localBase() || "https://graph.facebook.com"}/${graphVersion()}${path}`;
const dialog = () => (localBase() ? `${localBase()}/meta/dialog/oauth` : `https://www.facebook.com/${graphVersion()}/dialog/oauth`);

/** Proves the call comes from the app's own server, as Meta asks of server calls. */
const proof = (token: string) => createHmac("sha256", appSecret()).update(token).digest("hex");

export class MetaError extends Error {
  readonly kind: "auth" | "permission" | "busy" | "error";
  constructor(kind: "auth" | "permission" | "busy" | "error", message: string) {
    super(message);
    this.kind = kind;
  }
}

/** One call to the Graph API, answered as JSON or thrown as a MetaError. */
async function call(method: "GET" | "DELETE", path: string, params: Record<string, string>, token = ""): Promise<Record<string, unknown>> {
  const url = new URL(path.startsWith("http") ? path : graph(path));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (token) {
    url.searchParams.set("access_token", token);
    url.searchParams.set("appsecret_proof", proof(token));
  }
  let response: Response;
  try {
    response = await timed(REQUEST_MS, (signal) => fetch(url, { method, signal, headers: { Accept: "application/json" } }));
  } catch {
    throw new MetaError("busy", "Meta could not be reached");
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok && !body.error) return body;
  const error = (body.error ?? {}) as { code?: number; message?: string };
  const code = Number(error.code);
  const message = String(error.message ?? `Meta answered ${response.status}`).slice(0, 200);
  if (code === 190 || code === 102) throw new MetaError("auth", message);
  if (code === 10 || (code >= 200 && code < 300)) throw new MetaError("permission", message);
  if ([1, 2, 4, 17, 32, 341, 613].includes(code) || (code >= 80_000 && code < 80_100) || response.status >= 500) throw new MetaError("busy", message);
  throw new MetaError("error", message);
}

// ---- Reading what is kept ----------------------------------------------------------

function parseConnection(raw: unknown): Connection | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Connection>;
    if (typeof v.user !== "string" || typeof v.token !== "string" || !Array.isArray(v.accounts)) return null;
    return {
      user: v.user,
      token: v.token,
      expires: Number(v.expires) || 0,
      accounts: v.accounts.filter((a): a is MetaAccount => Boolean(a && typeof a.id === "string" && typeof a.currency === "string")).map((a) => ({ id: a.id, name: String(a.name ?? ""), currency: a.currency.toLowerCase() })),
      account: typeof v.account === "string" ? v.account : "",
      connectedAt: Number(v.connectedAt) || 0,
      by: typeof v.by === "string" ? v.by : "",
      sid: typeof v.sid === "string" ? v.sid : "",
      owner: { email: String(v.owner?.email ?? ""), handle: String(v.owner?.handle ?? "") },
      broken: typeof v.broken === "string" ? v.broken : "",
    };
  } catch {
    return null;
  }
}

function parseRead(raw: unknown): MetaRead | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<MetaRead>;
    return {
      day: typeof v.day === "string" ? v.day : "",
      at: Number(v.at) || 0,
      problem: v.problem === "currency" || v.problem === "busy" || v.problem === "error" ? v.problem : "",
      after: Number(v.after) || 0,
      lines: Number(v.lines) || 0,
      cents: Number(v.cents) || 0,
      campaigns: Number(v.campaigns) || 0,
    };
  } catch {
    return null;
  }
}

async function readConnection(statsId: string): Promise<Connection | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", connKey(statsId)]]);
  return parseConnection(raw);
}

/**
 * The lines read from Meta, for lib/ad-spend.ts: only while the store is
 * still connected, so nothing read from an account outlives its connection.
 */
export async function metaLines(statsId: string): Promise<AdSpend[]> {
  if (!isRedisConfigured()) return [];
  const [conn, raw] = await redisPipeline([["EXISTS", connKey(statsId)], ["GET", linesKey(statsId)]]);
  return Number(conn) ? parseLines(raw) : [];
}

/** What the studio shows; null while the deployment has no Meta app, so nothing about it is shown. */
export async function metaView(statsId: string | null, currency: string): Promise<MetaAdsView | null> {
  if (!isMetaConfigured()) return null;
  const empty: MetaAdsView = { connected: false, accounts: [], account: null, currency, read: null, broken: "", expires: 0, by: "" };
  if (!statsId || !isRedisConfigured()) return empty;
  const [rawConn, rawRead] = await redisPipeline([["GET", connKey(statsId)], ["GET", readKey(statsId)]]);
  const c = parseConnection(rawConn);
  if (!c) return empty;
  return {
    connected: true,
    accounts: c.accounts,
    account: c.accounts.find((a) => a.id === c.account) ?? null,
    currency,
    read: parseRead(rawRead),
    broken: c.broken,
    expires: c.expires,
    by: c.by,
  };
}

// ---- Connecting ----------------------------------------------------------------------

type Pending = { statsId: string; sid: string; session: string; email: string; redirect: string; at: number };

/** Keeps a consent in progress and says where to send the person: Meta's page, asking for ads_read only. */
export async function beginMeta(input: { statsId: string; sid: string; sessionCookie: string; email: string; redirect: string }): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const pending: Pending = {
    statsId: input.statsId,
    sid: input.sid,
    session: hash(`metaads-session:${input.sessionCookie}`),
    email: input.email.toLowerCase(),
    redirect: input.redirect,
    at: Date.now(),
  };
  await redisPipeline([["SET", stateKey(state), JSON.stringify(pending), "EX", STATE_SECONDS]]);
  const url = new URL(dialog());
  url.searchParams.set("client_id", appId());
  url.searchParams.set("redirect_uri", input.redirect);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "ads_read");
  url.searchParams.set("response_type", "code");
  return url.toString();
}

/** Takes the consent a state names, once, if it was started by this session and person. */
export async function takeMeta(state: string, input: { sessionCookie: string; email: string }): Promise<{ statsId: string; sid: string; redirect: string } | null> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(state) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GETDEL", stateKey(state)]]);
  if (typeof raw !== "string") return null;
  try {
    const p = JSON.parse(raw) as Pending;
    if (p.session !== hash(`metaads-session:${input.sessionCookie}`)) return null;
    if (p.email !== input.email.toLowerCase()) return null;
    if (Date.now() - p.at > STATE_SECONDS * 1000) return null;
    return { statsId: p.statsId, sid: p.sid, redirect: p.redirect };
  } catch {
    return null;
  }
}

/** The account to read without asking: the only one, or the only active one in the store's currency. */
export function accountToUse(accounts: (MetaAccount & { active?: boolean })[], currency: string): string {
  if (accounts.length === 1) return accounts[0].id;
  const fits = accounts.filter((a) => a.currency === currency.toLowerCase() && a.active !== false);
  return fits.length === 1 ? fits[0].id : "";
}

export type MetaConnectResult = { ok: true; view: MetaAdsView; account: MetaAccount | null } | { ok: false; error: "seal" | "refused" | "permission" | "accounts" };

/** Trades the code for a long-lived token, lists the ad accounts and keeps the connection, sealed. */
export async function finishMeta(input: {
  statsId: string;
  sid: string;
  code: string;
  redirect: string;
  by: string;
  owner: { email: string; handle: string };
  currency: string;
}): Promise<MetaConnectResult> {
  if (!canSeal()) return { ok: false, error: "seal" };
  let short: string;
  try {
    const traded = await call("GET", "/oauth/access_token", { client_id: appId(), client_secret: appSecret(), redirect_uri: input.redirect, code: input.code });
    short = typeof traded.access_token === "string" ? traded.access_token : "";
  } catch (error) {
    if (error instanceof MetaError && error.kind === "busy") throw error;
    return { ok: false, error: "refused" };
  }
  if (!short) return { ok: false, error: "refused" };
  const long = await call("GET", "/oauth/access_token", { grant_type: "fb_exchange_token", client_id: appId(), client_secret: appSecret(), fb_exchange_token: short });
  const token = typeof long.access_token === "string" && long.access_token ? long.access_token : short;
  const expiresIn = Number(long.expires_in);
  const now = Math.floor(Date.now() / 1000);
  const granted = await call("GET", "/me/permissions", {}, token);
  const perms = Array.isArray(granted.data) ? (granted.data as { permission?: string; status?: string }[]) : [];
  const me = await call("GET", "/me", { fields: "id" }, token);
  const user = typeof me.id === "string" ? me.id : "";
  if (!perms.some((p) => p.permission === "ads_read" && p.status === "granted")) {
    await call("DELETE", "/me/permissions", {}, token).catch(() => ({}));
    return { ok: false, error: "permission" };
  }
  const listed = await call("GET", "/me/adaccounts", { fields: "account_id,name,currency,account_status", limit: "50" }, token);
  const raw = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
  const accounts = raw
    .filter((a) => typeof a.id === "string" && /^act_\d{1,30}$/.test(a.id) && typeof a.currency === "string")
    .map((a) => ({ id: String(a.id), name: String(a.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80), currency: String(a.currency).toLowerCase(), active: Number(a.account_status) === 1 }));
  if (!user || !accounts.length) {
    await call("DELETE", "/me/permissions", {}, token).catch(() => ({}));
    return { ok: false, error: "accounts" };
  }
  const before = await readConnection(input.statsId);
  const connection: Connection = {
    user,
    token: seal(token, context(input.statsId)),
    expires: Number.isFinite(expiresIn) && expiresIn > 0 ? now + Math.floor(expiresIn) : 0,
    accounts: accounts.map(({ id, name, currency }) => ({ id, name, currency })),
    account: accountToUse(accounts, input.currency),
    connectedAt: Date.now(),
    by: input.by,
    sid: input.sid,
    owner: input.owner,
    broken: "",
  };
  await redisPipeline([
    ["SET", connKey(input.statsId), JSON.stringify(connection)],
    ["DEL", readKey(input.statsId)],
    ["SADD", STORES_KEY, input.statsId],
    ["SADD", userKey(user), input.statsId],
  ]);
  // Another person's token in its place: theirs is given back.
  if (before && before.user !== user) {
    await giveBack(input.statsId, before).catch(() => {});
    await redisPipeline([["SREM", userKey(before.user), input.statsId]]).catch(() => {});
  }
  // Lines of an account no longer read go.
  if (before && before.account !== connection.account) await redisPipeline([["DEL", linesKey(input.statsId)]]);
  const view = (await metaView(input.statsId, input.currency)) as MetaAdsView;
  return { ok: true, view, account: view.account };
}

/** Chooses which of the connected person's ad accounts is read. */
export async function chooseAccount(statsId: string, id: unknown): Promise<boolean> {
  const c = await readConnection(statsId);
  if (!c || typeof id !== "string" || !c.accounts.some((a) => a.id === id)) return false;
  if (c.account === id) return true;
  await redisPipeline([
    ["SET", connKey(statsId), JSON.stringify({ ...c, account: id })],
    ["DEL", readKey(statsId)],
    ["DEL", linesKey(statsId)],
  ]);
  return true;
}

async function giveBack(statsId: string, c: Connection): Promise<void> {
  const open = unseal(c.token, context(statsId));
  if (open.ok) await call("DELETE", "/me/permissions", {}, open.value);
}

/** Disconnects: gives the permission back to Meta, then forgets the connection and every line read. */
export async function disconnectMeta(statsId: string): Promise<MetaAccount | null | false> {
  const c = await readConnection(statsId);
  if (!c) return false;
  // Forgotten here whatever Meta says: a give-back that fails must not keep a connection the creator ended.
  await giveBack(statsId, c).catch((error) => console.error("giving the Meta permission back failed", error));
  await forget(statsId, c.user);
  return c.accounts.find((a) => a.id === c.account) ?? null;
}

async function forget(statsId: string, user: string): Promise<void> {
  await redisPipeline([
    ["DEL", connKey(statsId)],
    ["DEL", readKey(statsId)],
    ["DEL", linesKey(statsId)],
    ["SREM", STORES_KEY, statsId],
    ["SREM", userKey(user), statsId],
  ]);
}

// ---- Meta's notice that a person removed the app ---------------------------------------

/** The user a signed_request from Meta is about, when its signature is the app's. */
export function signedUser(raw: unknown): string | null {
  const secret = appSecret();
  if (!secret || typeof raw !== "string" || raw.length > 4096) return null;
  const [sig, payload] = raw.split(".");
  if (!sig || !payload) return null;
  const made = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== made.length || !timingSafeEqual(given, made)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { algorithm?: string; user_id?: unknown };
    if (String(data.algorithm).toUpperCase() !== "HMAC-SHA256") return null;
    const user = typeof data.user_id === "string" || typeof data.user_id === "number" ? String(data.user_id) : "";
    return /^\d{1,30}$/.test(user) ? user : null;
  } catch {
    return null;
  }
}

/** Forgets every store a Meta user connected. Returns, for each, who to tell. */
export async function forgetMetaUser(user: string): Promise<{ statsId: string; owner: { email: string; handle: string } }[]> {
  if (!isRedisConfigured() || !user) return [];
  const [members] = await redisPipeline([["SMEMBERS", userKey(user)]]);
  const stores = Array.isArray(members) ? (members as unknown[]).filter((m): m is string => typeof m === "string") : [];
  const forgot: { statsId: string; owner: { email: string; handle: string } }[] = [];
  for (const statsId of stores.slice(0, 50)) {
    const c = await readConnection(statsId);
    if (!c || c.user !== user) continue;
    await forget(statsId, user);
    forgot.push({ statsId, owner: c.owner });
  }
  await redisPipeline([["DEL", userKey(user)]]);
  return forgot;
}

// ---- Reading what was spent ------------------------------------------------------------

/** What a read did: read, nothing to read yet, or why it stopped. */
export type ReadResult = "read" | "none" | "currency" | "busy" | "error" | "broken" | "paused";

/** Hook for telling the owner once that the connection broke. */
export type MetaBrokenHook = (owner: { email: string; handle: string }) => Promise<void>;

async function markBroken(statsId: string, c: Connection, why: string, onBroken?: MetaBrokenHook): Promise<void> {
  const now = await readConnection(statsId);
  if (!now || now.connectedAt !== c.connectedAt || now.broken) return;
  await redisPipeline([["SET", connKey(statsId), JSON.stringify({ ...now, broken: why })]]);
  await onBroken?.(now.owner).catch(() => {});
}

/**
 * Reads the last 30 days of the chosen account, campaign by campaign, day by
 * day and platform by platform, and keeps them as lines. Only when the
 * account's currency is the store's.
 */
export async function readMetaSpend(statsId: string, storeCurrency: string, now = Date.now(), onBroken?: MetaBrokenHook): Promise<ReadResult> {
  if (!isMetaConfigured() || !isRedisConfigured()) return "none";
  const c = await readConnection(statsId);
  if (!c || c.broken || !c.account) return c?.broken ? "broken" : "none";
  const account = c.accounts.find((a) => a.id === c.account);
  if (!account) return "none";
  // Resolve the connection's own current store, including calls made by the
  // daily job or account picker, before a read lock or any provider request.
  const store = await storeForId(c.sid);
  if (!store || store.statsId !== statsId) return "none";
  // 232 [CA1] 4b3: no read while the plan's renewal is unpaid or its payment disputed
  // (lib/integration-pause.ts); the daily pass counts it skipped and tries the next day.
  if (costsPaused(store)) return "paused";
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return "busy";
  const [got] = await redisPipeline([["SET", readingKey(statsId), "1", "NX", "EX", 90]]);
  if (got === null) return "busy";
  const window = readWindow(now);
  const note = async (read: Partial<MetaRead>) => {
    // Written only while that very connection is still there.
    const still = await readConnection(statsId);
    if (!still || still.connectedAt !== c.connectedAt || still.account !== c.account) return false;
    const [rawBefore] = await redisPipeline([["GET", readKey(statsId)]]);
    const before = parseRead(rawBefore);
    const next: MetaRead = { day: before?.day ?? "", at: before?.at ?? 0, problem: "", after: 0, lines: before?.lines ?? 0, cents: before?.cents ?? 0, campaigns: before?.campaigns ?? 0, ...read };
    await redisPipeline([["SET", readKey(statsId), JSON.stringify(next), "EX", KEEP_SECONDS]]);
    return true;
  };
  try {
    if (c.expires && c.expires * 1000 <= now) {
      await markBroken(statsId, c, "Meta's permission ran out (Meta asks for it again every 60 days or so)", onBroken);
      return "broken";
    }
    if (account.currency !== storeCurrency.toLowerCase()) {
      // Looked at again tomorrow, not every five minutes: a currency is not changed often.
      await note({ problem: "currency", after: Math.floor(Date.parse(`${window.to}T00:00:00Z`) / 1000) + 86_400 });
      return "currency";
    }
    const open = unseal(c.token, context(statsId));
    if (!open.ok) {
      await markBroken(statsId, c, open.reason === "other-key" ? "the key that protects it was changed" : "what we kept could not be read", onBroken);
      return "broken";
    }
    const rows: InsightRow[] = [];
    let next: string | null = graph(`/${account.id}/insights`);
    let params: Record<string, string> = {
      level: "campaign",
      time_increment: "1",
      breakdowns: "publisher_platform",
      fields: "campaign_id,campaign_name,spend",
      time_range: JSON.stringify({ since: window.from, until: window.to }),
      limit: "500",
    };
    for (let page = 0; next && page < 20; page += 1) {
      const answer = await call("GET", next, params, open.value);
      for (const row of Array.isArray(answer.data) ? (answer.data as InsightRow[]) : []) rows.push(row);
      const paging = answer.paging as { next?: unknown } | undefined;
      // Meta's next page carries the token and every parameter itself; it is followed only on Meta's own host.
      next = typeof paging?.next === "string" && sameHost(paging.next) ? paging.next : null;
      params = {};
    }
    const fresh = linesFrom(rows, account.currency);
    const [rawKept] = await redisPipeline([["GET", linesKey(statsId)]]);
    const merged = mergeLines(parseLines(rawKept), fresh, window.from, window.to);
    const still = await readConnection(statsId);
    if (!still || still.connectedAt !== c.connectedAt || still.account !== c.account) return "none";
    await redisPipeline([["SET", linesKey(statsId), JSON.stringify(merged), "EX", KEEP_SECONDS]]);
    await note({
      day: window.to,
      at: Math.floor(now / 1000),
      problem: "",
      after: 0,
      lines: fresh.length,
      cents: fresh.reduce((sum, line) => sum + line.cents, 0),
      campaigns: new Set(fresh.map((line) => line.campaign)).size,
    });
    return "read";
  } catch (error) {
    if (error instanceof MetaError && (error.kind === "auth" || error.kind === "permission")) {
      await markBroken(statsId, c, error.kind === "auth" ? "Meta no longer lets us in (access was withdrawn or ran out)" : "Meta no longer lets us read this ad account", onBroken);
      return "broken";
    }
    const busy = error instanceof MetaError && error.kind === "busy";
    console.error("reading Meta ad spend failed", error instanceof Error ? error.message : error);
    await note({ problem: busy ? "busy" : "error", after: Math.floor(now / 1000) + (busy ? 3600 : 6 * 3600) }).catch(() => false);
    return busy ? "busy" : "error";
  } finally {
    await redisPipeline([["DEL", readingKey(statsId)]]).catch(() => {});
  }
}

function sameHost(link: string): boolean {
  try {
    const url = new URL(link);
    const base = new URL(graph("/"));
    return url.origin === base.origin;
  } catch {
    return false;
  }
}

/**
 * The daily pass, a few stores at a time, from the five-minute job: every
 * connected store not yet read today, and not waiting out a problem.
 */
export async function readMetaDue(
  deadline: number,
  storeFor: (sid: string) => Promise<{ statsId: string | null; currency: string; email: string; handle: string } | null>,
  onBroken?: MetaBrokenHook,
): Promise<{ read: number; skipped: number }> {
  const counts = { read: 0, skipped: 0 };
  if (!isMetaConfigured() || !isRedisConfigured()) return counts;
  const [members] = await redisPipeline([["SMEMBERS", STORES_KEY]]);
  const stores = Array.isArray(members) ? (members as unknown[]).filter((m): m is string => typeof m === "string") : [];
  const today = new Date().toISOString().slice(0, 10);
  for (const statsId of stores) {
    if (Date.now() >= deadline) break;
    const [rawConn, rawRead] = await redisPipeline([["GET", connKey(statsId)], ["GET", readKey(statsId)]]);
    const c = parseConnection(rawConn);
    if (!c) {
      await redisPipeline([["SREM", STORES_KEY, statsId]]);
      continue;
    }
    const read = parseRead(rawRead);
    if (c.broken || !c.account || read?.day === today || (read?.after ?? 0) * 1000 > Date.now()) continue;
    const store = await storeFor(c.sid).catch(() => null);
    if (!store || store.statsId !== statsId) {
      counts.skipped += 1;
      continue;
    }
    const result = await readMetaSpend(statsId, store.currency, Date.now(), onBroken);
    if (result === "read") counts.read += 1;
    else counts.skipped += 1;
  }
  return counts;
}
