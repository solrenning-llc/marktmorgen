import type { NextRequest } from "next/server";
import { jsonAccess } from "@/lib/studio-route";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { hasProduct } from "@/lib/catalog";
import { storeKey } from "@/lib/learn";
import { createRole, isDiscordConfigured, leaveServer, serverRoles } from "@/lib/discord";
import { assignable, cleanRoles } from "@/lib/discord-rules";
import { forgetServer, readServerOrThrow, saveServer, setProductRoles } from "@/lib/discord-store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { logTeam } from "@/lib/team";
import { PERMISSION_WORDS } from "@/lib/team-roles";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";

const no = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

/**
 * What the studio changes about Discord access (lib/discord-rules.ts), for the
 * owner and Admins ("settings"):
 *
 *   { action: "roles", productId, roles }   the roles a product gives; none takes it off
 *   { action: "role", name }                a new role in the server, made by the bot
 *   { action: "kick", on }                  take people out of the server once their access ends
 *   { action: "disconnect" }                the bot leaves the server, and everything kept for it is forgotten
 *
 * A role is only ever one the bot can give, read from the server now. The
 * connected server read in another shape is not "no server": "unavailable"
 * (503), nothing changed. A disconnect forgets nothing until Discord confirmed
 * the bot left (lib/discord.ts, leaveServer); otherwise "server" (502), with
 * everything kept, so the creator can press again. When the bot left but the
 * people kept could not be read exactly (lib/discord-store.ts, forgetServer),
 * "not_finished" (503): nothing is forgotten, and pressing again finishes it.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return no("forbidden", 403);
  if (!isDiscordConfigured()) return no("off", 404);
  const access = await jsonAccess(request, "settings");
  if (access instanceof Response) return access;
  let body: Record<string, unknown>;
  try {
    body = (await (await limited(request, 4_000)).json()) as Record<string, unknown>;
  } catch {
    return no("invalid");
  }
  const { store, email, role } = access;
  const room = storeKey(store);
  let server: Awaited<ReturnType<typeof readServerOrThrow>>;
  try {
    server = await readServerOrThrow(room);
  } catch (error) {
    if (error instanceof UnknownReplyError) return no("unavailable", 503);
    console.error("reading the connected Discord server failed", error);
    return no("server_error", 500);
  }
  if (!server) return no("not_connected", 409);
  const log = async (what: string) => {
    if (role !== "owner" && store.sid) await logTeam(store.sid, { who: email, role, what: `${PERMISSION_WORDS.settings}: ${what}` });
  };

  try {
    if (body.action === "roles") {
      const productId = typeof body.productId === "string" ? body.productId.slice(0, 40) : "";
      if (!hasProduct(store, productId)) return no("unknown", 404);
      const wanted = cleanRoles(body.roles);
      if (wanted.length) {
        if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return no("unavailable", 503);
        const read = await serverRoles(server.id);
        if (!read) return no("server", 502);
        const allowed = new Set(assignable(read.roles, server.id, read.botTop).map((r) => r.id));
        if (wanted.some((id) => !allowed.has(id))) return no("role_out_of_reach");
      }
      const saved = await setProductRoles(room, productId, wanted);
      if (!saved.ok) return no(saved.reason);
      await log("changed the Discord roles of a product");
      return Response.json({ ok: true, roles: wanted });
    }
    if (body.action === "role") {
      const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 100) : "";
      if (!name) return no("name");
      if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return no("unavailable", 503);
      const made = await createRole(server.id, name);
      if (!made) return no("server", 502);
      await log(`made the Discord role ${name}`);
      return Response.json({ ok: true, role: made });
    }
    if (body.action === "kick") {
      await saveServer(room, { ...server, kick: body.on === true });
      await log(body.on === true ? "set Discord to remove people whose access ended" : "set Discord to keep people whose access ended");
      return Response.json({ ok: true });
    }
    if (body.action === "disconnect") {
      // The bot first: told "disconnected" only once Discord confirmed it left.
      if (!(await leaveServer(server.id))) return no("server", 502);
      let people: number;
      try {
        people = await forgetServer(room, store.sid);
      } catch (error) {
        // The bot left, but who was kept could not be read exactly: nothing was forgotten, so pressing again
        // (Discord then answers 404, read as "it is out") finishes it. Never "disconnected" with addresses kept.
        if (error instanceof UnknownReplyError) return no("not_finished", 503);
        throw error;
      }
      await log("disconnected Discord");
      return Response.json({ ok: true, people });
    }
    return no("invalid");
  } catch (error) {
    console.error("changing Discord access failed", error);
    return no("server_error", 500);
  }
}
