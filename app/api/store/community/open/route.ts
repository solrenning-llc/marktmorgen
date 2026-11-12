import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { storeForHandle } from "@/lib/store";
import { mintPass, passCookie, storeKey } from "@/lib/learn";
import { openCommunityLink } from "@/lib/community-access";
import { restingAway, takeBuyerRead } from "@/lib/buyer-actions";
import { communityWords } from "@/lib/buyer-words/community";

/**
 * The link from the email. Whoever holds it has read that inbox, so this
 * browser is given the store's pass: the community, and every course the
 * address bought here, open on it for 90 days.
 */
export async function GET(request: NextRequest) {
  const seen: { language?: unknown } = {};
  try {
    return await open(request, seen);
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

async function open(request: NextRequest, seen: { language?: unknown }): Promise<Response> {
  const origin = originFrom(request);
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const grant = await openCommunityLink(token);
  const store = grant ? await storeForHandle(grant.h) : null;
  seen.language = store?.language;
  if (!grant || !store || storeKey(store) !== grant.k) {
    return new Response(
      "This link has expired or was already used too many times. Open the community page and ask for a new one.",
      { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }
  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts).
  if (!(await takeBuyerRead(store))) return restingAway(origin, store);
  const pass = await mintPass(store, grant.e, "all");
  const headers = new Headers({ Location: `${origin}/@${store.handle}/community`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", passCookie(store, pass, origin.startsWith("https://")));
  return new Response(null, { status: 303, headers });
}
