import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { WAIT_TOKEN, leaveWaitlist, readWaitToken } from "@/lib/waitlist";
import { storeForHandle } from "@/lib/store";

/**
 * Takes an address off a waitlist: from the button on the waitlist page, or
 * in one click from a mail app (List-Unsubscribe-Post), which sends the
 * token in the address.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  let token = request.nextUrl.searchParams.get("t") ?? "";
  const oneClick = Boolean(token);
  if (!oneClick) {
    if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
    try {
      const form = await (await limited(request, 1_000)).formData();
      token = String(form.get("token") ?? "").slice(0, 60);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  }
  const grant = WAIT_TOKEN.test(token) ? await readWaitToken(token) : null;
  // The store's room gets the place back; a store renamed since keeps it counted.
  const store = grant ? await storeForHandle(grant.h).catch(() => null) : null;
  const done = grant ? await leaveWaitlist(token, store && store.statsId === grant.s ? store : null) : false;
  if (oneClick) return new Response(null, { status: 200 });
  const target = grant ? `${origin}/@${grant.h}/waitlist?product=${encodeURIComponent(grant.p)}&status=${done ? "left" : "expired"}` : `${origin}/`;
  return new Response(null, { status: 303, headers: { Location: target, "Cache-Control": "no-store" } });
}
