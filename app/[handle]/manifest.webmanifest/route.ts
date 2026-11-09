import type { NextRequest } from "next/server";
import { lookUpVisitorStore, normaliseHandle } from "@/lib/store";
import { storeLookupRefusal } from "@/lib/store-lookup";
import { storeManifest } from "@/lib/store-app";

/**
 * A store's own web app manifest (lib/store-app.ts), linked from every one
 * of its pages. The address has a file extension, so the proxy leaves it
 * alone and it answers the same on marktmorgen.com and on the creator's own
 * domain; which of the two it was asked on decides where the app opens.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ handle: string }> }) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  const missing = () =>
    new Response("Not found.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (!decoded.startsWith("@")) return missing();

  try {
    // An address leading nowhere asked past the connection's pace is told to wait; a real store always opens.
    const { store, retryAfter } = await lookUpVisitorStore(normaliseHandle(decoded));
    if (retryAfter) return storeLookupRefusal(retryAfter);
    if (!store) return missing();
    const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
      .split(",")[0]
      .trim()
      .toLowerCase()
      .replace(/:\d+$/, "");
    return new Response(JSON.stringify(storeManifest(store, host)), {
      headers: {
        "Content-Type": "application/manifest+json; charset=utf-8",
        // Short, so a new name or colour reaches an installed app soon.
        "Cache-Control": "public, max-age=300",
        // It differs by the address it was asked on.
        Vary: "Host, X-Forwarded-Host",
      },
    });
  } catch (error) {
    console.error("serving a store manifest failed", error);
    return new Response("Try again in a moment.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
