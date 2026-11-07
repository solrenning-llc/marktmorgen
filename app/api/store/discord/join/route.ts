import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { fromAnotherSite, limited, clientAddress } from "@/lib/request-guard";
import { readOrder } from "@/lib/store-checkout";
import { ordersGrant } from "@/lib/buyer-orders";
import { authorizeUrl, isDiscordConfigured, redirectUri } from "@/lib/discord";
import { readServer, startTrip } from "@/lib/discord-store";
import { storeKey } from "@/lib/learn";

/**
 * "Join the Discord", from the thanks page (the order, read again from
 * Stripe) or from the buyer's orders (the link emailed to the address they
 * paid with). Either way, the address is one that paid, never one typed
 * here; the buyer is sent to Discord's own page to agree, and what that
 * address holds is read again when they come back (lib/discord-access.ts).
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let sessionId = "";
  let token = "";
  try {
    const form = await (await limited(request, 2_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    sessionId = String(form.get("session_id") ?? "").slice(0, 200);
    token = String(form.get("token") ?? "").slice(0, 200);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  const page = (status: string) => new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/discord?status=${status}`, "Cache-Control": "no-store" } });
  if (!isDiscordConfigured() || !store.sid || !(await readServer(storeKey(store)))) return page("off");
  if (!(await withinStore("discord-join", clientAddress(request), 20, 600, store, "buyer"))) return page("failed");

  let email: string | null = null;
  if (sessionId) {
    const order = await readOrder(store, sessionId);
    email = order.state === "paid" && !order.gift && !order.group ? order.email : null;
  } else if (token) {
    email = await ordersGrant(store, token);
  }
  if (!email) return page("none");
  const redirect = redirectUri(origin);
  const state = await startTrip({ k: "join", sid: store.sid, email, redirect, back: `/@${store.handle}` });
  return new Response(null, { status: 303, headers: { Location: authorizeUrl("join", state, redirect), "Cache-Control": "no-store" } });
}
