import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { AFFILIATE_SESSION_SECONDS, affiliateCookieName, joinAsBuyer } from "@/lib/affiliates";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";

const MAX_BODY_BYTES = 1_000;

/**
 * "Get my link": a buyer joining the store's affiliate programme from their
 * order, where the creator lets buyers join (lib/affiliates.ts, joinAsBuyer).
 * A button, never a link, so a mail scanner opening the email does nothing.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return new Response("Too large", { status: 413 });
  }

  let handle = "";
  let order = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const h = form.get("handle");
    const o = form.get("order");
    handle = typeof h === "string" ? normaliseHandle(h) : "";
    order = typeof o === "string" ? o.slice(0, 220) : "";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle) return new Response("Bad request", { status: 400 });
  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });

  const page = `${origin}/@${store.handle}/affiliates`;
  const back = (status: string) =>
    new Response(null, { status: 303, headers: { Location: `${page}?status=${status}`, "Cache-Control": "no-store" } });
  if (!(await withinStore("aff-join", `${clientAddress(request)}|${store.handle}`, 20, 600, store))) return back("limited");
  const result = await joinAsBuyer(store, order).catch((error) => {
    console.error("a buyer joining the affiliate program failed", error);
    return { ok: false as const, reason: "error" as const };
  });
  if (!result.ok) return back(result.reason);
  const secure = origin.startsWith("https://") ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      // An address matching one already on the list waits for the creator: the page says the application is in.
      Location: `${page}?status=${result.affiliate.status === "pending" ? "applied" : "joined"}`,
      "Cache-Control": "no-store",
      "Set-Cookie": `${affiliateCookieName(store.handle)}=${result.session}; Path=/; Max-Age=${AFFILIATE_SESSION_SECONDS}; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}
