import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { type NextRequest, after } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { noticeCreator } from "@/lib/account-notice";
import { exchange, isDiscordConfigured, leaveServer, whoIs } from "@/lib/discord";
import { joinServer } from "@/lib/discord-access";
import { forgetServer, readServerOrThrow, saveServer, takeTrip } from "@/lib/discord-store";
import { storeKey } from "@/lib/learn";
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
  // The server kept so far, read exactly (CX-123 rule 24) before the code is spent: only the exact null is "none".
  // An unknown read never counts as "nothing connected", which would write the new server over the old one while
  // the old one's roles and members (with buyers' addresses) stayed on the store and the bot stayed in it.
  const room = storeKey(store);
  let before: Awaited<ReturnType<typeof readServerOrThrow>>;
  try {
    before = await readServerOrThrow(room);
  } catch (error) {
    console.error("reading the connected Discord server before a connection failed", error);
    return back("discord=unchecked");
  }
  const granted = await exchange(code, trip.redirect);
  if (!granted?.serverId) return back("discord=error");
  // Another server than the one connected: the old one is let go, with whoever it gave roles to.
  // A failed forget switches nothing only when it changed nothing: the kept server is read again, exactly. Still the
  // old one (a thrown read, or an exact read that throws UnknownReplyError, before the DEL): the new server is not
  // saved, the bot stays in the old one, and the creator is told nothing was changed. Exactly none (the DEL ran and
  // only its reply was lost): the forget happened, so the switch finishes. Anything else, or a failed read: the
  // outcome is unknown and the creator is told so, never "Nothing was changed" (Claude 4's focal return on #2976).
  if (before && before.id !== granted.serverId) {
    try {
      await forgetServer(room, store.sid);
    } catch (error) {
      console.error("forgetting the old Discord server before a switch failed", error);
      let now: Awaited<ReturnType<typeof readServerOrThrow>>;
      try {
        now = await readServerOrThrow(room);
      } catch (again) {
        console.error("reading the connected Discord server after a failed forget failed", again);
        return back("discord=unconfirmed");
      }
      if (now?.id === before.id) return back("discord=unchecked");
      if (now !== null) return back("discord=unconfirmed");
    }
    await leaveServer(before.id).catch(() => false);
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
