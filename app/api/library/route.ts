import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { requestLibraryLink } from "@/lib/buyer-library";

/**
 * Asks for a link to a buyer's library (lib/buyer-library.ts): a plain form,
 * so it works without JavaScript. The answer is always the library page, and
 * the address typed never goes in its URL.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const away = (status: string) => new Response(null, { status: 303, headers: { Location: `${origin}/library?status=${status}`, "Cache-Control": "no-store" } });
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
    return away(await requestLibraryLink({ email, ip: clientAddress(request), origin: linkOrigin(request) }));
  } catch (error) {
    console.error("sending a library link failed", error);
    return away("error");
  }
}
