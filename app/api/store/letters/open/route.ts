import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { storeForHandle } from "@/lib/store";
import { mintPass, passCookie, storeKey } from "@/lib/learn";
import { grantPath, openLetterLink } from "@/lib/letter-access";
import { restingAway, takeBuyerRead } from "@/lib/buyer-actions";

/**
 * The link from the email. Whoever holds it has read that inbox, so this
 * browser is given the store's pass, as the community's link gives it
 * (lib/learn.ts): the email or blog post, and whatever else the address holds here, open
 * on it for 90 days, each still asked about on every page.
 */
export async function GET(request: NextRequest) {
  const origin = originFrom(request);
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const grant = await openLetterLink(token);
  const store = grant ? await storeForHandle(grant.h) : null;
  if (!grant || !store || storeKey(store) !== grant.k) {
    return new Response("This link has expired or was already used too many times. Go back to the page you were reading and ask for a new one.", {
      status: 410,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts).
  if (!(await takeBuyerRead(store))) return restingAway(origin, store);
  const pass = await mintPass(store, grant.e, "all");
  const headers = new Headers({ Location: `${origin}/@${store.handle}${grantPath(grant)}`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", passCookie(store, pass, origin.startsWith("https://")));
  return new Response(null, { status: 303, headers });
}
