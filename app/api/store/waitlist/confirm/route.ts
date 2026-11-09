import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { storeForHandle } from "@/lib/store";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { WAIT_TOKEN, confirmSpot, readWaitToken } from "@/lib/waitlist";

/** The button in the email that confirms a spot on a waitlist. */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let token = "";
  try {
    const form = await (await limited(request, 1_000)).formData();
    token = String(form.get("token") ?? "").slice(0, 60);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const grant = WAIT_TOKEN.test(token) ? await readWaitToken(token) : null;
  const store = grant ? await storeForHandle(grant.h) : null;
  // Switched off after notices about its content: nothing is confirmed, and the answer is the store's page, as on its sign-up.
  if (store?.suspended) return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}`, "Cache-Control": "no-store" } });
  const result = grant ? await confirmSpot(token, store) : { ok: false as const };
  const handle = store?.handle ?? grant?.h ?? "";
  const target = handle
    ? `${origin}/@${handle}/waitlist?product=${encodeURIComponent(grant?.p ?? "")}&status=${result.ok ? "confirmed" : "expired"}`
    : `${origin}/`;
  return new Response(null, { status: 303, headers: { Location: target, "Cache-Control": "no-store" } });
}
