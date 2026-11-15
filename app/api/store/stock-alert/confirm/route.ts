import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { withinStore } from "@/lib/metered-limits";
import { ALERT_TOKEN, confirmStockAlert } from "@/lib/stock-alerts";

/**
 * The button behind the link in the confirmation email (623 [SZ7]): the
 * address now counts. Refused from another site; the store's public request
 * is taken, per connection, before the link is read.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let token = "";
  try {
    const form = await (await limited(request, 1_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    token = String(form.get("token") ?? "").slice(0, 60);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle).catch(() => null) : null;
  if (!store) return new Response(null, { status: 303, headers: { Location: `${origin}/`, "Cache-Control": "no-store" } });
  const away = (status: string, productId = "") =>
    new Response(null, {
      status: 303,
      headers: { Location: `${origin}/@${store.handle}/back-in-stock?product=${encodeURIComponent(productId)}&status=${status}`, "Cache-Control": "no-store" },
    });
  if (!(await withinStore("stock-alert-link", `${clientAddress(request)}|${store.handle}`, 20, 600, store))) return away("busy");
  if (!ALERT_TOKEN.test(token)) return away("expired");
  try {
    const result = await confirmStockAlert(token, store);
    return result.ok ? away("confirmed", result.productId) : away("expired");
  } catch (error) {
    console.error("confirming a back-in-stock address failed", error);
    return away("error");
  }
}
