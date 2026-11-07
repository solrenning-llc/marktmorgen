/**
 * Booking a team event type (lib/team-scheduling-rules.ts): who is free,
 * who gets the booking, and taking their time.
 *
 * A team is kept beside the call it belongs to, one hash per store:
 *
 *   nl:callteam:<callsId>              product id -> TeamSetup, as JSON
 *   nl:callteam:rr:<callsId>:<product> host id -> bookings of it so far, for round robin
 *
 * It is only used while its product is a call with weekly hours and one seat
 * per time; a call changed to anything else is sold as it is, and its team
 * waits. Who may host is read every time: the store's owner and the people on
 * its team now (lib/team.ts), so somebody taken off the team stops being
 * offered at their very next booking. What the plan allows is read every time
 * too (teamLimitsFor): the oldest team event types, and the first hosts on
 * each, up to the plan's numbers; any beyond are closed for booking until the
 * plan allows them again.
 *
 * What a host is taken for comes from three places, all read for every
 * booking page and checked again under the store's lock before a time is
 * held: their claims on every store (lib/host-claims.ts), this store's paid
 * bookings that name them (Stripe is the ledger, so a buyer who paid and never
 * came back still counts) and, for the store's owner, every ordinary call of
 * the store, and their own calendar's busy times (lib/host-calendar.ts), which
 * block the host altogether when they cannot be read.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Busy, CallSetup } from "@/lib/call-setup";
import {
  type HostState,
  type TeamSetup,
  dayBounds,
  freeHosts,
  hostFree,
  hostRules,
  parseTeamSetup,
  roundRobinOrder,
  teamLimitsFor,
  teamSlots,
} from "@/lib/team-scheduling-rules";
import { type ClaimHost, CLAIM_MARGIN_MS, claimHosts, confirmClaim, hostId, readClaims, releaseClaim } from "@/lib/host-claims";
import { type HostPrefetch, type HostSync, hostSync, prefetchHosts } from "@/lib/host-calendar";
import { readTeam } from "@/lib/team";
import type { Listing, Store } from "@/lib/store";

const teamKey = (callsId: string) => `nl:callteam:${callsId}`;
const rrKey = (callsId: string, product: string) => `nl:callteam:rr:${callsId}:${product}`;

type CallListing = Listing & { call: CallSetup };

/** A booking or hold of this store, with the hosts and claim of a team booking. */
export type TeamBusy = Busy & { hosts?: string[]; claim?: string };

/** Every team kept for this store's calls, raw, by product. */
export async function readTeams(store: Pick<Store, "callsId">): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (!store.callsId) return out;
  const unreadable = () => new Error("The team booking configuration could not be read.");
  if (!isRedisConfigured()) throw unreadable();
  const reply = await redisPipeline([["HGETALL", teamKey(store.callsId)]]);
  if (!Array.isArray(reply) || reply.length !== 1) throw unreadable();
  const entry = Object.getOwnPropertyDescriptor(reply, "0");
  if (!entry || !Object.hasOwn(entry, "value") || !Array.isArray(entry.value) || entry.value.length % 2 !== 0) throw unreadable();
  const flat: unknown[] = entry.value;
  for (let i = 0; i < flat.length; i += 2) {
    const key = Object.getOwnPropertyDescriptor(flat, String(i));
    const value = Object.getOwnPropertyDescriptor(flat, String(i + 1));
    if (!key || !Object.hasOwn(key, "value") || typeof key.value !== "string" || !key.value || out.has(key.value) ||
      !value || !Object.hasOwn(value, "value") || typeof value.value !== "string") throw unreadable();
    try {
      out.set(key.value, JSON.parse(value.value));
    } catch {
      throw unreadable();
    }
  }
  return out;
}

export async function writeTeam(store: Pick<Store, "callsId">, productId: string, team: TeamSetup | null): Promise<void> {
  if (!store.callsId) return;
  await redisPipeline([team ? ["HSET", teamKey(store.callsId), productId, JSON.stringify(team)] : ["HDEL", teamKey(store.callsId), productId]]);
}

/** The order team event types are kept on in when a plan allows fewer: oldest first, then by product. */
export function teamOrder(teams: Map<string, unknown>): string[] {
  const at = (raw: unknown) => (raw && typeof raw === "object" && typeof (raw as { createdAt?: unknown }).createdAt === "string" ? (raw as { createdAt: string }).createdAt : "");
  return [...teams.entries()]
    .map(([id, raw]) => ({ id, at: at(raw) }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))
    .map((x) => x.id);
}

/** The owner and the people on the store's team now: who may host. */
export async function possibleHosts(store: Pick<Store, "email" | "sid">): Promise<string[]> {
  const owner = store.email.trim().toLowerCase();
  const team = store.sid ? await readTeam(store.sid) : { members: [] };
  return [owner, ...team.members.map((m) => m.email.toLowerCase()).filter((e) => e !== owner)];
}

/**
 * The team a call is booked with right now: null for an ordinary call,
 * "closed" for a team event type the plan or the team no longer allows.
 */
export async function activeTeam(store: Store, product: CallListing, nowSeconds = Date.now() / 1000): Promise<TeamSetup | null | "closed"> {
  if (!store.callsId || product.call.kind !== "weekly" || product.call.seats !== 1) return null;
  const teams = await readTeams(store);
  const raw = teams.get(product.id);
  if (raw === undefined) return null;
  const team = parseTeamSetup(raw, product.call);
  if (!team) return "closed";
  const limits = teamLimitsFor(store, nowSeconds);
  if (teamOrder(teams).indexOf(product.id) >= limits.eventTypes) return "closed";
  const allowed = new Set(await possibleHosts(store));
  const hosts = team.hosts.filter((h) => allowed.has(h.email)).slice(0, limits.hosts);
  if (!hosts.length) return "closed";
  if (team.mode === "collective" && hosts.length !== team.hosts.length) return "closed";
  return { ...team, hosts };
}

export type TeamContext = {
  team: TeamSetup;
  /** Each host's id (lib/host-claims.ts), by address. */
  ids: Map<string, string>;
  states: Map<string, HostState>;
  syncs: Map<string, HostSync>;
  /** Bookings of this event each host has had, and team calls each has coming up. */
  assigned: Record<string, number>;
  upcoming: Record<string, number>;
};

/**
 * What every host of a team is taken for right now. `busy` is everything this
 * store has booked or held (lib/calls.ts readBusy), `except` a booking being
 * moved, whose own time does not count against it. Throws when the hosts'
 * claims cannot be read: then no time can be shown as free.
 */
export async function teamContext(
  store: Store,
  product: CallListing,
  team: TeamSetup,
  busy: TeamBusy[],
  now: number,
  options: { refresh: boolean; except?: { session: string; claim: string } },
): Promise<TeamContext> {
  const owner = store.email.trim().toLowerCase();
  const ids = new Map(team.hosts.map((h) => [h.email, hostId(h.email)]));
  const claims = await readClaims([...ids.values()], now);
  const syncs = new Map<string, HostSync>();
  // Every host's kept state in one command (lib/host-calendar.ts, prefetchHosts); a host whose
  // state cannot be read is read on their own, and blocked if that fails too.
  const known = await prefetchHosts(store, team.hosts.map((h) => h.email)).catch(() => new Map<string, HostPrefetch>());
  await Promise.all(
    team.hosts.map(async (h) => {
      syncs.set(h.email, await hostSync(store, h.email, h.tz, { now, refresh: options.refresh, known: known.get(h.email) }));
    }),
  );
  const counts = store.callsId ? await redisPipeline([["HGETALL", rrKey(store.callsId, product.id)]]).catch(() => [[]]) : [[]];
  const flat = Array.isArray(counts[0]) ? (counts[0] as unknown[]).map(String) : [];
  const byId: Record<string, number> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) byId[flat[i]] = Number(flat[i + 1]) || 0;

  const states = new Map<string, HostState>();
  const assigned: Record<string, number> = {};
  const upcoming: Record<string, number> = {};
  const exceptClaim = options.except?.claim ?? "";
  const exceptSession = options.except?.session ?? "";
  for (const host of team.hosts) {
    const id = ids.get(host.email) as string;
    const mine = (claims.get(id) ?? []).filter((c) => c.claim !== exceptClaim);
    const seen = new Set(mine.map((c) => c.claim));
    const taken: Busy[] = mine.map((c) => ({ start: c.start, end: c.end }));
    const booked = mine.map((c) => c.start);
    for (const b of busy) {
      if (exceptSession && b.session === exceptSession) continue;
      if (b.claim && b.claim === exceptClaim) continue;
      if (b.hosts && b.hosts.length) {
        // This store's team bookings: the ledger's copy, for one whose claim ran out.
        if (!b.hosts.includes(id) || (b.claim && seen.has(b.claim))) continue;
        taken.push({ start: b.start, end: b.end });
        booked.push(b.start);
        if (b.claim) seen.add(b.claim);
      } else if (host.email === owner) {
        // The store's ordinary calls are its owner's.
        taken.push({ start: b.start, end: b.end });
      }
    }
    const sync = syncs.get(host.email);
    if (sync) taken.push(...sync.busy);
    states.set(host.email, { email: host.email, busy: taken, booked: [...new Set(booked)], blocked: Boolean(sync?.blocked) });
    assigned[host.email] = byId[id] ?? 0;
    upcoming[host.email] = booked.filter((s) => s > now).length;
  }
  return { team, ids, states, syncs, assigned, upcoming };
}

/** The times on offer for a team event type. */
export function teamDays(setup: CallSetup, ctx: TeamContext, now: number) {
  return teamSlots(setup, ctx.team, ctx.states, now);
}

/** The times a team booking may move to: every one its own hosts are all free for, but the one it has. */
export function teamMoveDays(setup: CallSetup, ctx: TeamContext, hosts: string[], current: number, now: number) {
  const mine = ctx.team.hosts.filter((h) => hosts.includes(ctx.ids.get(h.email) as string));
  if (!mine.length || mine.length !== hosts.length) return [];
  const only: TeamSetup = { ...ctx.team, mode: "collective", hosts: mine };
  return teamSlots(setup, only, ctx.states, now)
    .map((day) => ({ ...day, starts: day.starts.filter((s) => s !== current) }))
    .filter((day) => day.starts.length > 0);
}

function claimFor(setup: CallSetup, ctx: TeamContext, email: string, start: number): ClaimHost {
  const host = ctx.team.hosts.find((h) => h.email === email) as TeamSetup["hosts"][number];
  return { id: ctx.ids.get(email) as string, gapMs: hostRules(setup, host).gapMs, day: dayBounds(start, host.tz), cap: host.dailyCap };
}

export type TeamHold = { ok: true; claim: string; hosts: string[]; emails: string[] } | { ok: false; reason: "taken" | "error" };

/**
 * Takes the time for its host, or its hosts: for round robin, the free hosts
 * in round-robin order until one claim holds; for a collective call, every
 * host at once. The claim lasts as long as the checkout can be paid, and a
 * little more (CLAIM_MARGIN_MS).
 */
export async function holdTeam(input: {
  store: Store;
  product: CallListing;
  ctx: TeamContext;
  start: number;
  end: number;
  claim: string;
  holdMs: number;
  now: number;
}): Promise<TeamHold> {
  const { product, ctx, start, end, claim, now } = input;
  const setup = product.call;
  const free = freeHosts(setup, ctx.team, ctx.states, now, start);
  const ref = `${input.store.callsId}:${product.id}`;
  const until = now + input.holdMs + CLAIM_MARGIN_MS;
  const tries = ctx.team.mode === "collective" ? (free.length === ctx.team.hosts.length ? [free] : []) : roundRobinOrder(free, ctx.assigned, ctx.upcoming).map((e) => [e]);
  for (const emails of tries) {
    try {
      const taken = await claimHosts({ hosts: emails.map((e) => claimFor(setup, ctx, e, start)), start, end, claim, until, ref, now });
      if (taken.ok) return { ok: true, claim, hosts: emails.map((e) => ctx.ids.get(e) as string), emails };
      if (taken.reason === "invalid") return { ok: false, reason: "error" };
    } catch (error) {
      console.error("claiming a host's time failed", error);
      return { ok: false, reason: "error" };
    }
  }
  return { ok: false, reason: "taken" };
}

/** Moves a team booking's claim to its new time, on the same hosts, in one step. */
export async function moveTeamClaim(input: {
  store: Store;
  product: CallListing;
  ctx: TeamContext;
  hosts: string[];
  claim: string;
  start: number;
  end: number;
  now: number;
}): Promise<boolean> {
  const { product, ctx, hosts, start, end, now } = input;
  const setup = product.call;
  const emails = ctx.team.hosts.filter((h) => hosts.includes(ctx.ids.get(h.email) as string)).map((h) => h.email);
  if (emails.length !== hosts.length || !emails.length) return false;
  if (!emails.every((e) => hostFree(setup, ctx.team.hosts.find((h) => h.email === e) as TeamSetup["hosts"][number], ctx.states.get(e), now, start))) return false;
  const taken = await claimHosts({ hosts: emails.map((e) => claimFor(setup, ctx, e, start)), start, end, claim: input.claim, until: 0, ref: `${input.store.callsId}:${product.id}`, now });
  return taken.ok;
}

/** A team booking paid for: its claim stays, and it counts for round robin. */
export async function confirmTeam(store: Pick<Store, "callsId">, productId: string, hosts: string[], claim: string, start: number, end: number): Promise<void> {
  if (!store.callsId || !hosts.length) return;
  await confirmClaim(hosts, claim, start, end, `${store.callsId}:${productId}`);
  await redisPipeline(hosts.map((id) => ["HINCRBY", rrKey(store.callsId as string, productId), id, 1]));
}

export { releaseClaim };

/** The addresses of a booking's hosts, in the team's order, from their ids. */
export function hostEmails(team: TeamSetup | null, hosts: string[]): string[] {
  if (!team) return [];
  return team.hosts.filter((h) => hosts.includes(hostId(h.email))).map((h) => h.email);
}
