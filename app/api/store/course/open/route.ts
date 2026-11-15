import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { storeForHandle } from "@/lib/store";
import { mintPass, openCourseLink, passCookie, peekCourseLink, storeKey } from "@/lib/learn";
import { readListing } from "@/lib/catalog";
import { restingAway, takeBuyerRead } from "@/lib/buyer-actions";
import { fromAnotherSite, limited } from "@/lib/request-guard";

const GONE = "This link has expired or was already used too many times. Open the course page and ask for a new one.";
const gone = () => new Response(GONE, { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * The link from the email. A GET spends nothing and gives no pass (MM-SA-41):
 * mail filters and link previews fetch every link in a message, and a GET
 * that spent an open would use the link up before the buyer tapped it, while
 * a GET from another site would make this browser act as the link's owner.
 * So it only sends the browser to the store's page that asks for one tap
 * (app/[handle]/course/open/page.tsx), as the sign-in link does
 * (app/api/auth/callback/route.ts).
 */
export async function GET(request: NextRequest) {
  const origin = originFrom(request);
  const token = request.nextUrl.searchParams.get("token") ?? "";
  try {
    const grant = await peekCourseLink(token);
    if (!grant) return gone();
    return new Response(null, { status: 303, headers: { Location: `${origin}/@${grant.h}/course/open?token=${token}`, "Cache-Control": "no-store" } });
  } catch (error) {
    // Not read in its exact shape: nothing was changed, and it is not said as an expired link (CX-123 rule 24).
    console.error("reading a course link failed", error);
    return new Response("Something went wrong on our side. Nothing was changed; try again in a moment.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
}

/**
 * The tap on that page. Whoever holds the link has read that inbox, so this
 * browser is let into every course the address bought from this store. Only
 * from this site: a form on another site is refused before anything is read.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const origin = originFrom(request);
  let token = "";
  try {
    const value = (await (await limited(request, 1_000)).formData()).get("token");
    token = typeof value === "string" ? value.slice(0, 80) : "";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const grant = await openCourseLink(token);
  const store = grant ? await storeForHandle(grant.h) : null;
  if (!grant || !store || storeKey(store) !== grant.k) return gone();
  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts).
  if (!(await takeBuyerRead(store))) return restingAway(origin, store);
  const product = await readListing(store, grant.p);
  const pass = await mintPass(store, grant.e, "all");
  const headers = new Headers({
    Location: `${origin}/@${store.handle}${product ? `/course/${product.id}` : ""}`,
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", passCookie(store, pass, origin.startsWith("https://")));
  return new Response(null, { status: 303, headers });
}
