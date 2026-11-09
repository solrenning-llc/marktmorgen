import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { handleIn, readReport } from "@/lib/takedown-rules";
import { fileReport } from "@/lib/takedown";
import { type HoldOutcome, alertOwner, holdReported } from "@/lib/child-safety";
import { storeForHandle } from "@/lib/store";

/**
 * A notice about content on a store (app/report, lib/takedown.ts): the
 * form's fields as JSON. What is missing is said by name; a notice that is
 * whole is kept and sent to the support inbox. The sender is emailed nothing.
 * A child-safety report also takes the product it points at off the store at
 * once, and that and a request to remove an intimate image each send the
 * owner an urgent email with no content in it (lib/child-safety.ts).
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
    const result = await fileReport(read.report, clientAddress(request), originFrom(request));
    if (result !== "limited" && (read.report.kind === "child_safety" || read.report.kind === "intimate_image")) {
      const handle = handleIn(read.report.url);
      // A store that cannot be read is said as such, never as an address that names nothing.
      const store = read.report.kind === "child_safety" && handle ? await storeForHandle(handle).catch(() => undefined) : null;
      const outcome: HoldOutcome =
        read.report.kind !== "child_safety" ? "not_held" : store === undefined ? "unknown" : store ? await holdReported(read.report, store) : "no_product";
      await alertOwner(read.report, outcome, Date.now(), result === "sent");
    }
    if (result === "sent") return Response.json({ ok: true });
    return Response.json({ ok: false, error: result }, { status: result === "limited" ? 429 : 503 });
  } catch (error) {
    console.error("filing a notice failed", error);
    return Response.json({ ok: false, error: "error" }, { status: 500 });
  }
}
