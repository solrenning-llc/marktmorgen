import type { NextRequest } from "next/server";
import { readListing } from "@/lib/catalog";
import { isCallProduct } from "@/lib/calls";
import { guardStoreWrite, text } from "@/lib/store-request";
import { jsonAccess } from "@/lib/studio-route";
import { hostSyncOn } from "@/lib/meet-providers";
import { hostSync } from "@/lib/host-calendar";
import { possibleHosts, readTeams, teamOrder, writeTeam } from "@/lib/team-booking";
import { type TeamSetup, parseTeamSetup, readTeamSetup, teamLimitsFor } from "@/lib/team-scheduling-rules";
import type { Store } from "@/lib/store";

/** Six hosts, each with a full week: well inside this. */
const MAX_BODY_BYTES = 20_000;

/** What the studio's team editor needs about one call: its team, who may host, the plan's numbers and each host's calendar. */
async function teamView(store: Store, productId: string) {
  const product = await readListing(store, productId);
  const teams = await readTeams(store);
  const raw = teams.get(productId);
  const team = product?.call && raw !== undefined ? parseTeamSetup(raw, product.call) : null;
  const limits = teamLimitsFor(store);
  const order = teamOrder(teams);
  const people = await possibleHosts(store);
  // Read as the studio last saw them, never asked of the calendars from here.
  const sync = team
    ? Object.fromEntries(
        await Promise.all(
          team.hosts.map(async (h) => {
            const s = await hostSync(store, h.email, h.tz, { refresh: false });
            return [h.email, { source: s.source, state: s.state, lastSuccess: s.lastSuccess, message: s.message, blocked: s.blocked }] as const;
          }),
        ),
      )
    : {};
  return {
    team,
    owner: store.email.toLowerCase(),
    people,
    limits,
    // Other team event types this store has, which count against the plan's number.
    others: order.filter((id) => id !== productId).length,
    // Whether this one is beyond what the plan allows now (the oldest are kept on).
    closed: team ? order.indexOf(productId) >= limits.eventTypes : false,
    googleSync: hostSyncOn(),
    sync,
  };
}

/**
 * A call's team (lib/team-booking.ts): `GET ?product=<id>` reads it for the
 * studio; `POST { id, team }` saves one, `{ id, team: null }` makes the call
 * an ordinary one again. Every host has to be the store's owner or on its
 * team now, and the plan's numbers (teamLimitsFor) are checked here, on the
 * server, whatever the studio showed.
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "products");
  if (access instanceof Response) return access;
  const id = (request.nextUrl.searchParams.get("product") ?? "").slice(0, 40);
  if (!id) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  try {
    return Response.json({ ok: true, ...(await teamView(access.store, id)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("reading a call's team failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const id = text(body.id, 40);
  if (!id || !("team" in body)) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  try {
    const product = await readListing(store, id);
    if (!product || !isCallProduct(product)) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
    if (!store.callsId) return Response.json({ ok: false, error: "team_call" }, { status: 400 });
    if (body.team === null) {
      await writeTeam(store, id, null);
      return Response.json({ ok: true, ...(await teamView(store, id)) });
    }
    // A call with several lengths (637 [GL5], lib/call-lengths.ts) is booked on one calendar: its hosts' times are read at one length.
    if (product.call.lengths?.length) return Response.json({ ok: false, error: "team_lengths" }, { status: 400 });
    const limits = teamLimitsFor(store);
    if (limits.eventTypes === 0) return Response.json({ ok: false, error: "team_plan" }, { status: 400 });
    const read = readTeamSetup(body.team, product.call, 6);
    if (typeof read === "string") return Response.json({ ok: false, error: read }, { status: 400 });
    if (read.hosts.length > limits.hosts) return Response.json({ ok: false, error: "team_plan_hosts", limit: limits.hosts }, { status: 400 });
    const allowed = new Set(await possibleHosts(store));
    if (read.hosts.some((h) => !allowed.has(h.email))) return Response.json({ ok: false, error: "team_not_member" }, { status: 400 });
    const teams = await readTeams(store);
    const before = teams.get(id);
    const existing = product.call && before !== undefined ? parseTeamSetup(before, product.call) : null;
    if (!existing && teamOrder(teams).filter((other) => other !== id).length >= limits.eventTypes) {
      return Response.json({ ok: false, error: "team_plan_types", limit: limits.eventTypes }, { status: 400 });
    }
    // A team keeps the day it was made, which decides which ones stay on if the plan later allows fewer.
    const team: TeamSetup = { ...read, createdAt: existing?.createdAt ?? new Date().toISOString() };
    await writeTeam(store, id, team);
    return Response.json({ ok: true, ...(await teamView(store, id)) });
  } catch (error) {
    console.error("saving a call's team failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
