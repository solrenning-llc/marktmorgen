import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { MANAGE_TOKEN_PATTERN, openPortal } from "@/lib/membership-manage";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";

const MAX_BODY_BYTES = 1_000;

/**
 * The button on the page the emailed link opens. Only this asks Stripe for
 * the member's portal, so a mail scanner opening the link does nothing.
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
  // Which membership's page, when the member has several customers (R43 F1 on #2985); none is the newest one's.
  let subscription = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    token = read("token").slice(0, 80);
    subscription = read("subscription").slice(0, 80);
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
        Location: `${origin}/@${store.handle}/manage?status=${status}`,
        "Cache-Control": "no-store",
      },
    });

  if (!MANAGE_TOKEN_PATTERN.test(token)) return back("expired");
  // Each press opens a billing page on the creator's Stripe account.
  if (!(await withinStore("manage-open", `${clientAddress(request)}|${store.handle}`, 20, 600, store, "buyer"))) return back("limited");

  const result = await openPortal(store, token, linkOrigin(request, store), subscription);
  if (!result.ok) return back(result.reason);
  return new Response(null, {
    status: 303,
    headers: { Location: result.url, "Cache-Control": "no-store" },
  });
}
