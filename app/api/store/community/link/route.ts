import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { requestCommunityLink } from "@/lib/community-access";
import { clientIp } from "@/lib/visit";
import { limited, limitUnknownResponse, unknownLimit } from "@/lib/request-guard";
import { restingAway, takeBuyerRead } from "@/lib/buyer-actions";

/** "Send me a link": a member coming into the community on this device. */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let handle = "";
  let email = "";
  try {
    const form = await (await limited(request, 8_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    email = String(form.get("email") ?? "").slice(0, 300);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store?.community) return new Response("Not found.", { status: 404 });

  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts); the email it sends is an access email.
  const taken = await takeBuyerRead(store).catch(unknownLimit);
  // A count that could not be read is never "resting" or "too many" (rule 24): it could not be checked just now.
  if (taken === "unknown") return limitUnknownResponse();
  if (!taken) return restingAway(origin, store);
  let result: string;
  try {
    result = await requestCommunityLink({ store, email, ip: clientIp(request), origin: linkOrigin(request, store) });
  } catch (error) {
    console.error("sending a community link failed", error);
    result = "error";
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `${origin}/@${store.handle}/community?link=${result}`, "Cache-Control": "no-store" },
  });
}
