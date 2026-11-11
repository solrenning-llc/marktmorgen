import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { storeForIdExactly } from "@/lib/store-exact";
import { ALERT_TOKEN, leaveStockAlert, stockAlertLink } from "@/lib/stock-alerts";

/**
 * Takes an address off a back-in-stock list (623 [SZ7]): from the button on
 * the list's page, or in one click from a mail app (List-Unsubscribe-Post),
 * which sends the link and the store's own id in the address (never its
 * handle, which can change or be let go). A stop link is honored at once,
 * whatever the store's figures: only a per-connection limit stands before
 * it. A mail app is answered 200 only when the place is gone or there was
 * nothing left to stop; a link still standing that could not be honored is
 * never a silent 200.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  let token = request.nextUrl.searchParams.get("t") ?? "";
  let handle = "";
  const oneClick = Boolean(token);
  if (!oneClick) {
    if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
    try {
      const form = await (await limited(request, 1_000)).formData();
      handle = normaliseHandle(String(form.get("handle") ?? ""));
      token = String(form.get("token") ?? "").slice(0, 60);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  }
  const away = (status: string) =>
    new Response(null, { status: 303, headers: { Location: handle ? `${origin}/@${handle}/back-in-stock?status=${status}` : `${origin}/`, "Cache-Control": "no-store" } });
  if (!(await withinLimit("stock-alert-leave", clientAddress(request), 300, 600))) return oneClick ? new Response(null, { status: 429, headers: { "Retry-After": "600" } }) : away("limited");
  if (oneClick) {
    // The store by its own id: "unknown" is tried again, never taken as gone (rule 24).
    let status: number;
    try {
      const found = ALERT_TOKEN.test(token) ? await storeForIdExactly(request.nextUrl.searchParams.get("i") ?? "") : "none";
      if (found === "unknown") status = 503;
      else if (found !== "none" && (await leaveStockAlert(token, found))) status = 200;
      // Not left here: done only when the link itself is gone (nothing left to stop); a link still standing is not done.
      else status = ALERT_TOKEN.test(token) && (await stockAlertLink(token)) ? 404 : 200;
    } catch (error) {
      console.error("leaving a back-in-stock list failed", error);
      status = 503;
    }
    return new Response(null, { status });
  }
  let done: boolean | null;
  try {
    const store = handle && ALERT_TOKEN.test(token) ? await storeForHandle(handle) : null;
    done = store ? await leaveStockAlert(token, store) : false;
  } catch (error) {
    console.error("leaving a back-in-stock list failed", error);
    done = null;
  }
  return away(done === null ? "error" : done ? "left" : "gone");
}
