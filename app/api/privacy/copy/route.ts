import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { COPY_DOOR_OPEN, copyFor, requestCopyLink } from "@/lib/copy-request";
import { type CopyFormat, copyCsv, copyJson } from "@/lib/copy-request-rules";
import { handleProblem } from "@/lib/store";

/**
 * The door to a copy of one's own data (619 [SZ3], lib/copy-request.ts):
 *
 *   action=ask    an emailed link, for one store or every store that knows the address
 *   action=make   one store's copy from a live link, as a file: JSON or a spreadsheet
 *
 * Closed, "not found", until COPY_DOOR_OPEN. The address is never put in a URL.
 */
export async function POST(request: NextRequest) {
  if (!COPY_DOOR_OPEN) return new Response("Not found", { status: 404 });
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const away = (query: string) => new Response(null, { status: 303, headers: { Location: `${origin}/privacy/copy?${query}`, "Cache-Control": "no-store" } });
  let form: FormData;
  try {
    form = await (await limited(request, 2_000)).formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const action = String(form.get("action") ?? "");
  const handle = String(form.get("store") ?? "").trim().toLowerCase().slice(0, 60);
  const back = handle && !handleProblem(handle) ? `&store=${encodeURIComponent(handle)}` : "";
  try {
    if (action === "ask") {
      // A field no person can see: whatever filled it in is told it worked, and nothing is sent.
      if (String(form.get("website") ?? "").trim()) return away(`status=sent${back}`);
      const status = await requestCopyLink({
        email: String(form.get("email") ?? "").slice(0, 300),
        ip: clientAddress(request),
        origin,
        handle: String(form.get("scope") ?? "") === "store" && back ? handle : undefined,
      });
      return away(`status=${status}${back}`);
    }
    if (action === "make") {
      const token = String(form.get("token") ?? "").slice(0, 80);
      const sid = String(form.get("sid") ?? "").slice(0, 40);
      const format: CopyFormat = form.get("format") === "csv" ? "csv" : "json";
      const result = await copyFor(token, sid);
      if (result.state === "gone") return away("status=expired");
      if (result.state === "queued") return away(`status=queued&due=${result.due}&token=${encodeURIComponent(token)}`);
      const name = `${result.copy.store.handle}-your-data-${result.copy.made.slice(0, 10)}.${format}`;
      return new Response(format === "csv" ? copyCsv(result.copy) : copyJson(result.copy), {
        status: 200,
        headers: {
          "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "-")}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return new Response("Bad request", { status: 400 });
  } catch (error) {
    console.error("a copy request failed", error);
    return away(`status=error${back}`);
  }
}
