import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { closeAlert } from "@/lib/child-safety-alerts";

const TOKEN = /^[0-9a-f]{96}$/;

/**
 * The button behind the "mark this report handled" link in the owner's urgent
 * email about a child-safety report or an intimate image
 * (lib/child-safety-alerts.ts): the reminders of that report stop. Only this
 * POST from this site closes it, never opening the link, since mail scanners
 * open links. Nothing else changes: what was held stays held.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return new Response("Forbidden.", { status: 403 });
  let token = "";
  try {
    const form = await (await limited(request, 2_000)).formData();
    token = String(form.get("t") ?? "").slice(0, 96);
  } catch {
    token = "";
  }
  if (!TOKEN.test(token)) return new Response("Not found.", { status: 404 });
  if (!(await withinLimit("report-handled", clientAddress(request), 20, 600))) {
    return new Response("Too many requests. Try again in a few minutes.", { status: 429 });
  }
  const closed = await closeAlert(token);
  return new Response(null, {
    status: 303,
    headers: { Location: `${originFrom(request)}/report/handled/${token}?done=${closed === "closed" ? "1" : "0"}`, "Cache-Control": "no-store" },
  });
}
