import type { NextRequest } from "next/server";
import { linkOrigin } from "@/lib/request-origin";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { readReport } from "@/lib/takedown-rules";
import { fileReport } from "@/lib/takedown";

/**
 * A notice about content on a store (app/report, lib/takedown.ts): the
 * form's fields as JSON. What is missing is said by name; a notice that is
 * whole is kept and sent to the support inbox. The sender is emailed nothing.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await (await limited(request, 16_000)).json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid report body");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  if (typeof body.website === "string" && body.website.trim()) return Response.json({ ok: true });
  const read = readReport(body);
  if (!read.ok) return Response.json({ ok: false, error: "problem", problem: read.problem }, { status: 400 });
  try {
    const result = await fileReport(read.report, clientAddress(request), linkOrigin(request));
    if (result === "sent") return Response.json({ ok: true });
    return Response.json({ ok: false, error: result }, { status: result === "limited" ? 429 : 503 });
  } catch (error) {
    console.error("filing a notice failed", error);
    return Response.json({ ok: false, error: "error" }, { status: 500 });
  }
}
