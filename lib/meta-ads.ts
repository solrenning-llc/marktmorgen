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
 * DELETE /me/permissions ends the person's whole grant to the app, for every
 * store they connected, so it is sent only when no other store still uses
 * that Meta login (issue #4011, decision ALL-160); otherwise this store only
 * forgets it, and the last store to disconnect gives it back.
 *
 *   nl:metaads:conn:<statsId>     the connection
 *   nl:metaads:read:<statsId>     when it was last read, and what went wrong
 *   nl:stats:<statsId>:spend:meta the lines read (lib/ad-spend.ts adds them in)
 *   nl:metaads:state:<hash>       one consent in progress, ten minutes
 *   nl:metaads:user:<hash>        the stores a Meta user connected
 *   nl:metaads:gone:<hash>        when Meta last told us a user removed the app or
 *                                 asked for a deletion, a day: a consent flow begun
 *                                 before it keeps nothing (finishMeta)
 *   nl:metaads:stores             the stores connected, for the daily read
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { storeForId } from "@/lib/store";
import { costsPaused } from "@/lib/plan-standing";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { canSeal, seal, unseal } from "@/lib/secret-box";
import { timed } from "@/lib/fetch-timeout";
import type { AdSpend } from "@/lib/ad-spend-rules";
import { linesFrom, mergeLines, minorUnits, parseLines, readWindow, type InsightRow } from "@/lib/meta-ads-rules";

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
  /** "big": the account has more lines over 30 days than one reading takes; tried again the next UTC day. */
  problem: "" | "currency" | "busy" | "big" | "error";
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
/**
 * The longest a consent flow may run, from beginMeta to the write that keeps its connection: the state is taken
 * within STATE_SECONDS (takeMeta), and the calls to Meta after it are each bounded by REQUEST_MS. A flow older than
 * this keeps nothing, so a deletion's mark, kept GONE_SECONDS, always outlasts every flow it has to stop.
 */
const FLOW_MS = 2 * STATE_SECONDS * 1000;
/** How long a deletion's mark is kept: far longer than any flow it has to stop (FLOW_MS). */
const GONE_SECONDS = 86_400;
/**
 * The room left for the clocks of two servers (the one that began the flow and the one Meta's notice reached): a
 * flow is taken as begun before a deletion unless it began more than this after it. A reconnection begun within it
 * is refused, honestly, and can simply be made again a few seconds later.
 */
const GONE_MARGIN_MS = 10_000;
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
const goneKey = (user: string) => `nl:metaads:gone:${hash(`metaads-gone:${user}`)}`;
const STORES_KEY = "nl:metaads:stores";
/** The daily pass's mark and the generation it holds (readMetaDue). */
const PASS_KEY = "nl:metaads:pass";
const GEN_KEY = "nl:metaads:gen";
/** The longest a pass mark lasts while a store is paused (its payment may be recorded at any time). */
export const PAUSED_PASS_SECONDS = 3600;
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

/**
 * The account's 30 days hold more rows than one read takes (20 pages of 500). Not something an hour changes: the same
 * read would ask Meta its 20 pages again and refuse the part again, so it is noted busy until the next day, never
 * tried every hour (each try is 20 calls against the creator's own ad account's rate limit at Meta).
 */
class MetaTooBig extends MetaError {
  constructor() {
    super("busy", "Meta had more ad spend than one read takes");
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
  const parsed: unknown = await response.json().catch(() => undefined);
  // Only a JSON object is one of Meta's answers (CX-123 rule 24): a success that is not one, or cannot be read, is
  // not known, never "nothing" (a read with no rows would erase the days already read).
  const object = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const body = (object ? parsed : {}) as Record<string, unknown>;
  if (response.ok && !object) throw new MetaError("busy", `Meta answered ${response.status} in a shape that could not be read`);
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

const wholeAccount = (a: unknown): a is MetaAccount => Boolean(a && typeof (a as MetaAccount).id === "string" && typeof (a as MetaAccount).currency === "string");

/** A field this code writes as text or a number, when it is there at all: missing reads as its default, as before. */
const absentOr = (value: unknown, type: "string" | "number") => value === undefined || (type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type);

/**
 * A kept connection, or null. With `whole`, every ad account in it, and the chosen account, why it broke and when it
 * runs out, must be in the shape this code writes, so what the studio is shown is never a list with one left out, nor
 * "choose an account" for one that could not be read, and a read or a choice never drops the chosen account or takes
 * a connection as healthy because a field could not be read (CX-123 rule 24).
 */
function parseConnection(raw: unknown, whole = false): Connection | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Connection>;
    if (!v || typeof v !== "object" || typeof v.user !== "string" || typeof v.token !== "string" || !Array.isArray(v.accounts)) return null;
    if (whole && !v.accounts.every(wholeAccount)) return null;
    if (whole && !(absentOr(v.account, "string") && absentOr(v.broken, "string") && absentOr(v.expires, "number") && absentOr(v.connectedAt, "number"))) return null;
    return {
      user: v.user,
      token: v.token,
      expires: Number(v.expires) || 0,
      accounts: v.accounts.filter(wholeAccount).map((a) => ({ id: a.id, name: String(a.name ?? ""), currency: a.currency.toLowerCase() })),
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

const keptCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** No read kept yet: no day, so the studio shows no amount. */
const NOT_READ: MetaRead = { day: "", at: 0, problem: "", after: 0, lines: 0, cents: 0, campaigns: 0 };

/**
 * The last read, only in the shape this code writes (CX-123 rule 24; Claude 6 on #3069): every field present, the day
 * a date or empty, each figure a non-negative whole number. A record with an amount missing or out of shape is not a
 * last read (null), never "Read <day>: $0.00 over the last 30 days".
 */
function parseRead(raw: unknown): MetaRead | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (typeof v.day !== "string" || (v.day !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(v.day))) return null;
    if (v.problem !== "" && v.problem !== "currency" && v.problem !== "busy" && v.problem !== "big" && v.problem !== "error") return null;
    if (![v.at, v.after, v.lines, v.cents, v.campaigns].every(keptCount)) return null;
    return {
      day: v.day,
      at: v.at as number,
      problem: v.problem,
      after: v.after as number,
      lines: v.lines as number,
      cents: v.cents as number,
      campaigns: v.campaigns as number,
    };
  } catch {
    return null;
  }
}

/**
 * A connection read exactly (exactConnection: null only when confirmed absent, an unknown reply or a record out of
 * shape throws) with the exact text it was read as, the text a write made only while it is there is held to
 * (writeIfConnected).
 */
async function exactConnectionAsSeen(statsId: string, whole = false): Promise<{ c: Connection; seen: string } | null> {
  const read = repliesFor(await redisPipeline([["GET", connKey(statsId)]]), 1);
  if (!read) throw new UnknownReplyError("a Meta connection");
  if (read[0] === null) return null;
  const c = parseConnection(read[0], whole);
  if (!c || typeof read[0] !== "string") throw new UnknownReplyError("a Meta connection");
  return { c, seen: read[0] };
}

/**
 * KEYS[1] the connection, KEYS[2] the key written, KEYS[3..] keys deleted with it; ARGV[1] the connection exactly as
 * it was read, ARGV[2] the value, ARGV[3] the seconds it is kept ("0": no expiry, else a whole number of at most nine
 * digits). 1 written, 0 the connection is no longer the one read (forgotten, reconnected, another account chosen) and
 * nothing is written, -1 a call of any other shape (fewer than two keys, not exactly three arguments, an expiry Redis
 * would refuse), refused before anything is read or written (as lib/path-atomic.ts does). Mirrored for tests in
 * lib/redis-memory.ts.
 */
const WRITE_IF_CONNECTED = `-- marktmorgen:meta-if-connected:v1
if #KEYS < 2 or #ARGV ~= 3 or (ARGV[3] ~= "0" and (#ARGV[3] > 9 or not string.match(ARGV[3], "^[1-9]%d*$"))) then return -1 end
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[3] == "0" then redis.call("SET", KEYS[2], ARGV[2]) else redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3]) end
for i = 3, #KEYS do redis.call("DEL", KEYS[i]) end
return 1`;

/**
 * KEYS[1] the connection, KEYS[2] the last read's record, KEYS[3] the stores connected, KEYS[4] the stores the Meta
 * user connected, KEYS[5] that user's deletion mark (forgetMetaUser); ARGV[1] the new connection, ARGV[2] the cutoff:
 * the time, in milliseconds, at or after which a deletion of that user stops this flow (finishMeta), ARGV[3] the
 * store. 1 the connection is kept, its record dropped and the store added to both sets; 0 a deletion at or after the
 * cutoff (or a mark that does not read as a time) and nothing is written; -1 a call of any other shape, refused
 * before anything is read or written. Both sets are checked to be sets (or absent) before the connection is written:
 * Redis does not undo a script that stops half-way, so a SADD failing on a key of another kind after the SET would
 * keep the connection, sealed token and all, outside the person's index (Claude 2 on #3322); such a key is Redis's
 * own WRONGTYPE error with nothing written. Mirrored for tests in lib/redis-memory.ts.
 */
const FINISH_UNLESS_GONE = `-- marktmorgen:meta-finish:v1
if #KEYS ~= 5 or #ARGV ~= 3 or #ARGV[2] > 16 or not string.match(ARGV[2], "^[1-9]%d*$") or ARGV[3] == "" then return -1 end
local gone = redis.call("GET", KEYS[5])
if gone and (#gone > 16 or not string.match(gone, "^%d+$") or tonumber(gone) >= tonumber(ARGV[2])) then return 0 end
for i = 3, 4 do
  local kind = redis.call("TYPE", KEYS[i])["ok"]
  if kind ~= "set" and kind ~= "none" then return redis.error_reply("WRONGTYPE Operation against a key holding the wrong kind of value") end
end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("DEL", KEYS[2])
redis.call("SADD", KEYS[3], ARGV[3])
redis.call("SADD", KEYS[4], ARGV[3])
return 1`;

/**
 * Writes `value` at `key` (and deletes `drop`) only while the store's connection is still exactly the one read, in
 * one step with that check (CX-123 rule 30). Checking first and writing after let a deletion confirmed to Meta in
 * between (forgetMetaUser, disconnectMeta) have what was read from Meta, or the connection itself, written again,
 * with no index left to find it. True when written, false when the connection is no longer that one; a reply in any
 * other shape is unknown (UnknownReplyError), never taken as written or as refused.
 */
async function writeIfConnected(statsId: string, seen: string, key: string, value: string, seconds: number, drop: string[] = []): Promise<boolean> {
  const replies = repliesFor(await redisPipeline([["EVAL", WRITE_IF_CONNECTED, 2 + drop.length, connKey(statsId), key, ...drop, seen, value, seconds]]), 1);
  const written = replies ? countOf(replies[0]) : null;
  if (written !== 0 && written !== 1) throw new UnknownReplyError("a Meta write made only while its connection is there");
  return written === 1;
}

/**
 * The lines read from Meta, for lib/ad-spend.ts: only while the store is
 * still connected, so nothing read from an account outlives its connection.
 */
export async function metaLines(statsId: string): Promise<AdSpend[]> {
  if (!isRedisConfigured()) return [];
  // Read exactly (CX-123 rule 24): no lines only when the store is confirmed not connected or nothing was read yet;
  // a reply in another shape throws, so the figures that use spend say it is unread instead of leaving it out as 0.
  const replies = repliesFor(await redisPipeline([["EXISTS", connKey(statsId)], ["GET", linesKey(statsId)]]), 2);
  const connected = replies ? countOf(replies[0]) : null;
  if (!replies || connected === null || connected > 1) throw new UnknownReplyError("Meta's ad spend lines");
  const raw = replies[1];
  if (connected === 0 || raw === null) return [];
  // Every member whole, or none read (Codex Z on #2924): one line in another shape is not the rest as all of it.
  const lines = parseLines(raw);
  if (!lines) throw new UnknownReplyError("Meta's ad spend lines");
  return lines;
}

/** What the studio shows; null while the deployment has no Meta app, so nothing about it is shown. */
export async function metaView(statsId: string | null, currency: string): Promise<MetaAdsView | null> {
  if (!isMetaConfigured()) return null;
  const empty: MetaAdsView = { connected: false, accounts: [], account: null, currency, read: null, broken: "", expires: 0, by: "" };
  if (!statsId || !isRedisConfigured()) return empty;
  // Read exactly (CX-123 rule 24): "not connected" only for a confirmed nil, the last read null only for one; a reply
  // or a kept record in another shape throws, so the studio is never told "not connected", "choose an account" or
  // "read for the first time within the hour" about a connection it could not read (the Meta route answers 503).
  const replies = repliesFor(await redisPipeline([["GET", connKey(statsId)], ["GET", readKey(statsId)]]), 2);
  if (!replies) throw new UnknownReplyError("the studio's Meta connection");
  const [rawConn, rawRead] = replies;
  if (rawConn === null) return empty;
  const c = parseConnection(rawConn, true);
  const read = rawRead === null ? null : parseRead(rawRead);
  if (!c || (rawRead !== null && !read)) throw new UnknownReplyError("the studio's Meta connection");
  return {
    connected: true,
    accounts: c.accounts,
    account: c.accounts.find((a) => a.id === c.account) ?? null,
    currency,
    read,
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

/**
 * Takes the consent a state names, once, if it was started by this session and person; `at` is when it was started
 * (milliseconds), which finishMeta holds a deletion confirmed since against.
 */
export async function takeMeta(state: string, input: { sessionCookie: string; email: string }): Promise<{ statsId: string; sid: string; redirect: string; at: number } | null> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(state) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GETDEL", stateKey(state)]]);
  if (typeof raw !== "string") return null;
  try {
    const p = JSON.parse(raw) as Pending;
    if (p.session !== hash(`metaads-session:${input.sessionCookie}`)) return null;
    if (p.email !== input.email.toLowerCase()) return null;
    if (Date.now() - p.at > STATE_SECONDS * 1000) return null;
    if (!Number.isSafeInteger(p.at) || p.at <= 0) return null;
    return { statsId: p.statsId, sid: p.sid, redirect: p.redirect, at: p.at };
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

export type MetaConnectResult =
  | { ok: true; view: MetaAdsView; account: MetaAccount | null }
  | { ok: false; error: "seal" | "refused" | "permission" | "accounts" | "expired" | "removed" };

/** Whether a flow begun at `startedAt` (milliseconds) is still young enough to keep its connection (FLOW_MS). */
const flowFresh = (startedAt: number): boolean => {
  const age = Date.now() - startedAt;
  return Number.isSafeInteger(startedAt) && startedAt > GONE_MARGIN_MS && age <= FLOW_MS && age >= -GONE_MARGIN_MS;
};

/**
 * Trades the code for a long-lived token, lists the ad accounts and keeps the connection, sealed.
 *
 * Meta's notice that the person removed the app or asked for their data to be deleted (forgetMetaUser) may land at
 * any moment of this flow, between its calls to Meta. So the connection is kept only in one step with a check of
 * that person's deletion mark: a deletion confirmed at or after the flow began (`startedAt`, from beginMeta, less
 * GONE_MARGIN_MS for the clocks of two servers) keeps nothing, gives the token back to Meta and says so ("removed").
 * The flow's start, not the consent on Meta's page, is the line, because the consent's own moment is not known
 * here: a deletion between the two is taken as the later word. A flow begun after the deletion (by more than the
 * margin) is the person's new choice and connects. A flow older than FLOW_MS keeps nothing ("expired"), so the
 * mark, kept GONE_SECONDS, outlasts every flow it has to stop.
 */
export async function finishMeta(input: {
  statsId: string;
  sid: string;
  code: string;
  redirect: string;
  by: string;
  owner: { email: string; handle: string };
  currency: string;
  /** When the consent flow began (beginMeta), in milliseconds. */
  startedAt: number;
}): Promise<MetaConnectResult> {
  if (!canSeal()) return { ok: false, error: "seal" };
  if (!flowFresh(input.startedAt)) return { ok: false, error: "expired" };
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
    if (!(await grantStillUsed(user, input.statsId))) await call("DELETE", "/me/permissions", {}, token).catch(() => ({}));
    return { ok: false, error: "permission" };
  }
  const listed = await call("GET", "/me/adaccounts", { fields: "account_id,name,currency,account_status", limit: "50" }, token);
  const raw = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
  const accounts = raw
    .filter((a) => typeof a.id === "string" && /^act_\d{1,30}$/.test(a.id) && typeof a.currency === "string")
    .map((a) => ({ id: String(a.id), name: String(a.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80), currency: String(a.currency).toLowerCase(), active: Number(a.account_status) === 1 }));
  if (!user || !accounts.length) {
    if (!(await grantStillUsed(user, input.statsId))) await call("DELETE", "/me/permissions", {}, token).catch(() => ({}));
    return { ok: false, error: "accounts" };
  }
  // The connection it replaces read exactly (CX-123 rule 24): an unknown reply throws before anything is written, so
  // a connection it could not read is never overwritten with the old person's token kept and the old account's lines
  // counted under the new one. Only a confirmed nil is "nothing to replace".
  const before = await exactConnection(input.statsId);
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
  if (!flowFresh(input.startedAt)) {
    // Given back only when no other store still uses that login, as on every other way this flow ends unkept.
    if (!(await grantStillUsed(user, input.statsId))) await call("DELETE", "/me/permissions", {}, token).catch(() => ({}));
    return { ok: false, error: "expired" };
  }
  const keys = [connKey(input.statsId), readKey(input.statsId), STORES_KEY, userKey(user), goneKey(user)];
  const replies = repliesFor(await redisPipeline([["EVAL", FINISH_UNLESS_GONE, keys.length, ...keys, JSON.stringify(connection), input.startedAt - GONE_MARGIN_MS, input.statsId]]), 1);
  const kept = replies ? countOf(replies[0]) : null;
  if (kept !== 0 && kept !== 1) throw new UnknownReplyError("keeping a Meta connection only while its user was not deleted since");
  if (kept === 0) {
    // Deleted since the flow began: nothing is kept, and the permission this flow was holding goes back to Meta.
    await call("DELETE", "/me/permissions", {}, token).catch(() => ({}));
    return { ok: false, error: "removed" };
  }
  // Due now: the daily pass's mark no longer holds (readMetaDue). Moved on once the connection is kept, never before,
  // so a pass that reads the new generation already finds the store.
  // Its reply confirmed too (CX-123 rule 24; main's exact write, Claude 6 on #3069): a count, or it throws before anything
  // of the old connection is given back, unlisted or deleted (merged with main of 15 November 2026, Claude 1 cloud O).
  const bumped = repliesFor(await redisPipeline([["INCR", GEN_KEY]]), 1);
  if (!bumped || countOf(bumped[0]) === null) throw new UnknownReplyError("a Meta connection written");
  // Another person's token in its place: theirs is given back, unless another store still uses that login.
  if (before && before.user !== user) {
    await redisPipeline([["SREM", userKey(before.user), input.statsId]]).catch(() => {});
    if (!(await grantStillUsed(before.user, input.statsId))) await giveBack(input.statsId, before).catch(() => {});
  }
  // Lines of an account no longer read go.
  if (before && before.account !== connection.account) confirmDeleted(await redisPipeline([["DEL", linesKey(input.statsId)]]), 1, "the lines of an account no longer read");
  const view = (await metaView(input.statsId, input.currency)) as MetaAdsView;
  return { ok: true, view, account: view.account };
}

/**
 * Chooses which of the connected person's ad accounts is read. Read exactly (CX-123 rule 24): false only when the
 * store is confirmed not connected or the id is not one of its accounts; an unknown reply, a record with an account
 * out of shape (rewriting it would drop that account) or a write not answered in its shape throws, so the Meta route
 * answers 503, never "not one of your accounts" nor "chosen" unseen.
 */
export async function chooseAccount(statsId: string, id: unknown): Promise<boolean> {
  if (!isRedisConfigured() || typeof id !== "string") return false;
  const read = await exactConnectionAsSeen(statsId, true);
  if (!read) return false;
  const { c, seen } = read;
  if (!c.accounts.some((a) => a.id === id)) return false;
  if (c.account === id) return true;
  // Only onto the connection read: one forgotten in between is not written back with the account chosen. A reply in
  // another shape throws (writeIfConnected), never "chosen" unseen.
  if (!(await writeIfConnected(statsId, seen, connKey(statsId), JSON.stringify({ ...c, account: id }), 0, [readKey(statsId), linesKey(statsId)]))) return false;
  // Due now: the daily pass's mark no longer holds (readMetaDue). Its reply confirmed too (CX-123 rule 24).
  const bumped = repliesFor(await redisPipeline([["INCR", GEN_KEY]]), 1);
  if (!bumped || countOf(bumped[0]) === null) throw new UnknownReplyError("a Meta ad account chosen");
  return true;
}

async function giveBack(statsId: string, c: Connection): Promise<void> {
  const open = unseal(c.token, context(statsId));
  if (open.ok) await call("DELETE", "/me/permissions", {}, open.value);
}

/**
 * Whether a store other than `statsId` is still connected with this Meta login (issue #4011, ALL-160).
 * DELETE /me/permissions ends the login's whole grant to the app, so it would cut that store off at Meta.
 * Read exactly (CX-123 rule 24): an index or connection that cannot be read counts as still used, so the
 * grant is kept: one store's action never breaks another store's working connection, and a kept grant costs
 * nothing. One pipeline reads at most META_FORGET_PASS stores; with more, the rest count as still used.
 */
async function grantStillUsed(user: string, statsId: string): Promise<boolean> {
  if (!user || !isRedisConfigured()) return false;
  try {
    const listed = stringList(repliesFor(await redisPipeline([["SMEMBERS", userKey(user)]]), 1)?.[0]);
    if (!listed) return true;
    const others = listed.filter((id) => id !== statsId);
    if (!others.length) return false;
    if (others.length > META_FORGET_PASS) return true;
    const read = repliesFor(await redisPipeline(others.map((id) => ["GET", connKey(id)])), others.length);
    if (!read) return true;
    return read.some((raw) => {
      if (raw === null) return false;
      const c = parseConnection(raw);
      return !c || c.user === user;
    });
  } catch {
    return true;
  }
}

/**
 * What disconnecting did: the account that was read, and whether Meta's permission was given back
 * ("removed") or kept because another store still uses that Meta login ("kept").
 */
export type MetaDisconnected = { account: MetaAccount | null; metaAccess: "removed" | "kept" };

/**
 * Disconnects: forgets the connection and every line read, then gives the permission back to Meta,
 * unless another store is still connected with the same Meta login (issue #4011, ALL-160).
 */
export async function disconnectMeta(statsId: string): Promise<MetaDisconnected | false> {
  // Redis not configured is not "not connected" (Codex U on #2924): the route would say "disconnected" with the
  // sealed token, the connection and its lines still stored, so it is unknown and the studio is told it failed.
  if (!isRedisConfigured()) throw new UnknownReplyError("a Meta connection: Redis is not configured");
  // Read exactly (Claude 5 on #2924, rule 24): false only when the store is confirmed not connected; an unknown
  // reply, or a deletion not answered in its shape, throws, so the studio is told it could not be done, never
  // "disconnected" with the connection, its token and its lines still kept.
  const c = await exactConnection(statsId);
  if (!c) return false;
  // Forgotten here whatever Meta says: a give-back that fails must not keep a connection the creator ended.
  // Forgotten first, so of two stores on one login disconnecting at once, the later one sees neither and gives it back.
  confirmDeleted(await forget(statsId, c.user), 5, "a Meta connection's deletion");
  const account = c.accounts.find((a) => a.id === c.account) ?? null;
  if (await grantStillUsed(c.user, statsId)) return { account, metaAccess: "kept" };
  await giveBack(statsId, c).catch((error) => console.error("giving the Meta permission back failed", error));
  return { account, metaAccess: "removed" };
}

/** Forgets one store's connection and what was read from it; answers the deletion's own replies. */
async function forget(statsId: string, user: string): Promise<unknown[]> {
  return redisPipeline([
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
  return signedNotice(raw)?.user ?? null;
}

/** How far ahead of this server's clock a notice's issued_at may be. */
const NOTICE_AHEAD_MS = 10 * 60_000;
/** Clock room between Meta and this server when a notice is set against a connection's time. */
export const NOTICE_SKEW_MS = 60_000;

/**
 * A signed_request from Meta whose signature is the app's: the user, and when Meta issued it (ms). A notice
 * without an integer issued_at, or issued well in the future, is refused. An old one is still believed, so
 * Meta asking again after a 503 still deletes, but it reaches only connections made before it (forgetMetaUser's
 * cutoff): one seen once and sent again later never disconnects a store connected since (#4585).
 */
export function signedNotice(raw: unknown): { user: string; issuedAt: number } | null {
  const secret = appSecret();
  if (!secret || typeof raw !== "string" || raw.length > 4096) return null;
  const [sig, payload] = raw.split(".");
  if (!sig || !payload) return null;
  const made = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  // Node's decoder skips characters outside the alphabet, reads "+" and "/" and ignores "=", so a garbled
  // signature could decode to the right bytes: only its exact canonical base64url is one (input fuzz, Claude 7).
  if (given.toString("base64url") !== sig) return null;
  if (given.length !== made.length || !timingSafeEqual(given, made)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { algorithm?: string; user_id?: unknown; issued_at?: unknown };
    if (String(data.algorithm).toUpperCase() !== "HMAC-SHA256") return null;
    const user = typeof data.user_id === "string" || typeof data.user_id === "number" ? String(data.user_id) : "";
    const issued = data.issued_at;
    if (typeof issued !== "number" || !Number.isSafeInteger(issued) || issued <= 0) return null;
    const issuedAt = issued * 1000;
    if (issuedAt > Date.now() + NOTICE_AHEAD_MS) return null;
    return /^\d{1,30}$/.test(user) ? { user, issuedAt } : null;
  } catch {
    return null;
  }
}

/** Every reply of one deletion pipeline confirmed by its own count, or UnknownReplyError: never taken as done unseen. */
function confirmDeleted(replies: unknown, commands: number, what: string): void {
  const answered = repliesFor(replies, commands);
  if (!answered || answered.some((reply) => countOf(reply) === null)) throw new UnknownReplyError(what);
}

/**
 * One store's connection read exactly (CX-123 rule 24): null only when it is confirmed absent; an unknown reply throws.
 * With `whole`, a record with any account or field out of shape throws too (parseConnection); disconnecting and
 * forgetting read without it, so a damaged account list never stops a connection being ended.
 */
async function exactConnection(statsId: string, whole = false): Promise<Connection | null> {
  return (await exactConnectionAsSeen(statsId, whole))?.c ?? null;
}

/**
 * Forgets every store a Meta user connected. Returns, for each, who to tell.
 *
 * Read exactly (CX-123 rule 24): the user's stores, each connection and each
 * deletion. An unknown reply throws before the user's index is deleted, so
 * the callback answers 503 without a confirmation code
 * (app/api/integrations/meta/deauthorize) and Meta asks again; nothing the
 * user connected is left without a way to find it.
 *
 * One pass walks at most META_FORGET_PASS stores, from a random place in id
 * order, wrapping around. With more, the stores of this pass leave the index and the pass is not answered as done, so the next
 * callback walks the rest; the index goes only once every store was walked
 * (Codex H2 on #2869). A pass that stops throws MetaIncompleteForget with the
 * stores it already forgot, so their owners are still told (Claude 5 on #2869).
 *
 * First, in the same pipeline as the read of their stores, it marks the user
 * as deleted now (goneKey, kept GONE_SECONDS), so a consent flow still on its
 * way (finishMeta) keeps nothing: one that wrote before the mark is in the
 * stores read here and forgotten with them, one that writes after it is
 * refused. A mark that is not confirmed written is unknown (UnknownReplyError),
 * never a deletion said to be done.
 */
export async function forgetMetaUser(
  user: string,
  cutoff = Number.POSITIVE_INFINITY,
  /** Where in the user's stores, in id order, this pass starts; a random place by default (Claude 7 on #4647). */
  start?: number,
): Promise<{ statsId: string; owner: { email: string; handle: string } }[]> {
  if (!isRedisConfigured() || !user) return [];
  // A store this user connected after the notice (cutoff, ms) is theirs again: kept, and kept in the index.
  const kept: string[] = [];
  const read = repliesFor(await redisPipeline([["SET", goneKey(user), String(Date.now()), "EX", GONE_SECONDS], ["SMEMBERS", userKey(user)]]), 2);
  if (!read || read[0] !== "OK") throw new UnknownReplyError("the mark of a Meta user's deletion");
  const stores = stringList(read[1]);
  if (!stores) throw new UnknownReplyError("the stores a Meta user connected");
  const forgot: { statsId: string; owner: { email: string; handle: string } }[] = [];
  // A store kept (connected after the notice) stays in the index, so a pass that always took the same first
  // META_FORGET_PASS stores could meet only kept ones and never reach an older store behind them: the deletion would
  // never finish. Each pass starts at a random place in id order and wraps around, so every store left is reached by
  // some pass (Claude 7 on #4647). With no more than one pass's worth, the start does not matter: every store is walked.
  const ordered = [...stores].sort();
  const from = ordered.length > META_FORGET_PASS ? (start ?? randomInt(ordered.length)) % ordered.length : 0;
  const pass = [...ordered.slice(from), ...ordered.slice(0, from)].slice(0, META_FORGET_PASS);
  try {
    for (const statsId of pass) {
      const c = await exactConnection(statsId);
      if (!c || c.user !== user) continue;
      if (c.connectedAt > cutoff) {
        kept.push(statsId);
        continue;
      }
      confirmDeleted(await forget(statsId, user), 5, "a Meta connection's deletion");
      forgot.push({ statsId, owner: c.owner });
    }
    const walked = pass.filter((statsId) => !kept.includes(statsId));
    if (stores.length > pass.length) {
      if (walked.length) confirmDeleted(await redisPipeline([["SREM", userKey(user), ...walked]]), 1, "a Meta user's walked stores");
      throw new MetaIncompleteForget(forgot, "more stores than one pass walks; the next callback walks the rest");
    }
    if (kept.length) {
      if (walked.length) confirmDeleted(await redisPipeline([["SREM", userKey(user), ...walked]]), 1, "a Meta user's walked stores");
    } else confirmDeleted(await redisPipeline([["DEL", userKey(user)]]), 1, "a Meta user's index deletion");
  } catch (error) {
    throw error instanceof MetaIncompleteForget ? error : new MetaIncompleteForget(forgot, error);
  }
  return forgot;
}

/** The most stores one Meta deletion callback walks; with more, the next callback walks the rest. */
export const META_FORGET_PASS = 50;

/** A Meta deletion pass that did not finish; `forgot` holds the stores it did forget, whose owners are told now. */
export class MetaIncompleteForget extends Error {
  constructor(
    readonly forgot: { statsId: string; owner: { email: string; handle: string } }[],
    cause: unknown,
  ) {
    super("a Meta deletion pass did not finish", { cause });
    this.name = "MetaIncompleteForget";
  }
}

// ---- Reading what was spent ------------------------------------------------------------

/** What a read did: read, nothing to read yet, or why it stopped. */
export type ReadResult = "read" | "none" | "currency" | "busy" | "error" | "broken" | "paused";

/** Hook for telling the owner once that the connection broke. */
export type MetaBrokenHook = (owner: { email: string; handle: string }) => Promise<void>;

/**
 * Marks that very connection broken and tells the owner once. Read exactly (CX-123 rule 24): only a confirmed nil, a
 * newer connection or one already marked is left as it is; an unknown reply, or a mark not answered "OK", throws
 * before the owner is told, so a connection is never said broken without the mark kept, nor left healthy by guess.
 */
async function markBroken(statsId: string, c: Connection, why: string, onBroken?: MetaBrokenHook): Promise<void> {
  const read = await exactConnectionAsSeen(statsId, true);
  if (!read || read.c.connectedAt !== c.connectedAt || read.c.broken) return;
  // Only onto the connection read: one forgotten in between is not written back, and its owner is not told. A reply in
  // another shape throws (writeIfConnected) before the owner is told.
  if (!(await writeIfConnected(statsId, read.seen, connKey(statsId), JSON.stringify({ ...read.c, broken: why }), 0))) return;
  await onBroken?.(read.c.owner).catch(() => {});
}

/**
 * Reads the last 30 days of the chosen account, campaign by campaign, day by
 * day and platform by platform, and keeps them as lines. Only when the
 * account's currency is the store's.
 */
export async function readMetaSpend(statsId: string, storeCurrency: string, now = Date.now(), onBroken?: MetaBrokenHook): Promise<ReadResult> {
  if (!isMetaConfigured() || !isRedisConfigured()) return "none";
  // Read exactly (CX-123 rule 24): "none" only for a confirmed nil or no account chosen yet. An unknown reply, a record
  // out of shape, or a chosen account not among the kept ones throws before Meta is asked, never "not connected", a
  // chosen account dropped, or a connection taken as healthy because why it broke could not be read.
  const found = await exactConnectionAsSeen(statsId, true);
  if (!found || found.c.broken || !found.c.account) return found?.c.broken ? "broken" : "none";
  // Everything this read writes is held to the connection exactly as read here (writeIfConnected).
  const { c, seen } = found;
  const account = c.accounts.find((a) => a.id === c.account);
  if (!account) throw new UnknownReplyError("a Meta connection's chosen ad account");
  // Resolve the connection's own current store, including calls made by the
  // daily job or account picker, before a read lock or any provider request.
  const store = await storeForId(c.sid);
  if (!store || store.statsId !== statsId) return "none";
  // 232 [CA1] 4b3: no read while the plan's renewal is unpaid or its payment disputed
  // (lib/integration-pause.ts); the daily pass counts it skipped and tries the next day.
  if (costsPaused(store)) return "paused";
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return "busy";
  // The reading lock read exactly (lib/claim-mark.ts; CX-123 rule 24): another read's is "busy". An unknown one asks
  // Meta nothing this time ("busy", tried again later) and is let go only while it holds this read's value.
  const reading = claimValue();
  const claimed = await claimMark(readingKey(statsId), 90, reading);
  if (claimed === "taken") return "busy";
  if (claimed !== "ours") {
    await releaseMark(readingKey(statsId), reading);
    return "busy";
  }
  const window = readWindow(now);
  const note = async (read: Partial<MetaRead>) => {
    // The last read: a reply in another shape is unknown. A kept record that does not parse is replaced, as it always
    // was: what it held is only the figures of an earlier read, and keeping it would stop every later note.
    const beforeReply = repliesFor(await redisPipeline([["GET", readKey(statsId)]]), 1);
    if (!beforeReply) throw new UnknownReplyError("Meta's last read");
    // Only a whole earlier read's figures are carried over (Claude 6 on #3070): one whose figures do not read is replaced
    // by "not read yet" (no day, so the studio shows no amount), never kept under its day with an amount never read.
    const before = parseRead(beforeReply[0]) ?? NOT_READ;
    const next: MetaRead = { ...before, problem: "", after: 0, ...read };
    // Written only while that very connection is still there, in one step with that check; a reply in another shape
    // throws (writeIfConnected), never taken as noted.
    return writeIfConnected(statsId, seen, readKey(statsId), JSON.stringify(next), KEEP_SECONDS);
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
      // Every page names its rows, each in Meta's shape; anything else is not a read, and nothing kept is replaced.
      if (!Array.isArray(answer.data) || !answer.data.every(insightRow)) throw new MetaError("busy", "Meta's ad spend came back in a shape that could not be read");
      for (const row of answer.data as InsightRow[]) rows.push(row);
      // Meta's next page carries the token and every parameter itself; it is followed only on Meta's own host. No
      // `next` is the last page; a `paging` or `next` out of shape is not known (review of Codex G on #2681).
      const paging = answer.paging;
      if (paging !== undefined && (paging === null || typeof paging !== "object" || Array.isArray(paging))) throw new MetaError("busy", "Meta's next page could not be read");
      const link = (paging as { next?: unknown } | undefined)?.next;
      if (link !== undefined && (typeof link !== "string" || !sameHost(link))) throw new MetaError("busy", "Meta's next page could not be read");
      next = link ?? null;
      params = {};
    }
    // More pages than one read takes: a part is not the whole, so nothing kept is replaced.
    if (next) throw new MetaTooBig();
    const fresh = linesFrom(rows, account.currency);
    // Every cent Meta said was spent must be in the lines kept: a row the lines left out (a day or an amount out of
    // range) would show a cost lower than Meta's, so the read is not taken.
    const said = rows.reduce((sum, row) => sum + minorUnits(row.spend, account.currency), 0);
    if (!Number.isSafeInteger(said) || said !== fresh.reduce((sum, line) => sum + line.cents, 0)) throw new MetaError("busy", "Meta's ad spend did not add up");
    // The kept lines read exactly (Claude 6 on #2924): nil is none kept; any other shape, a member included, is not
    // read, so the write below never replaces the older lines with the fresh window alone.
    const keptReply = repliesFor(await redisPipeline([["GET", linesKey(statsId)]]), 1);
    const kept = !keptReply ? null : keptReply[0] === null ? [] : parseLines(keptReply[0]);
    if (!kept) throw new UnknownReplyError("the Meta ad spend lines kept");
    const merged = mergeLines(kept, fresh, window.from, window.to);
    // Kept only while that very connection is still there, in one step with that check. An unknown reply is an error
    // tried again (writeIfConnected throws), never "none" (rule 24).
    if (!(await writeIfConnected(statsId, seen, linesKey(statsId), JSON.stringify(merged), KEEP_SECONDS))) return "none";
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
    // Too big for one read: looked at again the next day, as a currency that differs is, not every hour.
    const after = error instanceof MetaTooBig ? Math.floor(Date.parse(`${window.to}T00:00:00Z`) / 1000) + 86_400 : Math.floor(now / 1000) + (busy ? 3600 : 6 * 3600);
    await note({ problem: error instanceof MetaTooBig ? "big" : busy ? "busy" : "error", after }).catch(() => false);
    return busy ? "busy" : "error";
  } finally {
    // Only this read's own lock: one that ran out may be the next read's now.
    await releaseMark(readingKey(statsId), reading);
  }
}

/** One row of the insights asked for: its campaign, its day, its platform and a spend Meta wrote as a decimal. */
function insightRow(row: unknown): boolean {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  const r = row as Record<string, unknown>;
  return typeof r.spend === "string" && /^\d{1,15}(\.\d{1,6})?$/.test(r.spend) &&
    typeof r.date_start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date_start) &&
    (r.campaign_name === undefined || typeof r.campaign_name === "string") &&
    (r.publisher_platform === undefined || typeof r.publisher_platform === "string");
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
 * The daily pass's mark (C1 cost audit, 12 November 2026): a run that walked
 * every connected store and found none due keeps PASS_KEY, holding the
 * generation it read, until the first moment one can be due again (the next
 * UTC day, or the earliest wait out of a problem). Each five-minute run before
 * then reads only the mark and the generation, one command, instead of two
 * keys of every connected store (1 + 2M commands, 288 runs a day, for a read
 * owed once a day). Whatever makes a store due before then moves GEN_KEY on in
 * the same write (a new connection, another account chosen), so the next run
 * no longer finds its mark and walks. A run that did not see every store
 * exactly (out of time, a reply it could not read, a store it could not look
 * up) or asked Meta for anything leaves no mark: the next run walks, as before.
 */
/**
 * The daily pass, a few stores at a time, from the five-minute job: every
 * connected store not yet read today, and not waiting out a problem. A store
 * whose plan's costs are paused is tried again the next day.
 */
export async function readMetaDue(
  deadline: number,
  storeFor: (sid: string) => Promise<{ statsId: string | null; currency: string; email: string; handle: string } | null>,
  onBroken?: MetaBrokenHook,
): Promise<{ read: number; skipped: number }> {
  const counts = { read: 0, skipped: 0 };
  if (!isMetaConfigured() || !isRedisConfigured()) return counts;
  // The mark and the generation, read together: only the exact same generation skips the walk; anything else walks.
  const marks = repliesFor(await redisPipeline([["MGET", PASS_KEY, GEN_KEY]]), 1)?.[0];
  const pair = Array.isArray(marks) && marks.length === 2 ? marks : null;
  const generation = pair && (pair[1] === null || (typeof pair[1] === "string" && /^\d{1,20}$/.test(pair[1]))) ? (pair[1] ?? "0") : null;
  if (generation !== null && pair?.[0] === generation) return counts;
  // Read exactly (CX-123 rule 24): an unknown list throws, so the daily job says it failed and the next run reads it.
  const stores = stringList(repliesFor(await redisPipeline([["SMEMBERS", STORES_KEY]]), 1)?.[0]);
  if (!stores) throw new UnknownReplyError("the stores with Meta connected");
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  // The next UTC day, when every store read today is due again.
  let wake = Date.parse(`${today}T00:00:00Z`) + 86_400_000;
  let whole = generation !== null;
  let paused = false;
  let seen = 0;
  for (const statsId of stores) {
    if (Date.now() >= deadline) break;
    seen += 1;
    const replies = repliesFor(await redisPipeline([["GET", connKey(statsId)], ["GET", readKey(statsId)]]), 2);
    // Only a connection confirmed absent takes the store off the list; one that cannot be read is skipped this time.
    if (replies && replies[0] === null) {
      await redisPipeline([["SREM", STORES_KEY, statsId]]);
      continue;
    }
    // In the shape readMetaSpend reads (whole), so a record it would refuse is skipped here, not tried every run.
    const c = replies ? parseConnection(replies[0], true) : null;
    if (!replies || !c) {
      counts.skipped += 1;
      whole = false;
      continue;
    }
    const read = parseRead(replies[1]);
    if (c.broken || !c.account || read?.day === today) continue;
    if ((read?.after ?? 0) * 1000 > Date.now()) {
      wake = Math.min(wake, (read?.after ?? 0) * 1000);
      continue;
    }
    const store = await storeFor(c.sid).catch(() => null);
    if (!store || store.statsId !== statsId) {
      counts.skipped += 1;
      whole = false;
      continue;
    }
    // One store's connection that cannot be read just now is skipped this time (rule 24), never the whole pass.
    const result = await readMetaSpend(statsId, store.currency, Date.now(), onBroken).catch((error: unknown) => {
      if (error instanceof UnknownReplyError) return "skipped" as const;
      throw error;
    });
    if (result === "read") counts.read += 1;
    else counts.skipped += 1;
    // Paused (lib/integration-pause.ts): tried again the next day. Anything else asked of this pass is looked at
    // again by the next run, which finds what it wrote and only then may leave the mark.
    if (result !== "paused") whole = false;
    else paused = true;
  }
  if (whole && seen === stores.length) {
    // A paused store starts again on its own once its payment is recorded, and nothing moves GEN_KEY then: with one
    // paused, the mark lasts at most PAUSED_PASS_SECONDS, so it is read within the hour, not the next day.
    const seconds = Math.min(paused ? PAUSED_PASS_SECONDS : Infinity, Math.max(1, Math.ceil((wake - Date.now()) / 1000)));
    await redisPipeline([["SET", PASS_KEY, generation as string, "EX", seconds]]);
  }
  return counts;
}
