import type { NextRequest } from "next/server";
import { creatorFrom } from "@/lib/studio-route";
import { readForm, readResponses } from "@/lib/form-store";
import { FORM_ID, responsesCsv } from "@/lib/forms";

/**
 * A form's answers as a spreadsheet (lib/forms.ts, responsesCsv): every one
 * kept, newest first. Answers can hold people's addresses and their own
 * words, so only a role that may download the store's files reaches it.
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "export");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  const id = request.nextUrl.searchParams.get("id") ?? "";
  const plain = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (!FORM_ID.test(id)) return plain(400, "Which form?");
  const form = await readForm(store.statsId, id);
  if (!form) return plain(404, "That form is gone.");
  const read = await readResponses(store.statsId, id).catch(() => null);
  if (read === null) return plain(503, "unavailable");
  const { responses } = read;
  const name = `${form.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "form"}-${new Date().toISOString().slice(0, 10)}.csv`;
  // The byte-order mark makes Excel read the file as UTF-8.
  return new Response(`﻿${responsesCsv(form, responses)}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
