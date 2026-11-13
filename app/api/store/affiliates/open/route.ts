import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { AFFILIATE_SESSION_SECONDS, type Charge, affiliateCookieName, openAffiliateLink } from "@/lib/affiliates";
import { forcePublicRequests, givePublicRequests, holdPublicRequests } from "@/lib/traffic";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";

const MAX_BODY_BYTES = 1_000;

/**
 * The button on the page an emailed link opens. Only this makes the
 * application and signs the browser in, so a mail scanner opening the link
 * does nothing.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return new Response("Too large", { status: 413 });
  }

  let handle = "";
  let token = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const h = form.get("handle");
    const t = form.get("token");
    handle = typeof h === "string" ? normaliseHandle(h) : "";
    token = typeof t === "string" ? t.slice(0, 80) : "";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle) return new Response("Bad request", { status: 400 });
  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });

  const page = `${origin}/@${store.handle}/affiliates`;
  if (!(await withinStore("aff-open", `${clientAddress(request)}|${store.handle}`, 20, 600, store))) {
    return new Response(null, { status: 303, headers: { Location: `${page}?status=limited`, "Cache-Control": "no-store" } });
  }
  // Accepting an invitation that carries a share reads the program's people for the 90% cap: paid from the store's
  // public requests first, at the read's worst, as its other public links are, and given back down to what was read
  // (lib/affiliates.ts paidPeople). Not taken: the page says so ("resting"), nothing read or written, the link kept.
  const charge: Charge = async (units) => {
    const now = Date.now();
    // Refused, the hold is not left counted (`hold`); given back only up to what was taken; a read that moved more is
    // counted at what it read, past the window if it must (forcePublicRequests).
    if (!(await holdPublicRequests(store, units, now))) return null;
    return {
      give: async (n) => {
        if (Number.isSafeInteger(n) && n > 0 && n <= units) await givePublicRequests(store, n, now);
      },
      force: (n) => forcePublicRequests(store, n, now),
    };
  };
  const result = await openAffiliateLink(store, token, charge).catch((error) => {
    console.error("opening an affiliate link failed", error);
    return { ok: false as const, reason: "error" as const };
  });
  if (!result.ok) {
    // An invitation whose share no longer fits the cap (lib/affiliates.ts): the page's "not taking affiliates right now".
    const status = result.reason === "committed" || result.reason === "crowded" ? "unavailable" : result.reason;
    return new Response(null, { status: 303, headers: { Location: `${page}?status=${status}`, "Cache-Control": "no-store" } });
  }
  const secure = origin.startsWith("https://") ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${page}?status=${result.created ? (result.affiliate.status === "approved" ? "joined" : "applied") : "welcome"}`,
      "Cache-Control": "no-store",
      "Set-Cookie": `${affiliateCookieName(store.handle)}=${result.session}; Path=/; Max-Age=${AFFILIATE_SESSION_SECONDS}; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}
