import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, limited, withinLimit, unknownLimit, limitUnknownResponse } from "@/lib/request-guard";
import { stopFromLink } from "@/lib/outreach";
import { STOP_LINK } from "@/lib/outreach-rules";

/**
 * The button behind the stop link in an Outreach email's footer
 * (lib/outreach.ts, stopFromLink): the business it was sent to closes itself
 * to the store that wrote, or to every store here. The link's key is the
 * whole key; it only ever closes a door, and it holds without anybody at the
 * store doing anything.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  let token = "";
  let everyone = false;
  try {
    const form = await (await limited(request, 4_000)).formData();
    token = String(form.get("p") ?? "").slice(0, 40);
    everyone = form.get("scope") === "all";
  } catch {
    token = "";
  }
  if (!STOP_LINK.test(token)) return new Response("Not found.", { status: 404 });
  const room = await withinLimit("outreach-stop", clientAddress(request), 20, 600).catch(unknownLimit);
  // A count that could not be read is never "too many requests" (rule 24).
  if (room === "unknown") return limitUnknownResponse();
  if (!room) {
    return new Response("Too many requests. Try again in a few minutes.", { status: 429 });
  }
  const done = await stopFromLink(token, everyone).catch((error) => {
    console.error("an outreach stop failed", error);
    return false;
  });
  return new Response(null, {
    status: 303,
    headers: { Location: `${origin}/outreach/stop/${token}?done=${done ? "1" : "0"}`, "Cache-Control": "no-store" },
  });
}
