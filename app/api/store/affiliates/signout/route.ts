import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { affiliateCookieName, endAffiliateSession } from "@/lib/affiliates";
import { fromAnotherSite, limited } from "@/lib/request-guard";

/** An affiliate leaving their page on this browser. */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  try {
    const form = await (await limited(request, 8_000)).formData();
    const h = form.get("handle");
    handle = typeof h === "string" ? normaliseHandle(h) : "";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  const name = affiliateCookieName(store.handle);
  // This browser's cookie goes whatever happens; "signed out" is said only when ending the session at the server did
  // not fail. Otherwise the page says it may still be open, never signed out (CX-123 rule 24, as app/api/auth/signout;
  // tests/affiliate-signout-exact.test.ts).
  let ended = true;
  try {
    await endAffiliateSession(request.cookies.get(name)?.value);
  } catch (error) {
    console.error("affiliate sign-out failed", error);
    ended = false;
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${origin}/@${store.handle}/affiliates?status=${ended ? "signedout" : "signedout-unknown"}`,
      "Cache-Control": "no-store",
      "Set-Cookie": `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    },
  });
}
