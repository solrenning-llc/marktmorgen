import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, essentialLimitState, fromAnotherSite, limited } from "@/lib/request-guard";
import { PUBLIC_CEILING, RESEARCH_STOP_PER_HOUR, addToDoNotContact, normalizeResearchContact } from "@/lib/research-do-not-contact";
import { DO_NOT_CONTACT_TRAP } from "@/lib/research-contact";
import { shareAddress } from "@/lib/traffic-rules";

/**
 * A person asking Marktmorgen never to contact them for its research
 * (lib/research-do-not-contact.ts): a plain form, so it works without
 * JavaScript and without an account, answered by going back to
 * /privacy/do-not-contact. What was typed never goes in a URL.
 *
 *   contact (an email address or a link to a site or profile), name (optional),
 *   confirm ("yes": the person read that the entry stays on the list)
 *
 * Counted per connection, an IPv6 one by its network (shareAddress, a /48),
 * and inside PUBLIC_CEILING: past the list's public ceiling or the day's new
 * entries, every contact is answered "full", listed or not, so the page never
 * tells who is on the list.
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
  if (String(form.get(DO_NOT_CONTACT_TRAP) ?? "").trim()) return away("done");
  const contact = String(form.get("contact") ?? "");
  if (!normalizeResearchContact(contact)) return away("contact");
  if (form.get("confirm") !== "yes") return away("confirm");
  const limit = await essentialLimitState("research-stop", shareAddress(clientAddress(request)) || "unknown", RESEARCH_STOP_PER_HOUR, 60 * 60);
  if (limit === "exceeded") return away("limited");
  if (limit === "unknown") return away("error");
  try {
    const result = await addToDoNotContact({ contact, name: String(form.get("name") ?? "") }, PUBLIC_CEILING);
    // Already on the list is said the same way as added, and a ceiling is said before the list is looked in.
    return away(result === "added" || result === "listed" ? "done" : "full");
  } catch (error) {
    console.error("a do-not-contact request failed", error);
    return away("error");
  }
}
