import type { NextRequest } from "next/server";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { originFrom } from "@/lib/request-origin";
import { addToDoNotContact, normalizeResearchContact } from "@/lib/research-do-not-contact";
import { researchOperator } from "@/lib/research-operator";

/**
 * The operator adding to the research do-not-contact list someone who asked
 * by email (lib/research-do-not-contact.ts): the same form as the public one
 * on /privacy/do-not-contact, shown only to the person who runs the site, up
 * to the whole list's ceiling, with no per-connection or daily count.
 * Anybody else, a locked session, or a site with no operator configured, is
 * answered as if this did not exist (lib/research-operator.ts).
 */
export async function POST(request: NextRequest) {
  const notFound = new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (fromAnotherSite(request)) return notFound;
  if (!(await researchOperator(request.cookies))) return notFound;
  const origin = originFrom(request);
  const away = (status: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/privacy/do-not-contact?status=${status}`, "Cache-Control": "no-store" } });
  const form = await limited(request, 2_000).then((r) => r.formData()).catch(() => null);
  if (!form) return new Response("Bad request", { status: 400 });
  const contact = String(form.get("contact") ?? "");
  if (!normalizeResearchContact(contact)) return away("contact");
  if (form.get("confirm") !== "yes") return away("confirm");
  try {
    const result = await addToDoNotContact({ contact, name: String(form.get("name") ?? "") }, "operator");
    return away(result === "added" || result === "listed" ? "done" : "full");
  } catch (error) {
    console.error("an operator's do-not-contact entry failed", error);
    return away("error");
  }
}
