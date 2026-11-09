import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, essentialLimitState, fromAnotherSite, limited } from "@/lib/request-guard";
import { RESEARCH_STOP_PER_HOUR, addToDoNotContact, normalizeResearchContact } from "@/lib/research-do-not-contact";

/**
 * A person asking Marktmorgen never to contact them for its research
 * (lib/research-do-not-contact.ts): a plain form, so it works without
 * JavaScript and without an account, answered by going back to
 * /privacy/do-not-contact. What was typed never goes in a URL.
 *
 *   contact (an email address or a link to a site or profile), name (optional)
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const away = (status: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/privacy/do-not-contact?status=${status}`, "Cache-Control": "no-store" } });
  let form: FormData;
  try {
    form = await (await limited(request, 2_000)).formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  // A field no person can see: whatever filled it in is told it worked, and nothing is kept.
  if (String(form.get("website") ?? "").trim()) return away("done");
  const contact = String(form.get("contact") ?? "");
  if (!normalizeResearchContact(contact)) return away("contact");
  const limit = await essentialLimitState("research-stop", clientAddress(request), RESEARCH_STOP_PER_HOUR, 60 * 60);
  if (limit === "exceeded") return away("limited");
  if (limit === "unknown") return away("error");
  try {
    const result = await addToDoNotContact({ contact, name: String(form.get("name") ?? "") });
    // Already on the list is said the same way as added, so the page does not tell who is on it.
    return away(result === "full" ? "full" : "done");
  } catch (error) {
    console.error("a do-not-contact request failed", error);
    return away("error");
  }
}
