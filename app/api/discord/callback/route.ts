import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { type NextRequest, after } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { noticeCreator } from "@/lib/account-notice";
import { exchange, isDiscordConfigured, leaveServer, whoIs } from "@/lib/discord";
import { joinServer } from "@/lib/discord-access";
import type { DiscordServer } from "@/lib/discord-rules";
import { forgetServer, readServerOrThrow, saveServer, takeTrip } from "@/lib/discord-store";
import { storeKey } from "@/lib/learn";
import { UnknownReplyError } from "@/lib/redis-reply";
import { logTeam } from "@/lib/team";
import { PERMISSION_WORDS } from "@/lib/team-roles";
import { clientAddress, withinLimit } from "@/lib/request-guard";
import { originFrom } from "@/lib/request-origin";
import { storeForId } from "@/lib/store";
import { away, resolveAccess, studioPath } from "@/lib/studio-route";

const CODE = /^[A-Za-z0-9._~-]{1,512}$/;

/**
 * Where Discord's own page sends a person back (lib/discord.ts): a creator
 * who added the bot to a server, or a buyer who agreed to be put in one.
 * Reached by a top-level navigation from Discord, so not a same-site
 * request; the state, used once and for ten minutes, is what proves the trip
 * began here, and for a creator, the same signed-in person must be back.
 */
export async function GET(request: NextRequest) {
  if (!isDiscordConfigured()) return new Response("Not found.", { status: 404 });
  const origin = originFrom(request);
  if (!(await withinLimit("discord-return", clientAddress(request), 30, 600))) return away(origin, "/");
  const params = request.nextUrl.searchParams;
  const trip = await takeTrip(params.get("state") ?? "");
  if (!trip) return away(origin, "/?discord=expired");
  const store = await storeForId(trip.sid).catch(() => null);
  if (!store) return away(origin, "/");
  const code = params.get("code") ?? "";
  const declined = Boolean(params.get("error")) || !code;

  if (trip.k === "join") {
    const page = (status: string, server?: string) => away(origin, `/@${store.handle}/discord?status=${status}${server ? `&server=${server}` : ""}`);
    if (declined) return page("declined");
    if (!CODE.test(code)) return page("failed");
    const granted = await exchange(code, trip.redirect);
    const user = granted ? await whoIs(granted.accessToken) : null;
    if (!granted || !user) return page("failed");
    const joined = await joinServer({ store, email: trip.email, accessToken: granted.accessToken, user });
    return joined.ok ? page("joined", joined.serverId) : page(joined.reason);
  }

  // A creator: still signed in as the one who started, still allowed on that store.
  const session = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  const email = await emailForSession(session);
  if (!email || email.toLowerCase() !== trip.by.toLowerCase()) return away(origin, "/signin?status=expired");
  const allowed = await resolveAccess(email, { pinned: trip.sid, session }, "settings");
  if (!allowed.ok) return away(origin, allowed.store ? studioPath(allowed.store, "team=forbidden") : "/studio?team=gone");
  const { role } = allowed.access;
  const back = (query: string) => away(origin, studioPath(store, query, "discord"));
  if (declined) return back("discord=declined");
  if (!CODE.test(code)) return back("discord=error");
  // A valid trip can return after its financial approval changed. Recheck the
  // marked creator contract before exchanging credentials or replacing a server.
  // Cancellation and existing buyer access above remain separate.
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return back("discord=funding");
  const granted = await exchange(code, trip.redirect);
  if (!granted?.serverId) return back("discord=error");
  const room = storeKey(store);
  // Read exactly (CX-123 rule 24): a server kept in another shape is not "no server", or the new one would be written
  // over it, with the bot still in the old one and its buyers' addresses linked to their Discord ids for good.
  let before: DiscordServer | null;
  try {
    before = await readServerOrThrow(room);
  } catch (error) {
    if (error instanceof UnknownReplyError) return back("discord=unavailable");
    throw error;
  }
  // Another server than the one connected: the old one is let go, with whoever it gave roles to. As on "Disconnect"
  // (app/api/store/discord/route.ts), the bot first: its people are forgotten only once Discord confirmed it left.
  if (before && before.id !== granted.serverId) {
    if (!(await leaveServer(before.id))) return back("discord=server");
    try {
      await forgetServer(room, store.sid);
    } catch (error) {
      // Who was kept could not be read exactly: nothing was forgotten and the old server stays recorded, so trying
      // again (Discord then answers 404 for the old server, read as "it is out") finishes the switch.
      if (error instanceof UnknownReplyError) return back("discord=not_finished");
      throw error;
    }
  }
  await saveServer(room, {
    id: granted.serverId,
    name: granted.serverName || before?.name || "",
    at: before?.id === granted.serverId ? before.at : Math.floor(Date.now() / 1000),
    kick: before?.id === granted.serverId ? before.kick : false,
  });
  after(() => noticeCreator(store, { kind: "discord-connected", server: granted.serverName || "you chose" }));
  if (role !== "owner") await logTeam(store.sid, { who: email, role, what: `${PERMISSION_WORDS.settings}: connected Discord` });
  return back("discord=connected");
}
