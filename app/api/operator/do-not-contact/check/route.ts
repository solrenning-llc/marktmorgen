import type { NextRequest } from "next/server";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { originFrom } from "@/lib/request-origin";
import { doNotContactState } from "@/lib/research-do-not-contact";
import { researchOperator } from "@/lib/research-operator";

/**
 * The operator looking a contact up on the research do-not-contact list
 * before writing to someone by hand (lib/research-do-not-contact.ts,
 * doNotContactState): "listed", "clear", "unknown" (do not write) or
 * "contact" (not one it reads). Asked from the page with JavaScript, the
 * answer comes back as JSON and the contact stays in the field; without it,
 * the page comes back with the answer, never the contact, in its URL.
 * Anybody else is answered as if this did not exist (lib/research-operator.ts).
 */
export async function POST(request: NextRequest) {
  const notFound = new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (fromAnotherSite(request)) return notFound;
  if (!(await researchOperator(request.cookies))) return notFound;
  const form = await limited(request, 2_000).then((r) => r.formData()).catch(() => null);
  if (!form) return new Response("Bad request", { status: 400 });
  const state = await doNotContactState(String(form.get("contact") ?? ""));
  if ((request.headers.get("accept") ?? "").includes("application/json")) {
    return Response.json({ state }, { headers: { "Cache-Control": "no-store" } });
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `${originFrom(request)}/privacy/do-not-contact?status=check-${state}`, "Cache-Control": "no-store" },
  });
}
