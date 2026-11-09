/**
 * A store's own Google Calendar or Zoom account, connected with OAuth, so a
 * meeting can be made on it for every booking (lib/meet-links.ts).
 *
 * Both are off, and nothing about them is shown anywhere, until the owner of
 * the deployment sets the keys of the Google and Zoom apps
 * (lib/meet-providers.ts, isConfigured). Only the store's owner and Admins
 * connect or disconnect one ("settings", lib/team-roles.ts), and each change
 * is reported to the owner's inbox (lib/account-notice.ts).
 *
 * Connecting, step by step:
 *
 *   1. The studio posts to /api/integrations/<provider>/start. A state value
 *      (32 random bytes) and a PKCE verifier are made and kept here for ten
 *      minutes, bound to the signed-in session (by a hash of its cookie),
 *      the person, and the store and its role check; the person is sent to
 *      the provider's consent page with the state and the verifier's hash.
 *   2. The provider sends them back to the fixed callback address with a
 *      code and the state. The state is taken (GETDEL: once only), and it
 *      must have been made for this very session and person, who must still
 *      be allowed "settings" on that same store. Only then is the code traded
 *      for tokens, with the verifier, and the connection written.
 *
 * Tokens are sealed at rest with lib/secret-box.ts, bound to the store and
 * the provider, and never leave the server: the studio sees the account's
 * address, when it was connected, and whether it still works. An access
 * token is renewed from the refresh token a minute before it runs out, under
 * a lock, since Zoom hands out a new refresh token each time and the old one
 * stops working. Connecting, disconnecting and Zoom's uninstall notice take
 * the same lock, and a renewal writes only while it still holds it, so a
 * renewal that was under way can never bring back a connection that was
 * just ended, nor write an old account over a new one. A refresh the provider refuses (the creator withdrew access
 * in their Google or Zoom account, or the app was removed) marks the
 * connection broken: bookings fall back to the creator's own link or a
 * private room, the studio says so, and the owner is emailed once.
 *
 * Disconnecting gives the refresh token back to the provider (revoke), so
 * access ends on their side too, and deletes everything kept here. Meetings
 * already made stay in the creator's calendar and keep working.
 *
 *   nl:meet:conn:<statsId>:<provider>   the connection
 *   nl:meet:conn:hosts:google:h:<host id>   one team host's own Google
 *                                       Calendar (lib/host-calendar.ts): the
 *                                       same rules, connected by that person
 *                                       for themselves, with the scopes a
 *                                       host's sync needs (GOOGLE_HOST_SCOPES).
 *                                       It is the person's, not a store's: every
 *                                       store they host on uses the one connection,
 *                                       whatever `statsId` the caller passes.
 *   nl:meet:state:<hash>                one consent in progress, ten minutes
 *   nl:meet:user:<provider>:<hash>      the stores a Zoom user connected, for Zoom's uninstall notice
 *   nl:meet:gone:<provider>:<hash>      when Zoom last told us a user removed the app, a day: a consent
 *                                       flow begun before it keeps nothing (KEEP_UNLESS_GONE)
 *   nl:meet:log:<statsId>               the store's last problems, newest first
 */
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Held, LockBusyError, setIfHeld, withLock } from "@/lib/redis-lock";
import { canSeal, seal, unseal } from "@/lib/secret-box";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type MeetProvider, MEET_NAMES, isMeetProvider } from "@/lib/call-setup";
import {
  type Account,
  ProviderError,
  type Tokens,
  configuredProviders,
  offeredProviders,
  type OfferedTo,
  consentUrl,
  exchangeCode,
  isConfigured,
  pkcePair,
  lockWait,
  refreshTokens,
  revoke,
} from "@/lib/meet-providers";

/** What a provider is called in the studio: the account, not the meeting. */
export const ACCOUNT_NAMES: Record<MeetProvider, string> = { google: "Google Calendar", zoom: "Zoom" };
export { MEET_NAMES };

const STATE_SECONDS = 600;
/**
 * The longest a consent flow may run, from beginConsent to the write that keeps its connection: the state is taken
 * within STATE_SECONDS (takeConsent), and the calls to the provider after it are each bounded. A flow older than
 * this keeps nothing, so a deletion's mark, kept GONE_SECONDS, always outlasts every flow it has to stop.
 */
const FLOW_MS = 2 * STATE_SECONDS * 1000;
/** How long a deletion's mark is kept (forgetUser): far longer than any flow it has to stop (FLOW_MS). */
const GONE_SECONDS = 86_400;
/**
 * The room left for the clocks of two servers (the one that began the flow and the one Zoom's notice reached): a
 * flow is taken as begun before a deletion unless it began more than this after it. A reconnection begun within it
 * is refused, honestly ("removed"), and can simply be made again a few seconds later.
 */
const GONE_MARGIN_MS = 10_000;
const LOG_SIZE = 20;
const LOG_SECONDS = 30 * 86_400;

type Connection = {
  provider: MeetProvider;
  account: Account;
  /** Sealed. */
  access: string;
  expires: number;
  /** Sealed. */
  refresh: string;
  scope: string;
  connectedAt: number;
  /** Who connected it: their sign-in address. */
  by: string;
  /** The store's owner and address when it was connected, for a notice sent without the store at hand (Zoom's uninstall). */
  owner: { email: string; handle: string };
  /** Why it stopped working, in words; empty while it works. */
  broken: string;
  brokenAt: number;
};

/** A connection's place: the store's own (`host` empty), or one team host's own, shared by every store. */
const slot = (host: string) => (host ? `:h:${host}` : "");
const space = (statsId: string, host: string) => (host ? "hosts" : statsId);
const connKey = (statsId: string, provider: MeetProvider, host = "") => `nl:meet:conn:${space(statsId, host)}:${provider}${slot(host)}`;
/**
 * The test meeting a creator made to check a connection (lib/meet-test.ts): forgotten with the connection it was made
 * on, and written only by keepTest, so a deletion confirmed while one is being made or moved is never undone.
 */
export const testKey = (statsId: string, provider: MeetProvider) => `nl:meet:test:${statsId}:${provider}`;
const refreshLockKey = (statsId: string, provider: MeetProvider, host = "") => `nl:meet:refresh:${space(statsId, host)}:${provider}${slot(host)}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const stateKey = (state: string) => `nl:meet:state:${hash(`meet-state:${state}`)}`;
const userKey = (provider: MeetProvider, id: string) => `nl:meet:user:${provider}:${hash(`meet-user:${provider}:${id}`)}`;
/** When the provider last told us this account removed the app (forgetUser), a day: a consent flow begun before keeps nothing. */
const goneKey = (provider: MeetProvider, id: string) => `nl:meet:gone:${provider}:${hash(`meet-gone:${provider}:${id}`)}`;
const logKey = (statsId: string) => `nl:meet:log:${statsId}`;
const context = (statsId: string, provider: MeetProvider, part: "access" | "refresh", host = "") =>
  host ? `meet|hosts|${provider}|h:${host}|${part}` : `meet|${statsId}|${provider}|${part}`;

function parseConnection(raw: unknown, provider: MeetProvider): Connection | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Connection>;
    if (v.provider !== provider || !v.account || typeof v.account.id !== "string" || typeof v.refresh !== "string") return null;
    return {
      provider,
      account: { id: v.account.id, email: String(v.account.email ?? ""), name: String(v.account.name ?? "") },
      access: typeof v.access === "string" ? v.access : "",
      expires: Number(v.expires) || 0,
      refresh: v.refresh,
      scope: typeof v.scope === "string" ? v.scope : "",
      connectedAt: Number(v.connectedAt) || 0,
      by: typeof v.by === "string" ? v.by : "",
      owner: { email: String(v.owner?.email ?? ""), handle: String(v.owner?.handle ?? "") },
      broken: typeof v.broken === "string" ? v.broken : "",
      brokenAt: Number(v.brokenAt) || 0,
    };
  } catch {
    return null;
  }
}

async function readConnection(statsId: string, provider: MeetProvider, host = ""): Promise<Connection | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", connKey(statsId, provider, host)]]);
  return parseConnection(raw, provider);
}

/** A team host's own Google Calendar connection, as their studio page shows it, with what it was granted. */
export async function hostConnectionView(statsId: string, host: string): Promise<(ConnectionView & { scope: string }) | null> {
  const c = await readConnection(statsId, "google", host);
  return c ? { ...viewOf(c), scope: c.scope } : null;
}

/** Where a host's own Google connection is kept, so a team's page can read every host's in one command (lib/host-calendar.ts, prefetchHosts). */
export function hostConnectionKey(statsId: string, host: string): string {
  return connKey(statsId, "google", host);
}

/** The same view as hostConnectionView, from what was read at hostConnectionKey. */
export function hostConnectionFrom(raw: unknown): (ConnectionView & { scope: string }) | null {
  const c = parseConnection(raw, "google");
  return c ? { ...viewOf(c), scope: c.scope } : null;
}

// ---- What the studio shows ---------------------------------------------------

export type ConnectionView = {
  provider: MeetProvider;
  /** The address, or the name, of the account connected. */
  account: string;
  connectedAt: number;
  by: string;
  /** Why it stopped working; empty while it works. */
  broken: string;
};

/**
 * What disconnect answers for a connection that read as one: its view, and
 * `providerAccessRemoved: false` only when the provider did not confirm that
 * it took the access back (refused, failed, or no token opened). Absent when
 * it confirmed, so nothing changes then.
 */
export type DisconnectedView = ConnectionView & { providerAccessRemoved?: false };

/**
 * What a disconnect request found, for the routes: the view (null when none
 * read as one), and `providerAccessRemoved`, true only when the provider
 * confirmed the give-back in this very request. False when it did not, when a
 * damaged record held no access to give back, and when nothing was there: an
 * earlier try may have stopped after forgetting it here with its answer lost,
 * so whether the provider took it back can no longer be known, and is never
 * said (G review 5815599962).
 */
export type DisconnectOutcome = { view: DisconnectedView | null; providerAccessRemoved: boolean };

export type MeetProblem = { at: number; provider: MeetProvider; what: string; error: string };

export type MeetView = {
  /** Configured providers, or retained connections in the settings-only view. */
  providers: MeetProvider[];
  connected: Partial<Record<MeetProvider, ConnectionView>>;
  problems: MeetProblem[];
};

function viewOf(c: Connection): ConnectionView {
  return { provider: c.provider, account: c.account.email || c.account.name || "your account", connectedAt: c.connectedAt, by: c.by, broken: c.broken };
}

/** Which configured accounts can serve bookings. Disabled providers stay excluded. */
export async function meetView(statsId: string | null, sid?: OfferedTo, review = false): Promise<MeetView> {
  const configured = configuredProviders();
  const offered = sid === undefined ? configured : offeredProviders(sid, review);
  return readMeetingView(statsId, configured, offered);
}

/** Settings alone also show retained disabled connections, so consent can be
 * withdrawn. Never use this view to select a provider for new bookings. */
export async function meetSettingsView(statsId: string | null, sid: OfferedTo, review = false): Promise<MeetView> {
  return readMeetingView(statsId, ["google", "zoom"], offeredProviders(sid, review));
}

/** At most two connection reads and one bounded problem-list read. */
async function readMeetingView(statsId: string | null, candidates: MeetProvider[], offered: MeetProvider[]): Promise<MeetView> {
  if (!candidates.length || !statsId || !isRedisConfigured()) return { providers: offered, connected: {}, problems: [] };
  const replies = await redisPipeline([...candidates.map((p) => ["GET", connKey(statsId, p)]), ["LRANGE", logKey(statsId), 0, LOG_SIZE - 1]]);
  const connected: MeetView["connected"] = {};
  candidates.forEach((p, i) => {
    const c = parseConnection(replies[i], p);
    if (c) connected[p] = viewOf(c);
  });
  const providers = candidates.filter((p) => offered.includes(p) || connected[p]);
  const problems: MeetProblem[] = [];
  for (const raw of Array.isArray(replies[candidates.length]) ? (replies[candidates.length] as unknown[]) : []) {
    try {
      const v = JSON.parse(String(raw)) as MeetProblem;
      if (isMeetProvider(v.provider) && typeof v.what === "string" && typeof v.error === "string") problems.push(v);
    } catch {
      // Skipped.
    }
  }
  return { providers, connected, problems };
}

/** Which providers a store can have meetings made on right now: switched on, connected, working. */
export async function usableProviders(statsId: string | null): Promise<MeetProvider[]> {
  const view = await meetView(statsId);
  return view.providers.filter((p) => view.connected[p] && !view.connected[p]?.broken);
}

/** Writes down a problem for the studio's list. Never throws. */
export async function logProblem(statsId: string, provider: MeetProvider, what: string, error: string): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const entry: MeetProblem = { at: Date.now(), provider, what: what.slice(0, 200), error: error.slice(0, 300) };
  await redisPipeline([
    ["LPUSH", logKey(statsId), JSON.stringify(entry)],
    ["LTRIM", logKey(statsId), 0, LOG_SIZE - 1],
    ["EXPIRE", logKey(statsId), LOG_SECONDS],
  ]).catch(() => {});
}

// ---- Connecting --------------------------------------------------------------

type Pending = { provider: MeetProvider; statsId: string; sid: string; session: string; email: string; verifier: string; at: number; host?: string };

/**
 * Starts a consent: keeps the state and the verifier, bound to this session,
 * person and store, and says where to send the person.
 */
export async function beginConsent(
  provider: MeetProvider,
  input: { statsId: string; sid: string; sessionCookie: string; email: string; host?: string; scopes?: string[] },
): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const { verifier, challenge } = pkcePair();
  const pending: Pending = {
    provider,
    statsId: input.statsId,
    sid: input.sid,
    session: hash(`meet-session:${input.sessionCookie}`),
    email: input.email.toLowerCase(),
    verifier,
    at: Date.now(),
    ...(input.host ? { host: input.host } : {}),
  };
  await redisPipeline([["SET", stateKey(state), JSON.stringify(pending), "EX", STATE_SECONDS]]);
  return consentUrl(provider, state, challenge, input.scopes);
}

/**
 * Takes the consent a state names, once, if it was made for this session
 * and person and this provider. Null for anything else, and the state is
 * spent either way.
 */
export async function takeConsent(
  provider: MeetProvider,
  state: string,
  input: { sessionCookie: string; email: string },
): Promise<{ statsId: string; sid: string; verifier: string; host: string; at: number } | null> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(state) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GETDEL", stateKey(state)]]);
  if (typeof raw !== "string") return null;
  try {
    const p = JSON.parse(raw) as Pending;
    if (p.provider !== provider) return null;
    if (p.session !== hash(`meet-session:${input.sessionCookie}`)) return null;
    if (p.email !== input.email.toLowerCase()) return null;
    if (Date.now() - p.at > STATE_SECONDS * 1000) return null;
    if (!Number.isSafeInteger(p.at) || p.at <= 0) return null;
    return { statsId: p.statsId, sid: p.sid, verifier: p.verifier, host: typeof p.host === "string" && /^[0-9a-f]{24}$/.test(p.host) ? p.host : "", at: p.at };
  } catch {
    return null;
  }
}

export type ConnectResult =
  | { ok: true; view: ConnectionView; replaced: boolean }
  | { ok: false; error: "scope" | "refused" | "account" | "seal" | "expired" | "removed" };

/** Whether a flow begun at `startedAt` (milliseconds) is still young enough to keep its connection (FLOW_MS). */
const flowFresh = (startedAt: number): boolean => {
  const age = Date.now() - startedAt;
  return Number.isSafeInteger(startedAt) && startedAt > GONE_MARGIN_MS && age <= FLOW_MS && age >= -GONE_MARGIN_MS;
};

/**
 * Trades the code for tokens and keeps the connection, sealed.
 *
 * Zoom's notice that the person removed the app (forgetUser) may land at any moment of this flow. So a store's
 * connection is kept only in one step with a check of that account's deletion mark (KEEP_UNLESS_GONE): a deletion
 * confirmed at or after the flow began (`startedAt`, from beginConsent, less GONE_MARGIN_MS for the clocks of two
 * servers) keeps nothing, gives the access back and says so ("removed"). The flow's start, not the consent on the
 * provider's page, is the line, because the consent's own moment is not known here: a deletion between the two is
 * taken as the later word. A flow begun after the deletion (by more than the margin) is the person's new choice and
 * connects. A flow older than FLOW_MS keeps nothing ("expired"), so the mark, kept GONE_SECONDS, outlasts every
 * flow it has to stop.
 */
export async function finishConsent(
  provider: MeetProvider,
  input: {
    statsId: string;
    code: string;
    verifier: string;
    by: string;
    owner: { email: string; handle: string };
    host?: string;
    /** When the consent flow began (beginConsent; takeConsent's `at`), in milliseconds. */
    startedAt: number;
  },
): Promise<ConnectResult> {
  if (!canSeal()) return { ok: false, error: "seal" };
  if (!flowFresh(input.startedAt)) return { ok: false, error: "expired" };
  const traded = await exchangeCode(provider, input.code, input.verifier);
  if ("error" in traded) return { ok: false, error: traded.error };
  // Written under the renewal lock, so a renewal of the connection this
  // replaces cannot land over it a moment later.
  try {
    return await withLock(refreshLockKey(input.statsId, provider, input.host ?? ""), 20, 9_000, (held) => keepConnection(provider, input, traded, held));
  } catch (error) {
    // Not kept: what Google or Zoom just gave is given back rather than left
    // granted with nothing here that knows of it.
    if (error instanceof LockBusyError) {
      await revoke(provider, provider === "zoom" ? traded.tokens.access : traded.tokens.refresh).catch(() => {});
    }
    throw error;
  }
}

/**
 * KEYS[1] the renewal lock, KEYS[2] the store's connection, KEYS[3] the stores the provider account connected (its
 * index), KEYS[4] that account's deletion mark (forgetUser), KEYS[5] the index of the account whose connection this
 * one replaces, KEYS[6] the store's test meeting (testKey); ARGV[1] the lock's token, ARGV[2] the new connection,
 * ARGV[3] the cutoff: the time, in milliseconds, at or after which a deletion of that account stops this flow,
 * ARGV[4] the store, ARGV[5] "1" when the connection replaced is another account's, "0" otherwise. 1 the store is
 * indexed and the connection kept, and, when it replaces another account's, the store has left that account's index
 * and the test meeting made on it is forgotten, all in this one step; 0 the lock is no longer ours and nothing is
 * written; 2 a deletion at or after the cutoff (or a mark that does not read as a time) and nothing is written; -1 a
 * call of any other shape (a replaced account's index that is this account's own included), refused before anything
 * is read or written. The index is written before the connection, so an index Redis refuses (a key of another type)
 * stops the script before any connection is kept outside it; an old account's index Redis refuses stops it after the
 * new index only, with the old connection, its index and its test meeting as they were (an extra place in the new
 * account's index is harmless: forgetUser only forgets a connection of the account it is told about). Mirrored for
 * tests in lib/redis-memory.ts.
 */
const KEEP_UNLESS_GONE = `-- marktmorgen:meet-keep:v2
if #KEYS ~= 6 or #ARGV ~= 5 or ARGV[1] == "" or ARGV[2] == "" or #ARGV[3] > 16 or not string.match(ARGV[3], "^[1-9]%d*$") or ARGV[4] == "" or (ARGV[5] ~= "0" and ARGV[5] ~= "1") or (ARGV[5] == "1" and KEYS[5] == KEYS[3]) then return -1 end
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
local gone = redis.call("GET", KEYS[4])
if gone and (#gone > 16 or not string.match(gone, "^%d+$") or tonumber(gone) >= tonumber(ARGV[3])) then return 2 end
redis.call("SADD", KEYS[3], ARGV[4])
if ARGV[5] == "1" then
  redis.call("SREM", KEYS[5], ARGV[4])
  redis.call("DEL", KEYS[6])
end
redis.call("SET", KEYS[2], ARGV[2])
return 1`;

async function keepConnection(
  provider: MeetProvider,
  input: { statsId: string; by: string; owner: { email: string; handle: string }; host?: string; startedAt: number },
  traded: { tokens: Tokens; account: Account },
  held: Held,
): Promise<ConnectResult> {
  const host = input.host ?? "";
  const before = await readConnection(input.statsId, provider, host);
  const connection: Connection = {
    provider,
    account: traded.account,
    access: seal(traded.tokens.access, context(input.statsId, provider, "access", host)),
    expires: traded.tokens.expires,
    refresh: seal(traded.tokens.refresh, context(input.statsId, provider, "refresh", host)),
    scope: traded.tokens.scope,
    connectedAt: Date.now(),
    by: input.by,
    owner: input.owner,
    broken: "",
    brokenAt: 0,
  };
  if (host) {
    if (!(await setIfHeld(held, connKey(input.statsId, provider, host), JSON.stringify(connection)))) {
      throw new LockBusyError("the connection changed while it was saved");
    }
    // A host's own: nothing else here is keyed by it. A different account
    // connected in its place has its access given back.
    if (before && before.account.id !== traded.account.id) await giveBack(input.statsId, before, host).catch(() => {});
    return { ok: true, view: viewOf(connection), replaced: Boolean(before) };
  }
  // A store's own: kept and indexed in one step, and only while no deletion of that account was confirmed since the
  // flow began (KEEP_UNLESS_GONE). Before, the connection and its index were two writes and forgetUser read the index
  // between them, or before both, so a deletion confirmed to Zoom was undone by the write that followed.
  const access = provider === "zoom" ? traded.tokens.access : traded.tokens.refresh;
  if (!flowFresh(input.startedAt)) {
    await revoke(provider, access).catch(() => {});
    return { ok: false, error: "expired" };
  }
  // A different account connected in its place: the store leaves the old account's index and the test meeting made
  // on it is forgotten in the same step that keeps the new one (KEEP_UNLESS_GONE). Before, both were a pipeline after
  // the keep whose failure was swallowed: the old account's test meeting stayed under the new connection, to be given
  // back as its own and moved or deleted with its token, and the old index kept listing the store.
  const replaced = before && before.account.id !== traded.account.id ? before : null;
  const index = userKey(provider, traded.account.id);
  const keys = [
    held.key,
    connKey(input.statsId, provider),
    index,
    goneKey(provider, traded.account.id),
    replaced ? userKey(provider, replaced.account.id) : index,
    testKey(input.statsId, provider),
  ];
  const replies = repliesFor(
    await redisPipeline([
      ["EVAL", KEEP_UNLESS_GONE, keys.length, ...keys, held.token, JSON.stringify(connection), input.startedAt - GONE_MARGIN_MS, input.statsId, replaced ? "1" : "0"],
    ]),
    1,
  );
  const keptAs = replies ? countOf(replies[0]) : null;
  if (keptAs === 0) throw new LockBusyError("the connection changed while it was saved");
  if (keptAs === 2) {
    // Deleted since the flow began: nothing is kept, and the access this flow was holding goes back.
    await revoke(provider, access).catch(() => {});
    return { ok: false, error: "removed" };
  }
  if (keptAs !== 1) throw new UnknownReplyError("keeping a meeting connection only while its account was not deleted since");
  // A different account connected in its place: the old one's access is given back (its index and test meeting
  // already went with the keep above).
  if (replaced) await giveBack(input.statsId, replaced).catch(() => {});
  return { ok: true, view: viewOf(connection), replaced: Boolean(before) };
}

/**
 * KEYS[1] the store's connection, KEYS[2] the stores the account the test meeting was made on connected (its index),
 * KEYS[3] that account's deletion mark (forgetUser), KEYS[4] the test meeting's record (testKey); ARGV[1] the store,
 * ARGV[2] the record to keep, ARGV[3] the cutoff: the time, in milliseconds, at or after which a deletion of that
 * account stops this make or move, ARGV[4] the record as it was read ("" for none there). 1 the record is kept; 2 the
 * connection is gone, or no longer listed under that account, or that account was deleted at or after the cutoff (or
 * its mark does not read as a time), and nothing is written; 3 the record is no longer the one read (one made
 * meanwhile, or deleted or moved meanwhile), and nothing is written; -1 a call of any other shape, refused before
 * anything is read or written. Every deletion of a connection (disconnectFor, forgetUser) deletes it, its test meeting
 * and its place in the index in one pipeline, and a connection kept for another account leaves the old account's
 * index before its test meeting is deleted: whichever side of those commands this runs on, nothing it writes is left
 * after them. Mirrored for tests in lib/redis-memory.ts.
 */
const KEEP_TEST_UNLESS_GONE = `-- marktmorgen:meet-test-keep:v1
if #KEYS ~= 4 or #ARGV ~= 4 or ARGV[1] == "" or ARGV[2] == "" or #ARGV[3] > 16 or not string.match(ARGV[3], "^[1-9]%d*$") then return -1 end
if redis.call("EXISTS", KEYS[1]) ~= 1 or redis.call("SISMEMBER", KEYS[2], ARGV[1]) ~= 1 then return 2 end
local gone = redis.call("GET", KEYS[3])
if gone and (#gone > 16 or not string.match(gone, "^%d+$") or tonumber(gone) >= tonumber(ARGV[3])) then return 2 end
local had = redis.call("GET", KEYS[4])
if ARGV[4] == "" then
  if had then return 3 end
elseif had ~= ARGV[4] then return 3 end
redis.call("SET", KEYS[4], ARGV[2])
return 1`;

/**
 * What keepTest did: "kept"; "gone", the connection was deleted (or another account's connection took its place, or
 * the account was deleted) since the make or the move began, and nothing was written; "changed", the record is no
 * longer the one read, and nothing was written; "expired", the make or the move began longer ago than any can last
 * (FLOW_MS), and nothing was written; "unknown", a reply that is not one of the script's (CX-123 rule 24), never
 * taken as kept.
 */
export type TestKept = "kept" | "gone" | "changed" | "expired" | "unknown";

/**
 * Keeps a test meeting's record (lib/meet-test.ts makeTest, moveTest) in one step with the checks that the store's
 * connection is still the one it was made on (`account`, listed in that account's index) and that no deletion of that
 * account was confirmed since the make or the move began (`startedAt`, less GONE_MARGIN_MS, as finishConsent reads
 * forgetUser's mark), and only over the record as it was read (`had`, null for none there).
 */
export async function keepTest(
  statsId: string,
  provider: MeetProvider,
  input: { account: string; startedAt: number; value: string; had: string | null },
): Promise<TestKept> {
  if (!flowFresh(input.startedAt)) return "expired";
  const keys = [connKey(statsId, provider), userKey(provider, input.account), goneKey(provider, input.account), testKey(statsId, provider)];
  const replies = repliesFor(
    await redisPipeline([["EVAL", KEEP_TEST_UNLESS_GONE, keys.length, ...keys, statsId, input.value, input.startedAt - GONE_MARGIN_MS, input.had ?? ""]]),
    1,
  );
  const answer = replies ? countOf(replies[0]) : null;
  if (answer === 1) return "kept";
  if (answer === 2) return "gone";
  if (answer === 3) return "changed";
  return "unknown";
}

/**
 * The token that gives a connection's whole grant back, opened from its sealed
 * texts in their own context, or "" when none of them opens. Zoom takes back
 * the whole grant from its access token; Google from either, the refresh
 * token first.
 */
function grantToken(statsId: string, provider: MeetProvider, sealed: { refresh: unknown; access: unknown }, host = ""): string {
  const open = (part: "access" | "refresh") => {
    const text = sealed[part];
    if (typeof text !== "string" || !text) return "";
    const opened = unseal(text, context(statsId, provider, part, host));
    return opened.ok ? opened.value : "";
  };
  return provider === "zoom" ? open("access") : open("refresh") || open("access");
}

/** Gives a connection's grant back: true only when the provider confirmed it (lib/meet-providers.ts revoke). */
async function giveBack(statsId: string, c: Connection, host = ""): Promise<boolean> {
  const token = grantToken(statsId, c.provider, c, host);
  return token ? await revoke(c.provider, token) : false;
}

/**
 * What can still be given back from text kept as a connection that does not
 * read as one (damaged): the grant's token, if a sealed text in it still opens
 * in this connection's own context, and the account id it was listed under,
 * if one is still there.
 */
function salvage(raw: string, statsId: string, provider: MeetProvider, host: string): { token: string; accountId: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { token: "", accountId: "" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { token: "", accountId: "" };
  const v = value as { refresh?: unknown; access?: unknown; account?: unknown };
  const account = v.account && typeof v.account === "object" ? (v.account as { id?: unknown }).id : undefined;
  return { token: grantToken(statsId, provider, { refresh: v.refresh, access: v.access }, host), accountId: typeof account === "string" ? account : "" };
}

/** Each reply of a pipeline that deletes, confirmed by its own count (DEL, SREM), or UnknownReplyError: never taken as done unseen. */
function confirmCounts(replies: unknown, commands: number, what: string): void {
  const answered = repliesFor(replies, commands);
  if (!answered || answered.some((reply) => countOf(reply) === null)) throw new UnknownReplyError(what);
}

/**
 * Disconnects: gives the access back to the provider, then forgets it here.
 * Returns the account that was connected, or null when none was.
 *
 * Read exactly (CX-123 rule 24): null only for a confirmed none, the slot
 * answering null. A reply of another shape is unknown and throws, so the
 * creator is never told an account is gone while its tokens are still kept
 * (the route answers 500, "try again"). Text kept there that is not a
 * connection (damaged) is answered as null once it is gone: a token in it that
 * still opens is given back first, and the text is deleted only after the
 * provider confirmed it; a give-back that fails or is not confirmed keeps the
 * text and throws, so disconnecting can be tried again while the access may
 * still be live. Text with no token that opens is deleted at once, since the
 * creator asked to end it and nothing in it can be given back. Every deletion
 * is confirmed by its own count, or this throws.
 *
 * A connection that reads as one is forgotten here whatever the provider
 * answers, since the creator asked to end it; when the provider did not
 * confirm the give-back, the view says so (`providerAccessRemoved: false`),
 * for the studio and the email to tell the creator how to remove it at the
 * provider, never that it was removed (G review 5815300198, disposition A).
 */
export async function disconnect(statsId: string, provider: MeetProvider, host = ""): Promise<DisconnectedView | null> {
  return (await disconnectFor(statsId, provider, host)).view;
}

/** Disconnects as `disconnect` does, and says whether the provider confirmed the give-back in this request. */
export async function disconnectFor(statsId: string, provider: MeetProvider, host = ""): Promise<DisconnectOutcome> {
  // Under the renewal lock: a renewal under way finishes first, and none can
  // write the connection back after it is gone.
  return withLock(refreshLockKey(statsId, provider, host), 20, 9_000, async (): Promise<DisconnectOutcome> => {
    const read = repliesFor(await redisPipeline([["GET", connKey(statsId, provider, host)]]), 1);
    if (!read || (read[0] !== null && typeof read[0] !== "string")) throw new UnknownReplyError("a meeting connection");
    if (read[0] === null) return { view: null, providerAccessRemoved: false };
    const c = parseConnection(read[0], provider);
    if (!c) {
      const left = salvage(read[0], statsId, provider, host);
      if (left.token) {
        // Not forgotten until the provider confirmed the access is back: a
        // failed or unconfirmed revoke throws (ProviderError included) and
        // keeps the text, so a retry can still give it back.
        if (!(await revoke(provider, left.token))) throw new Error("a damaged meeting connection's access could not be given back");
      } else {
        console.error("a damaged meeting connection was deleted with no access in it that could be given back", provider, host ? "host" : "store");
      }
      const gone = host
        ? [["DEL", connKey(statsId, provider, host)]]
        : [
            ["DEL", connKey(statsId, provider)],
            ["DEL", testKey(statsId, provider)],
            ...(left.accountId ? [["SREM", userKey(provider, left.accountId), statsId]] : []),
          ];
      confirmCounts(await redisPipeline(gone), gone.length, "a meeting connection's deletion");
      return { view: null, providerAccessRemoved: Boolean(left.token) };
    }
    // Forgotten here whatever the provider says: a revoke that fails must not
    // leave a connection the creator asked to end. One the provider did not
    // confirm is said in the answer, never taken as given back.
    const removed = await giveBack(statsId, c, host).catch((error) => {
      console.error("giving a meeting connection back failed", error);
      return false;
    });
    if (!removed) console.error("a meeting connection was disconnected here without the provider confirming its access was given back", provider, host ? "host" : "store");
    const view: DisconnectedView = removed ? viewOf(c) : { ...viewOf(c), providerAccessRemoved: false };
    if (host) {
      confirmCounts(await redisPipeline([["DEL", connKey(statsId, provider, host)]]), 1, "a meeting connection's deletion");
      return { view, providerAccessRemoved: removed };
    }
    confirmCounts(
      await redisPipeline([
        ["DEL", connKey(statsId, provider)],
        ["DEL", testKey(statsId, provider)],
        ["SREM", userKey(provider, c.account.id), statsId],
      ]),
      3,
      "a meeting connection's deletion",
    );
    return { view, providerAccessRemoved: removed };
  });
}

/**
 * Zoom's notice that a user removed the app: every store that user connected
 * forgets the connection. Returns, for each store that did, who to tell.
 */
export async function forgetUser(
  provider: MeetProvider,
  accountId: string,
): Promise<{ statsId: string; owner: { email: string; handle: string }; account: string }[]> {
  if (!isRedisConfigured() || !accountId) return [];
  // The mark first, in the same pipeline as the read of the stores: a consent flow that kept its connection before
  // the mark is in the stores read here and forgotten with them; one that would keep it after is refused
  // (KEEP_UNLESS_GONE). A mark not confirmed written, or the stores in any shape but a list of text, is unknown.
  const read = repliesFor(
    await redisPipeline([
      ["SET", goneKey(provider, accountId), String(Date.now()), "EX", GONE_SECONDS],
      ["SMEMBERS", userKey(provider, accountId)],
    ]),
    2,
  );
  if (!read || read[0] !== "OK") throw new UnknownReplyError("the mark of a meeting account's deletion");
  const stores = stringList(read[1]);
  if (!stores) throw new UnknownReplyError("the stores a meeting account connected");
  const forgot: { statsId: string; owner: { email: string; handle: string }; account: string }[] = [];
  for (const statsId of stores.slice(0, 50)) {
    // Each store leaves the index under its renewal lock, with its connection: a store connected again since (a flow
    // begun after the mark, which keeps only holding this lock) keeps its place for the next notice to find. Before,
    // the whole index was deleted at the end, under any connection made meanwhile.
    const c = await withLock(refreshLockKey(statsId, provider), 20, 9_000, async () => {
      const found = await readConnection(statsId, provider);
      const unlist = ["SREM", userKey(provider, accountId), statsId];
      if (!found || found.account.id !== accountId) {
        confirmCounts(await redisPipeline([unlist]), 1, "a meeting account's store leaving its index");
        return null;
      }
      confirmCounts(await redisPipeline([["DEL", connKey(statsId, provider)], ["DEL", testKey(statsId, provider)], unlist]), 3, "a meeting connection's deletion");
      return found;
    });
    if (c) forgot.push({ statsId, owner: c.owner, account: viewOf(c).account });
  }
  return forgot;
}

// ---- Using a connection --------------------------------------------------------

export type Access = { token: string; account: string };

/** Why a connection cannot be used right now, in words for the studio. */
export class NotConnected extends Error {
  readonly broken: boolean;
  constructor(message: string, broken = false) {
    super(message);
    this.broken = broken;
  }
}

/** Marks the connection broken, only while the renewal lock is still ours (it is only called holding it). */
async function markBroken(held: Held, statsId: string, provider: MeetProvider, why: string, host = ""): Promise<boolean> {
  const c = await readConnection(statsId, provider, host);
  if (!c || c.broken) return false;
  return setIfHeld(held, connKey(statsId, provider, host), JSON.stringify({ ...c, broken: why, brokenAt: Date.now() }));
}

/** Hook for telling the owner once that a connection broke (set by the caller that knows the store). */
export type BrokenHook = (provider: MeetProvider) => Promise<void>;

/**
 * An access token for the store's connection, renewed when it is within a
 * minute of running out. Throws NotConnected when there is none that works.
 */
export async function accessFor(statsId: string, provider: MeetProvider, onBroken?: BrokenHook, host = ""): Promise<Access> {
  if (!isConfigured(provider)) throw new NotConnected(`${ACCOUNT_NAMES[provider]} is not switched on`);
  const c = await readConnection(statsId, provider, host);
  if (!c) throw new NotConnected(`${ACCOUNT_NAMES[provider]} is not connected`);
  if (c.broken) throw new NotConnected(`${ACCOUNT_NAMES[provider]} needs connecting again: ${c.broken}`, true);
  if (c.expires > Date.now() + 60_000) {
    const open = unseal(c.access, context(statsId, provider, "access", host));
    if (open.ok) return { token: open.value, account: c.account.id };
  }
  try {
    return await withLock(refreshLockKey(statsId, provider, host), 20, lockWait(9_000), async (held: Held) => {
      // Read again inside the lock: another request may have renewed it.
      const now = await readConnection(statsId, provider, host);
      if (!now || now.account.id !== c.account.id) throw new NotConnected(`${ACCOUNT_NAMES[provider]} is not connected`);
      if (now.broken) throw new NotConnected(`${ACCOUNT_NAMES[provider]} needs connecting again: ${now.broken}`, true);
      if (now.expires > Date.now() + 60_000) {
        const open = unseal(now.access, context(statsId, provider, "access", host));
        if (open.ok) return { token: open.value, account: now.account.id };
      }
      const refresh = unseal(now.refresh, context(statsId, provider, "refresh", host));
      if (!refresh.ok) {
        const why = refresh.reason === "other-key" ? "the key that protects it was changed" : "what we kept could not be read";
        if (await markBroken(held, statsId, provider, why, host)) await onBroken?.(provider).catch(() => {});
        throw new NotConnected(`${ACCOUNT_NAMES[provider]} needs connecting again: ${why}`, true);
      }
      let tokens: Tokens;
      try {
        tokens = await refreshTokens(provider, refresh.value);
      } catch (error) {
        if (error instanceof ProviderError && error.kind === "auth") {
          const why = `${ACCOUNT_NAMES[provider]} no longer lets us in (access was withdrawn or ran out)`;
          if (await markBroken(held, statsId, provider, why, host)) await onBroken?.(provider).catch(() => {});
          throw new NotConnected(`${ACCOUNT_NAMES[provider]} needs connecting again`, true);
        }
        throw error;
      }
      const next: Connection = {
        ...now,
        access: seal(tokens.access, context(statsId, provider, "access", host)),
        expires: tokens.expires,
        // Zoom's new refresh token replaces the old one, which stops working.
        refresh: tokens.refresh ? seal(tokens.refresh, context(statsId, provider, "refresh", host)) : now.refresh,
        scope: tokens.scope || now.scope,
      };
      if (!(await setIfHeld(held, connKey(statsId, provider, host), JSON.stringify(next)))) {
        throw new ProviderError("server", 0, "the connection changed while it was renewed");
      }
      return { token: tokens.access, account: now.account.id };
    });
  } catch (error) {
    if (error instanceof LockBusyError) throw new ProviderError("server", 0, "the connection was busy being renewed");
    throw error;
  }
}
