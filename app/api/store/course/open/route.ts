import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { storeForHandle } from "@/lib/store";
import { mintPass, openCourseLink, passCookie, storeKey } from "@/lib/learn";
import { readListing } from "@/lib/catalog";
import { restingAway, takeBuyerRead } from "@/lib/buyer-actions";
import { limitUnknownResponse, unknownLimit } from "@/lib/request-guard";

/**
 * The link from the email. Whoever holds it has read that inbox, so this
 * browser is let into every course the address bought from this store.
 */
export async function GET(request: NextRequest) {
  const origin = originFrom(request);
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const grant = await openCourseLink(token);
  const store = grant ? await storeForHandle(grant.h) : null;
  if (!grant || !store || storeKey(store) !== grant.k) {
    return new Response(
      "This link has expired or was already used too many times. Open the course page and ask for a new one.",
      { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }
  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts).
  const taken = await takeBuyerRead(store).catch(unknownLimit);
  // A count that could not be read is never "resting" or "too many" (rule 24): it could not be checked just now.
  if (taken === "unknown") return limitUnknownResponse();
  if (!taken) return restingAway(origin, store);
  const product = await readListing(store, grant.p);
  const pass = await mintPass(store, grant.e, "all");
  const headers = new Headers({
    Location: `${origin}/@${store.handle}${product ? `/course/${product.id}` : ""}`,
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", passCookie(store, pass, origin.startsWith("https://")));
  return new Response(null, { status: 303, headers });
}
