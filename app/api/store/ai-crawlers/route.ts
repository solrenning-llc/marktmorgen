import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { setAiCrawlers } from "@/lib/store";

/**
 * Whether the robots.txt of the store's own domain asks AI crawlers to stay
 * out (lib/ai-crawlers.ts, 601 [KB22] U8): `{ open: true | false }`. Only an
 * exact boolean is taken. The answer says what is kept, read back from the
 * store, so the studio never shows a choice that was not saved.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 500);
  if (!guarded.ok) return guarded.response;
  if (typeof guarded.body.open !== "boolean") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  try {
    const store = await setAiCrawlers(guarded.ref, guarded.body.open ? "open" : "closed");
    if (!store) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
    return Response.json({ ok: true, open: store.aiCrawlers === "open" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("changing whether AI crawlers are asked to stay out failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
