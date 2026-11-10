import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { ALERT_TOKEN, leaveStockAlert } from "@/lib/stock-alerts";

/**
 * Takes an address off a back-in-stock list (623 [SZ7]): from the button on
 * the list's page, or in one click from a mail app (List-Unsubscribe-Post),
 * which sends the link and the store in the address. A stop link is honored
 * at once, whatever the store's figures: only a per-connection limit stands
 * before it.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  let token = request.nextUrl.searchParams.get("t") ?? "";
  let handle = normaliseHandle(request.nextUrl.searchParams.get("h") ?? "");
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
  let done: boolean | null;
  try {
    const store = handle && ALERT_TOKEN.test(token) ? await storeForHandle(handle) : null;
    done = store ? await leaveStockAlert(token, store) : false;
  } catch (error) {
    console.error("leaving a back-in-stock list failed", error);
    done = null;
  }
  // A mail app is told to try again when it could not be done; otherwise it is done, or there was nothing to stop.
  if (oneClick) return new Response(null, { status: done === null ? 503 : 200 });
  return away(done === null ? "error" : done ? "left" : "gone");
}
