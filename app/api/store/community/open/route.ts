import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { storeForHandle } from "@/lib/store";
import { mintPass, passCookie, storeKey } from "@/lib/learn";
import { openCommunityLink, peekCommunityLink } from "@/lib/community-access";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { restingAway, takeBuyerRead } from "@/lib/buyer-actions";
import { communityWords } from "@/lib/buyer-words/community";

const GONE = "This link has expired or was already used too many times. Open the community page and ask for a new one.";
const gone = () => new Response(GONE, { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * The link from the email. A GET spends nothing and gives no pass (MM-SA-41):
 * mail filters and link previews fetch every link in a message, and a GET
 * that spent an open would use the link up before the buyer tapped it, while
 * a GET from another site would make this browser act as the link's owner.
 * So it only sends the browser to the store's page that asks for one tap
 * (app/[handle]/community/open/page.tsx), as the sign-in link does
 * (app/api/auth/callback/route.ts).
 */
export async function GET(request: NextRequest) {
  const origin = originFrom(request);
  const token = request.nextUrl.searchParams.get("token") ?? "";
  try {
    const grant = await peekCommunityLink(token);
    if (!grant) return gone();
    return new Response(null, { status: 303, headers: { Location: `${origin}/@${grant.h}/community/open?token=${token}`, "Cache-Control": "no-store" } });
  } catch (error) {
    // Not read in its exact shape: nothing was changed, and it is not said as an expired link (CX-123 rule 24).
    console.error("reading a community link failed", error);
    return new Response(communityWords(null).notices.error, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
}

/**
 * The tap on that page. Whoever holds the link has read that inbox, so this
 * browser is given the store's pass: the community, and every course the
 * address bought here, open on it for 90 days. Only from this site: a form
 * on another site is refused before anything is read.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let token = "";
  try {
    const value = (await (await limited(request, 1_000)).formData()).get("token");
    token = typeof value === "string" ? value.slice(0, 80) : "";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const seen: { language?: unknown } = {};
  try {
    return await open(request, token, seen);
  } catch (error) {
    // A count or a read Redis did not answer in its exact shape, or did not
    // answer: no pass is given and no cookie set, so nothing changed for the
    // person; never said as an expired link (CX-123 rule 24).
    console.error("opening a community link failed", error);
    return new Response(communityWords(seen.language).notices.error, {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

async function open(request: NextRequest, token: string, seen: { language?: unknown }): Promise<Response> {
  const origin = originFrom(request);
  const grant = await openCommunityLink(token);
  const store = grant ? await storeForHandle(grant.h) : null;
  seen.language = store?.language;
  if (!grant || !store || storeKey(store) !== grant.k) return gone();
  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts).
  if (!(await takeBuyerRead(store))) return restingAway(origin, store);
  const pass = await mintPass(store, grant.e, "all");
  const headers = new Headers({ Location: `${origin}/@${store.handle}/community`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", passCookie(store, pass, origin.startsWith("https://")));
  return new Response(null, { status: 303, headers });
}
