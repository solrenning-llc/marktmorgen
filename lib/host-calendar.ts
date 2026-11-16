/**
 * Each team host's own calendar, both ways: their busy times read in, their
 * team bookings written out.
 *
 * A host picks where their busy times come from, once, for every store they
 * host on (it is theirs, not a store's, like their claims, lib/host-claims.ts):
 *
 *   - "google": their own Google Calendar, connected by them with OAuth
 *     (lib/meet-connect.ts, a connection of their own beside the store's).
 *     Busy times are read with Google's free/busy query from the calendars
 *     they tick, never what the events are; team bookings they host are
 *     written as events with a Google Meet link on the one calendar they
 *     choose, moved when the buyer moves and deleted on a full refund
 *     (lib/meet-links.ts). Only offered once the deployment has the extra
 *     scopes on its Google consent screen (hostSyncOn);
 *   - "ics": the private iCal address of any calendar, read the way the
 *     store's own calendars are (lib/calendar-sync.ts readFeed). The fallback
 *     when Google sync is not switched on, or for Outlook and iCloud;
 *   - "none": nothing is read. Only their Marktmorgen bookings block them.
 *
 * Each reading is kept, and asked again only after SYNC_SECONDS, by one
 * request at a time per host, and only when somebody is looking at a booking
 * page or the host presses Check now. A reading older than STALE_SECONDS, or
 * a calendar that cannot be read at all, blocks that host and only that
 * host: their times are not offered, while the other hosts' still are, and
 * the studio says what went wrong and when the last good reading was.
 *
 *   nl:hostcal:cfg:<host id>    { email, source, read, write, ics (sealed), icsAddedAt }
 *   nl:hostcal:good:<host id>   the last successful reading { at, busy, source }, seven days
 *   nl:hostcal:err:<host id>    the last failure { at, message }, seven days
 *   nl:hostcal:lock:<host id>   one reading at a time, twenty seconds
 *
 * Changing any of it takes a signed-in session of that very person on a
 * store they are on (app/api/store/host-calendar), never a store's owner.
 */
import { CALENDAR_LIST_PAUSED, integrationPauseWord } from "@/lib/integration-pause";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import type { Busy } from "@/lib/call-setup";
import { readFeed, providerOf } from "@/lib/calendar-sync";
import { checkUrl, problemWords as fetchProblemWords, SafeFetchError } from "@/lib/safe-fetch";
import { canSeal, seal, unseal } from "@/lib/secret-box";
import { NotConnected, accessFor, disconnectFor, hostConnectionFrom, hostConnectionKey, hostConnectionView } from "@/lib/meet-connect";
import { type GoogleCalendar, MAX_READ_CALENDARS, ProviderError, googleCalendars, googleFreeBusy, grantedParts, hostSyncOn } from "@/lib/meet-providers";
import { HOST_STALE_MINUTES, HOST_SYNC_MINUTES } from "@/lib/team-scheduling-rules";
import { hostId } from "@/lib/host-claims";
import type { Store } from "@/lib/store";

/**
 * How long a reading is used before the calendar is asked again: fifteen
 * minutes since 17 October 2026 (five before). Each reading of each host is
 * part of every plan's worst month (tests/plan-cost-registry.ts); a time a
 * host's calendar filled in the meantime is still never booked twice through
 * us, because every hold is claimed on each host's own list (lib/host-claims.ts).
 */
export const SYNC_SECONDS = HOST_SYNC_MINUTES * 60;
/** How old the last good reading may be before the host is blocked: three readings missed. */
export const STALE_SECONDS = HOST_STALE_MINUTES * 60;
/** How far ahead busy times are read: past the longest booking horizon. */
export const HOST_LOOKAHEAD_DAYS = 92;
/** How long the last reading and the last failure are kept, for the studio. */
const KEEP_SECONDS = 7 * 86_400;
export const MAX_ICS_URL = 1000;

export type HostSource = "google" | "ics" | "none";

type Config = { email: string; source: HostSource; read: string[]; write: string; ics: string; icsAddedAt: string };
type Good = { at: number; busy: [number, number][]; source: HostSource };

const cfgKey = (host: string) => `nl:hostcal:cfg:${host}`;
const goodKey = (host: string) => `nl:hostcal:good:${host}`;
const errKey = (host: string) => `nl:hostcal:err:${host}`;
const lockKey = (host: string) => `nl:hostcal:lock:${host}`;
/** Every key a host's calendar keeps, by the host: for a store that closes, when it was the host's last (lib/closed-store-data.ts). */
export const hostCalendarKeys = (host: string): string[] => [cfgKey(host), goodKey(host), errKey(host), lockKey(host)];
const icsContext = (host: string) => `hostcal|${host}|ics`;

const unreadable = () => new Error("the hosts' calendars could not be read");

/** Only an explicit null proves that a stored value is absent. */
function storedValues(raw: unknown, count: number): (string | null)[] {
  if (!Array.isArray(raw) || raw.length !== count) throw unreadable();
  const values: (string | null)[] = [];
  for (let i = 0; i < count; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!slot || !("value" in slot) || (slot.value !== null && typeof slot.value !== "string")) throw unreadable();
    values.push(slot.value);
  }
  return values;
}

function storedReply(reply: unknown, count: number): (string | null)[] {
  if (!Array.isArray(reply) || reply.length !== 1) throw unreadable();
  const slot = Object.getOwnPropertyDescriptor(reply, "0");
  if (!slot || !("value" in slot)) throw unreadable();
  return storedValues(slot.value, count);
}

function parseConfig(raw: unknown): Config | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw unreadable();
  try {
    const v = JSON.parse(raw) as Partial<Config>;
    if (!v || (v.source !== "google" && v.source !== "ics" && v.source !== "none") ||
      typeof v.email !== "string" || !Array.isArray(v.read) || v.read.length > MAX_READ_CALENDARS ||
      !v.read.every((id) => typeof id === "string" && id.length > 0 && id.length <= 300) ||
      typeof v.write !== "string" || v.write.length > 300 || typeof v.ics !== "string" || typeof v.icsAddedAt !== "string") throw unreadable();
    return {
      email: v.email, source: v.source, read: v.read, write: v.write, ics: v.ics, icsAddedAt: v.icsAddedAt,
    };
  } catch {
    throw unreadable();
  }
}

function parseGood(raw: unknown): Good | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw unreadable();
  try {
    const v = JSON.parse(raw) as Good;
    if (!v || !Number.isSafeInteger(v.at) || v.at < 0 || (v.source !== "google" && v.source !== "ics") ||
      !Array.isArray(v.busy) || !v.busy.every((pair) => Array.isArray(pair) && pair.length === 2 &&
        Number.isSafeInteger(pair[0]) && Number.isSafeInteger(pair[1]) && pair[1] > pair[0])) throw unreadable();
    return v;
  } catch {
    throw unreadable();
  }
}

function parseError(raw: unknown): { at: number; message: string } | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw unreadable();
  try {
    const v = JSON.parse(raw) as { at?: unknown; message?: unknown };
    if (!v || typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at < 0 || typeof v.message !== "string") throw unreadable();
    return { at: v.at, message: v.message };
  } catch {
    throw unreadable();
  }
}

async function readConfig(host: string): Promise<Config | null> {
  const [raw] = storedValues(await redisPipeline([["GET", cfgKey(host)]]), 1);
  return parseConfig(raw);
}

/**
 * Writes a host's settings, only when Redis answers "OK" (CX-123 rule 24): any other reply leaves the write
 * unknown, so it throws, and the route says it failed rather than that an address was forgotten.
 */
async function writeConfig(host: string, config: Config): Promise<void> {
  const [saved] = repliesFor(await redisPipeline([["SET", cfgKey(host), JSON.stringify(config)]]), 1) ?? [];
  if (saved !== "OK") throw new UnknownReplyError("a host's calendar settings write");
}

/** Forgets a host's last reading and last failure, only on a count Redis answered for it. */
async function forgetReadings(host: string): Promise<void> {
  const [gone] = repliesFor(await redisPipeline([["DEL", goodKey(host), errKey(host)]]), 1) ?? [];
  if (countOf(gone) === null) throw new UnknownReplyError("forgetting a host's calendar readings");
}

function emptyConfig(email: string): Config {
  return { email: email.toLowerCase(), source: "none", read: [], write: "", ics: "", icsAddedAt: "" };
}

/**
 * Where a host's busy times stand: "none" (nothing read), "ok" (a reading
 * young enough), "stale" (the last good reading is too old), "failed" (it
 * could not be read), "scope" (Google was connected without the permission
 * to read free/busy), "off" (Google sync is not switched on here).
 */
export type SyncState = "none" | "ok" | "stale" | "failed" | "scope" | "off";

export type HostSync = {
  source: HostSource;
  state: SyncState;
  /** Whether none of this host's times may be offered right now. */
  blocked: boolean;
  busy: Busy[];
  /** When the last successful reading was made, in milliseconds; 0 for never. */
  lastSuccess: number;
  /** The last problem, in words for the studio; empty when there is none. */
  message: string;
};

export function isBlocking(state: SyncState): boolean {
  return state === "stale" || state === "failed" || state === "scope" || state === "off";
}

function result(source: HostSource, state: SyncState, good: Good | null, message = ""): HostSync {
  const usable = state === "ok" && good;
  return {
    source,
    state,
    blocked: isBlocking(state),
    busy: usable ? good.busy.map(([start, end]) => ({ start, end })) : [],
    lastSuccess: good?.at ?? 0,
    message,
  };
}

/** Test seams: a stand-in for the calendar feed fetch; production passes nothing. */
export type SyncHooks = { feed?: Parameters<typeof readFeed>[3] };

async function readBusyNow(statsId: string, host: string, config: Config, tz: string, now: number, hooks: SyncHooks): Promise<[number, number][]> {
  if (config.source === "google") {
    const access = await accessFor(statsId, "google", undefined, host);
    return googleFreeBusy(access.token, config.read, now - 86_400_000, now + HOST_LOOKAHEAD_DAYS * 86_400_000);
  }
  const opened = unseal(config.ics, icsContext(host));
  if (!opened.ok) throw new Error("The calendar address we kept cannot be read any more. Add it again.");
  const reading = await readFeed(opened.value, tz, now, hooks.feed ?? {});
  return reading.busy;
}

function syncWords(error: unknown): string {
  if (error instanceof NotConnected) return error.message;
  if (error instanceof ProviderError) {
    if (error.kind === "auth") return "Google Calendar needs connecting again.";
    if (error.kind === "scope") return "Google did not give permission to read your free/busy times. Connect again and allow it.";
    if (error.kind === "limit") return "Google asked us to slow down. Trying again in a few minutes.";
    return `Google Calendar could not be read: ${error.message.slice(0, 160)}`;
  }
  if (error instanceof SafeFetchError) return fetchProblemWords(error);
  return error instanceof Error ? error.message.slice(0, 300) : "Your calendar could not be read.";
}

/** What prefetchHosts read for one host: their settings, last reading, last failure and Google connection, as stored. */
export type HostPrefetch = { cfg: unknown; good: unknown; err: unknown; conn: unknown };

/**
 * Every host's kept state for a team call's page in one command (added 17
 * October 2026), instead of two for each host on every view: each view's
 * commands are part of every plan's worst month (tests/plan-cost-registry.ts).
 * Throws when it cannot be read, like the per-host reads it stands for.
 */
export async function prefetchHosts(store: Pick<Store, "statsId">, emails: string[]): Promise<Map<string, HostPrefetch>> {
  const out = new Map<string, HostPrefetch>();
  if (!store.statsId || !emails.length || !isRedisConfigured()) return out;
  const statsId = store.statsId;
  const keys = emails.flatMap((email) => {
    const host = hostId(email);
    return [cfgKey(host), goodKey(host), errKey(host), hostConnectionKey(statsId, host)];
  });
  const raw = storedReply(await redisPipeline([["MGET", ...keys]]), keys.length);
  emails.forEach((email, i) => out.set(email, { cfg: raw[4 * i], good: raw[4 * i + 1], err: raw[4 * i + 2], conn: raw[4 * i + 3] }));
  return out;
}

/**
 * A host's busy times for booking, reading their calendar again when the
 * last reading is older than SYNC_SECONDS (`refresh`), never throwing: what
 * cannot be known blocks the host.
 */
export async function hostSync(
  store: Pick<Store, "statsId">,
  email: string,
  tz: string,
  options: { now?: number; refresh?: boolean; force?: boolean; hooks?: SyncHooks; known?: HostPrefetch } = {},
): Promise<HostSync> {
  const now = options.now ?? Date.now();
  if (!store.statsId || !isRedisConfigured()) return result("none", "none", null);
  const host = hostId(email);
  let config: Config | null;
  let good: Good | null;
  let failure: { at: number; message: string } | null;
  try {
    // One command, not three: this runs for every host on every view of a team call's page
    // (tests/plan-cost-registry.ts, line team-scheduling).
    const [c, g, e] = options.known
      ? storedValues([options.known.cfg, options.known.good, options.known.err], 3)
      : storedReply(await redisPipeline([["MGET", cfgKey(host), goodKey(host), errKey(host)]]), 3);
    config = parseConfig(c);
    good = parseGood(g);
    failure = parseError(e);
    if (good && good.at > now) throw unreadable();
  } catch {
    // Not knowing whether a host has a calendar is not knowing whether they are free.
    return result("none", "failed", null, "Your calendar settings could not be read just now.");
  }
  if (!config || config.source === "none") return result("none", "none", null);
  const source = config.source;
  if (good && good.source !== source) good = null;
  if (source === "google") {
    if (!hostSyncOn()) return result(source, "off", good, "Google Calendar sync is not switched on for hosts yet. Add your calendar's private iCal address instead.");
    const conn = options.known ? hostConnectionFrom(options.known.conn) : await hostConnectionView(store.statsId, host).catch(() => null);
    if (!conn) return result(source, "failed", good, "Google Calendar is not connected.");
    if (conn.broken) return result(source, "failed", good, `Google Calendar needs connecting again: ${conn.broken}`);
    if (!grantedParts(conn.scope).freebusy) return result(source, "scope", good, "Google was connected without permission to see your free/busy times. Connect again and allow it.");
  } else if (!config.ics) {
    return result(source, "failed", null, "No calendar address is added.");
  }
  const age = good ? now - good.at : Number.POSITIVE_INFINITY;
  const lastWords = failure && (!good || failure.at >= good.at) ? failure.message : "";
  if (!options.force && age < SYNC_SECONDS * 1000) return result(source, "ok", good, lastWords);
  const fallback = () => (age < STALE_SECONDS * 1000 ? result(source, "ok", good, lastWords) : result(source, good ? "stale" : "failed", good, lastWords || "Your calendar has not been read recently enough."));
  if (!options.refresh && !options.force) return fallback();
  // Failed automatic reads share the same host-wide retry interval as good reads.
  // A kept failure must not turn each booking-page view into another provider call.
  if (!options.force && failure && Number.isFinite(failure.at) && failure.at <= now && now - failure.at < SYNC_SECONDS * 1000) return fallback();
  let mine: string | null;
  try {
    [mine] = storedValues(await redisPipeline([["SET", lockKey(host), "1", "NX", "EX", 20]]), 1);
  } catch {
    return fallback();
  }
  if (mine !== "OK") return fallback();
  try {
    const busy = await readBusyNow(store.statsId, host, config, tz, now, options.hooks ?? {});
    const reading: Good = { at: now, busy, source };
    await redisPipeline([
      ["SET", goodKey(host), JSON.stringify(reading), "EX", KEEP_SECONDS],
      ["DEL", errKey(host)],
    ]);
    return result(source, "ok", reading);
  } catch (error) {
    const message = syncWords(error);
    await redisPipeline([["SET", errKey(host), JSON.stringify({ at: now, message }), "EX", KEEP_SECONDS]]).catch(() => {});
    if (age < STALE_SECONDS * 1000) return result(source, "ok", good, message);
    return result(source, good ? "stale" : "failed", good, message);
  } finally {
    await redisPipeline([["DEL", lockKey(host)]]).catch(() => {});
  }
}

/** An explicit new studio refresh, separate from already owed booking refreshes. */
export async function checkHostCalendar(store: Store, email: string, tz: string): Promise<HostSync | null> {
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return null;
  return hostSync(store, email, tz, { force: true });
}

// ---- The host's own page -----------------------------------------------------

export type HostCalendarView = {
  email: string;
  source: HostSource;
  /** Whether hosts may connect Google Calendar here at all (hostSyncOn). */
  googleOffered: boolean;
  google: { account: string; connectedAt: number; broken: string; events: boolean; freebusy: boolean; calendars: boolean } | null;
  /** Their calendars, read live from Google, when connected with the permission to list them. */
  calendars: GoogleCalendar[] | null;
  calendarsError: string;
  read: string[];
  write: string;
  ics: { provider: string; addedAt: string } | null;
  sync: { state: SyncState; lastSuccess: number; message: string; blocked: boolean };
};

/** What a host's calendar page shows. Reads Google's calendar list when it may; never reads busy times. */
export async function hostCalendarView(store: Store, email: string, tz: string): Promise<HostCalendarView> {
  const host = hostId(email);
  const statsId = store.statsId ?? "";
  const config = (statsId ? await readConfig(host) : null) ?? emptyConfig(email);
  const conn = statsId ? await hostConnectionView(statsId, host).catch(() => null) : null;
  const parts = conn ? grantedParts(conn.scope) : null;
  let calendars: GoogleCalendar[] | null = null;
  let calendarsError = "";
  if (conn && !conn.broken && parts?.calendars && hostSyncOn()) {
    // 232 [CA1] 4b4a: Google's list is not read while the plan's costs are paused.
    if (integrationPauseWord(store)) {
      calendarsError = CALENDAR_LIST_PAUSED;
    } else if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) {
      calendarsError = "Calendar choices are temporarily unavailable. Try again later.";
    } else {
      try {
        const access = await accessFor(statsId, "google", undefined, host);
        calendars = await googleCalendars(access.token);
      } catch (error) {
        calendarsError = syncWords(error);
      }
    }
  }
  let ics: HostCalendarView["ics"] = null;
  if (config.ics) {
    const opened = unseal(config.ics, icsContext(host));
    ics = { provider: opened.ok ? providerOf(opened.value) : "Calendar", addedAt: config.icsAddedAt };
  }
  const sync = await hostSync(store, email, tz, { refresh: false });
  return {
    email: config.email || email.toLowerCase(),
    source: config.source,
    googleOffered: hostSyncOn(),
    google: conn
      ? { account: conn.account, connectedAt: conn.connectedAt, broken: conn.broken, events: parts?.events ?? false, freebusy: parts?.freebusy ?? false, calendars: parts?.calendars ?? false }
      : null,
    calendars,
    calendarsError,
    read: config.read,
    write: config.write,
    ics,
    sync: { state: sync.state, lastSuccess: sync.lastSuccess, message: sync.message, blocked: sync.blocked },
  };
}

/** What a busy-time source change can be refused for. */
export type HostChangeProblem = "google_off" | "google_none" | "ics_none" | "calendars" | "write" | "invalid" | "unavailable";

/** Picks where a host's busy times come from. A new source is read at the next look. */
export async function setHostSource(store: Store, email: string, source: HostSource): Promise<HostChangeProblem | null> {
  if (!store.statsId) return "invalid";
  const host = hostId(email);
  const config = (await readConfig(host)) ?? emptyConfig(email);
  if (source === "google") {
    if (!hostSyncOn()) return "google_off";
    if (!(await hostConnectionView(store.statsId, host).catch(() => null))) return "google_none";
  }
  if (source === "ics" && !config.ics) return "ics_none";
  if (source !== "none" && store.period?.funded === true && !(await reservePaidResourceWindow(store))) return "unavailable";
  await writeConfig(host, { ...config, email: email.toLowerCase(), source });
  return null;
}

/**
 * Picks which of the host's Google calendars are read for busy times (none
 * ticked reads the primary one) and which one bookings are written to, each
 * checked against the list Google gives now.
 */
export async function setHostCalendars(store: Store, email: string, read: string[], write: string): Promise<HostChangeProblem | null> {
  if (!store.statsId || !hostSyncOn()) return "google_off";
  const host = hostId(email);
  const conn = await hostConnectionView(store.statsId, host).catch(() => null);
  if (!conn || conn.broken) return "google_none";
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return "unavailable";
  let listed: GoogleCalendar[];
  try {
    const access = await accessFor(store.statsId, "google", undefined, host);
    listed = await googleCalendars(access.token);
  } catch {
    return "google_none";
  }
  const ids = new Set(listed.map((c) => c.id));
  const chosen = [...new Set(read)].slice(0, MAX_READ_CALENDARS + 1);
  if (chosen.length > MAX_READ_CALENDARS || chosen.some((id) => !ids.has(id))) return "calendars";
  if (write && !listed.some((c) => c.id === write && c.writable)) return "write";
  const config = (await readConfig(host)) ?? emptyConfig(email);
  await writeConfig(host, { ...config, email: email.toLowerCase(), read: chosen, write });
  // Read again at the next look, with the new choice.
  await redisPipeline([["DEL", goodKey(host)]]);
  return null;
}

export type AddIcsResult = { ok: true } | { ok: false; message: string };

/** Adds a host's private iCal address, after reading it once, sealed at rest, and makes it their source. */
export async function addHostIcs(store: Store, email: string, raw: string, tz: string, hooks: SyncHooks = {}, now = Date.now()): Promise<AddIcsResult> {
  if (!store.statsId) return { ok: false, message: "Open the studio once more and try again." };
  if (!canSeal()) return { ok: false, message: "Calendar addresses cannot be stored safely on this deployment yet, so nothing was added." };
  const text = raw.trim();
  if (text.length > MAX_ICS_URL) return { ok: false, message: "That address is longer than any calendar address we know of." };
  let url: string;
  try {
    url = checkUrl(text).toString();
  } catch (error) {
    return { ok: false, message: fetchProblemWords(error) };
  }
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return { ok: false, message: "Calendar changes are temporarily unavailable. Try again later." };
  let busy: [number, number][];
  try {
    busy = (await readFeed(url, tz, now, hooks.feed ?? {})).busy;
  } catch (error) {
    return { ok: false, message: syncWords(error) };
  }
  const host = hostId(email);
  const config = (await readConfig(host)) ?? emptyConfig(email);
  await writeConfig(host, {
    ...config,
    email: email.toLowerCase(),
    source: "ics",
    ics: seal(url, icsContext(host)),
    icsAddedAt: new Date(now).toISOString(),
  });
  const reading: Good = { at: now, busy, source: "ics" };
  await redisPipeline([
    ["SET", goodKey(host), JSON.stringify(reading), "EX", KEEP_SECONDS],
    ["DEL", errKey(host)],
  ]);
  return { ok: true };
}

/** Forgets a host's iCal address and what was read from it. */
export async function removeHostIcs(store: Pick<Store, "statsId">, email: string): Promise<void> {
  if (!store.statsId) return;
  const host = hostId(email);
  const config = await readConfig(host);
  if (!config) return;
  await writeConfig(host, { ...config, ics: "", icsAddedAt: "", source: config.source === "ics" ? "none" : config.source });
  await forgetReadings(host);
}

/**
 * Disconnects a host's own Google Calendar: access given back to Google, everything kept here forgotten.
 * True only when Google confirmed the give-back in this request. False when it did not, and when the
 * connection was already gone: a try that stopped below after forgetting it (its error answered as
 * "try again") leaves the retry nothing to ask Google, so the page says how to remove the access there
 * rather than that it was given back (G review 5815599962). The cleanup below still throws, so that
 * retry also finishes it.
 */
export async function disconnectHostGoogle(store: Pick<Store, "statsId">, email: string): Promise<boolean> {
  if (!store.statsId) return true;
  const host = hostId(email);
  const { providerAccessRemoved } = await disconnectFor(store.statsId, "google", host);
  const config = await readConfig(host);
  if (config) await writeConfig(host, { ...config, read: [], write: "", source: config.source === "google" ? "none" : config.source });
  await forgetReadings(host);
  return providerAccessRemoved;
}

/** Where a host's team bookings are written, when they connected Google Calendar for it: the calendar id ("" is primary). */
export async function hostWriteTarget(store: Pick<Store, "statsId">, email: string): Promise<{ host: string; calendar: string } | null> {
  if (!store.statsId || !hostSyncOn()) return null;
  const host = hostId(email);
  const [config, conn] = await Promise.all([readConfig(host), hostConnectionView(store.statsId, host)]);
  if (!config || config.source !== "google" || !conn || conn.broken || !grantedParts(conn.scope).events) return null;
  return { host, calendar: config.write };
}
