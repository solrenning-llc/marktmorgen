import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { askErasureLink, confirmErasure } from "@/lib/erasure-request";
import { makeErasureReceipt } from "@/lib/erasure-receipt";
import { handleProblem } from "@/lib/store";

/**
 * A person deleting themselves (lib/erasure-request.ts): plain forms, so it
 * works without JavaScript, answered by going back to /privacy/delete. The
 * address typed never goes in a URL.
 *
 *   action=ask, email, store (a store's address, or empty for every store)
 *   action=confirm, token (from the emailed link)
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const away = (query: string) => new Response(null, { status: 303, headers: { Location: `${origin}/privacy/delete?${query}`, "Cache-Control": "no-store" } });
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
      const scope = String(form.get("scope") ?? "");
      const asked = await askErasureLink({
        email: String(form.get("email") ?? "").slice(0, 300),
        ip: clientAddress(request),
        origin,
        handle: scope === "store" && back ? handle : undefined,
      });
      // When the link could not be sent for want of room, the day it can be asked for again (UTC).
      const opens = asked.status === "full" && asked.opens ? `&opens=${new Date(asked.opens).toISOString().slice(0, 10)}` : "";
      return away(`status=${asked.status}${opens}${back}`);
    }
    if (action === "confirm") {
      const token = String(form.get("token") ?? "").slice(0, 80);
      const done = await confirmErasure(token);
      if (done.state === "gone") return away("status=expired");
      const receipt = makeErasureReceipt(done.state, done.deleted.length, token);
      const result = receipt ? `&receipt=${encodeURIComponent(receipt)}` : "";
      if (done.state === "more") return away(`status=more&token=${encodeURIComponent(token)}${result}`);
      return away(`status=done${result}`);
    }
    return new Response("Bad request", { status: 400 });
  } catch (error) {
    console.error("a deletion request failed", error);
    return away(`status=error${back}`);
  }
}
