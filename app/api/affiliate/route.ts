import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { requestHubLink } from "@/lib/affiliate-hub";

/**
 * Asks for a link to an affiliate's page across every store
 * (lib/affiliate-hub.ts): a plain form, so it works without JavaScript. The
 * answer is always the page, and the address typed never goes in its URL.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const away = (status: string) => new Response(null, { status: 303, headers: { Location: `${origin}/affiliate?status=${status}`, "Cache-Control": "no-store" } });
  let email = "";
  let honeypot = "";
  try {
    const form = await (await limited(request, 2_000)).formData();
    email = String(form.get("email") ?? "").slice(0, 300);
    honeypot = String(form.get("website") ?? "");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  // A field no person can see: whatever filled it in is told it worked, and nothing is sent.
  if (honeypot.trim()) return away("sent");
  try {
    return away(await requestHubLink({ email, ip: clientAddress(request), origin: linkOrigin(request) }));
  } catch (error) {
    console.error("sending an affiliate's page link failed", error);
    return away("error");
  }
}
