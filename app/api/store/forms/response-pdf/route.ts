import type { NextRequest } from "next/server";
import { creatorFrom } from "@/lib/studio-route";
import { readForm, readResponses } from "@/lib/form-store";
import { FORM_ID, FORM_RESPONSE_ID } from "@/lib/forms";
import { responseDrawable, responsePdf } from "@/lib/form-response-pdf";
import { parseLanguage } from "@/lib/store-language";

/**
 * One answer to a form as a tagged PDF (lib/form-response-pdf.ts, 639
 * [GL7](26)): `?id=<form>&response=<answer>`. An answer can hold a person's
 * address and their own words, so, as the spreadsheet of answers, only a
 * role that may download the store's files reaches it. Made on request,
 * kept nowhere.
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "export");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  const params = request.nextUrl.searchParams;
  const id = params.get("id") ?? "";
  const responseId = params.get("response") ?? "";
  const plain = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (!FORM_ID.test(id) || !FORM_RESPONSE_ID.test(responseId)) return plain(400, "Which form, and which answer?");
  const form = await readForm(store.statsId, id);
  if (!form) return plain(404, "That form is gone.");
  const response = (await readResponses(store.statsId, id)).responses.find((r) => r.id === responseId);
  if (!response) return plain(404, "That answer is no longer kept.");
  const when = new Date(response.at * 1000);
  const sentLine = `Sent on ${new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(when)}`;
  const sheet = { form, response, storeName: store.name, sentLine, lang: parseLanguage(store.language) };
  if (!(await responseDrawable(sheet))) return plain(422, "This answer has letters the PDF cannot draw. Read it in the list of answers or the spreadsheet instead.");
  const bytes = await responsePdf(sheet);
  const name = `${form.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "form"}-${when.toISOString().slice(0, 10)}.pdf`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
