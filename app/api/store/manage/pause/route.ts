import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { countLeave } from "@/lib/leave-flow";
import { MANAGE_TOKEN_PATTERN } from "@/lib/membership-manage";
import { pauseMembership, resumeMembership } from "@/lib/membership-pause";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";

const MAX_BODY_BYTES = 1_000;

/**
 * Pause or Resume now beside one membership, on the page the emailed link
 * opens (lib/membership-pause.ts). Guarded as Cancel beside it is
 * (../cancel/route.ts): refused from another site, read with a size limit,
 * counted per connection, and only a press does anything.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });

  let handle = "";
  let token = "";
  let subscription = "";
  let action = "";
  let months = 0;
  let fromLeave = false;
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    token = read("token").slice(0, 80);
    subscription = read("subscription").slice(0, 80);
    action = read("action").slice(0, 10);
    months = Number(read("months").slice(0, 2));
    fromLeave = read("from") === "leave";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle) return new Response("Bad request", { status: 400 });
  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });

  const back = (status: string) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: `${origin}/@${store.handle}/manage?status=${status}${MANAGE_TOKEN_PATTERN.test(token) ? `&token=${token}` : ""}`,
        "Cache-Control": "no-store",
      },
    });

  if (!MANAGE_TOKEN_PATTERN.test(token)) return back("expired");
  const room = await withinStore("manage-open", `${clientAddress(request)}|${store.handle}`, 20, 600, store, "buyer").catch(unknownLimit);
  if (room === "unknown") return back("error");
  if (!room) return back("limited");

  if (action === "resume") {
    const result = await resumeMembership(store, token, subscription);
    return back(result.ok ? "resumed" : result.reason === "declined" ? "resume-declined" : result.reason === "cannot" ? "cannot-pause" : result.reason);
  }
  const result = await pauseMembership(store, token, subscription, months);
  // Paused instead of leaving, from the page that asked why (lib/leave-flow.ts).
  if (result.ok && fromLeave && store.leaving.on) await countLeave(store.statsId, "paused");
  return back(result.ok ? "paused" : result.reason === "cannot" ? "cannot-pause" : result.reason);
}
