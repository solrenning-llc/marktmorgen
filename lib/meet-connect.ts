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
 *   nl:meet:log:<statsId>               the store's last problems, newest first
 */
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Held, LockBusyError, setIfHeld, withLock } from "@/lib/redis-lock";
import { canSeal, seal, unseal } from "@/lib/secret-box";
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
/** The test meeting a creator made to check a connection (lib/meet-test.ts): forgotten with the connection it was made on. */
export const testKey = (statsId: string, provider: MeetProvider) => `nl:meet:test:${statsId}:${provider}`;
const refreshLockKey = (statsId: string, provider: MeetProvider, host = "") => `nl:meet:refresh:${space(statsId, host)}:${provider}${slot(host)}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const stateKey = (state: string) => `nl:meet:state:${hash(`meet-state:${state}`)}`;
const userKey = (provider: MeetProvider, id: string) => `nl:meet:user:${provider}:${hash(`meet-user:${provider}:${id}`)}`;
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
): Promise<{ statsId: string; sid: string; verifier: string; host: string } | null> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(state) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GETDEL", stateKey(state)]]);
  if (typeof raw !== "string") return null;
  try {
    const p = JSON.parse(raw) as Pending;
    if (p.provider !== provider) return null;
    if (p.session !== hash(`meet-session:${input.sessionCookie}`)) return null;
    if (p.email !== input.email.toLowerCase()) return null;
    if (Date.now() - p.at > STATE_SECONDS * 1000) return null;
    return { statsId: p.statsId, sid: p.sid, verifier: p.verifier, host: typeof p.host === "string" && /^[0-9a-f]{24}$/.test(p.host) ? p.host : "" };
  } catch {
    return null;
  }
}

export type ConnectResult =
  | { ok: true; view: ConnectionView; replaced: boolean }
  | { ok: false; error: "scope" | "refused" | "account" | "seal" };

/** Trades the code for tokens and keeps the connection, sealed. */
export async function finishConsent(
  provider: MeetProvider,
  input: { statsId: string; code: string; verifier: string; by: string; owner: { email: string; handle: string }; host?: string },
): Promise<ConnectResult> {
  if (!canSeal()) return { ok: false, error: "seal" };
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

async function keepConnection(
  provider: MeetProvider,
  input: { statsId: string; by: string; owner: { email: string; handle: string }; host?: string },
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
  if (!(await setIfHeld(held, connKey(input.statsId, provider, host), JSON.stringify(connection)))) {
    throw new LockBusyError("the connection changed while it was saved");
  }
  if (host) {
    // A host's own: nothing else here is keyed by it. A different account
    // connected in its place has its access given back.
    if (before && before.account.id !== traded.account.id) await giveBack(input.statsId, before, host).catch(() => {});
    return { ok: true, view: viewOf(connection), replaced: Boolean(before) };
  }
  await redisPipeline([["SADD", userKey(provider, traded.account.id), input.statsId]]);
  // A different account connected in its place: the old one's access is given back.
  if (before && before.account.id !== traded.account.id) {
    await giveBack(input.statsId, before).catch(() => {});
    await redisPipeline([
      ["SREM", userKey(provider, before.account.id), input.statsId],
      ["DEL", testKey(input.statsId, provider)],
    ]).catch(() => {});
  }
  return { ok: true, view: viewOf(connection), replaced: Boolean(before) };
}

async function giveBack(statsId: string, c: Connection, host = ""): Promise<void> {
  const opened = unseal(c.refresh, context(statsId, c.provider, "refresh", host));
  // Zoom takes back the whole grant from its access token; Google from either.
  const access = unseal(c.access, context(statsId, c.provider, "access", host));
  const token = c.provider === "zoom" ? (access.ok ? access.value : "") : opened.ok ? opened.value : "";
  if (token) await revoke(c.provider, token);
}

/**
 * Disconnects: gives the access back to the provider, then forgets it here.
 * Returns the account that was connected, or null when none was.
 */
export async function disconnect(statsId: string, provider: MeetProvider, host = ""): Promise<ConnectionView | null> {
  // Under the renewal lock: a renewal under way finishes first, and none can
  // write the connection back after it is gone.
  return withLock(refreshLockKey(statsId, provider, host), 20, 9_000, async () => {
    const c = await readConnection(statsId, provider, host);
    if (!c) return null;
    // Forgotten here whatever the provider says: a revoke that fails must not
    // leave a connection the creator asked to end.
    await giveBack(statsId, c, host).catch((error) => console.error("giving a meeting connection back failed", error));
    if (host) {
      await redisPipeline([["DEL", connKey(statsId, provider, host)]]);
      return viewOf(c);
    }
    await redisPipeline([
      ["DEL", connKey(statsId, provider)],
      ["DEL", testKey(statsId, provider)],
      ["SREM", userKey(provider, c.account.id), statsId],
    ]);
    return viewOf(c);
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
  const [members] = await redisPipeline([["SMEMBERS", userKey(provider, accountId)]]);
  const stores = Array.isArray(members) ? (members as unknown[]).filter((m): m is string => typeof m === "string") : [];
  const forgot: { statsId: string; owner: { email: string; handle: string }; account: string }[] = [];
  for (const statsId of stores.slice(0, 50)) {
    const c = await withLock(refreshLockKey(statsId, provider), 20, 9_000, async () => {
      const found = await readConnection(statsId, provider);
      if (!found || found.account.id !== accountId) return null;
      await redisPipeline([["DEL", connKey(statsId, provider)], ["DEL", testKey(statsId, provider)]]);
      return found;
    });
    if (c) forgot.push({ statsId, owner: c.owner, account: viewOf(c).account });
  }
  await redisPipeline([["DEL", userKey(provider, accountId)]]);
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
