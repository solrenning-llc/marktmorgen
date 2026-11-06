import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { serviceRefusalCode, withinServiceWhy } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { authorizeUrl, isDiscordConfigured, redirectUri } from "@/lib/discord";
import { startTrip } from "@/lib/discord-store";
import { ensureStoreId } from "@/lib/store";
import { away, creatorFrom, studioPath } from "@/lib/studio-route";

/**
 * "Connect a Discord server": the studio's form posts here, and the owner or
 * an Admin ("settings") is sent to Discord's own page to add Marktmorgen's
 * bot to a server of theirs (lib/discord.ts). Not found until the
 * deployment has the application's keys.
 */
export async function POST(request: NextRequest) {
  if (!isDiscordConfigured()) return new Response("Not found.", { status: 404 });
  const creator = await creatorFrom(request, "settings");
  if (creator instanceof Response) return creator;
  const { store, ref, email, origin } = creator;
  const back = (query: string) => away(origin, studioPath(store, query, "discord"));
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return back("discord=funding");
  const sid = store.sid || (await ensureStoreId(ref))?.sid || "";
  if (!sid) return back("discord=error");
  const refused = await withinServiceWhy("discord-connect", sid, 10, 600, store);
  if (refused) return back(`discord=${serviceRefusalCode(refused, "limited")}`);
  const redirect = redirectUri(origin);
  const state = await startTrip({ k: "install", sid, by: email, redirect });
  return new Response(null, { status: 303, headers: { Location: authorizeUrl("install", state, redirect), "Cache-Control": "no-store" } });
}
