import { windowId } from "@/lib/allowance-window";
import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { withinLimit, withinMonth } from "@/lib/request-guard";
import { importAllowanceFor } from "@/lib/import-limits";
import { costPauseCode } from "@/lib/plan-standing";
import { can } from "@/lib/team-roles";
import { MAX_TRIMMED_PAGE_CHARS, convertSavedPage } from "@/lib/clickfunnels-page";
import { planFunnelImport, saveFunnelImport } from "@/lib/clickfunnels-funnel";

/**
 * Moving a funnel from ClickFunnels (lib/clickfunnels-page.ts reads a page,
 * lib/clickfunnels-funnel.ts plans and makes the funnel), for the studio's
 * page /studio/import?what=clickfunnels. The owner and Admins only: it needs
 * the "import" permission, and planning or making a funnel the "page" and
 * "products" ones as well (lib/team-roles.ts).
 *
 *   POST { action: "page", file, html }   one saved page, read into blocks: nothing is saved
 *   POST { action: "plan", name, pages }  the dry run of the whole funnel: nothing is saved
 *   POST { action: "save", name, pages }  makes it, after the same plan, once
 *
 * The page's file is read on the creator's computer and trimmed there of
 * scripts and styles before it is sent (trimSavedPage); whatever arrives is
 * read here again, whole, within MAX_TRIMMED_PAGE_CHARS.
 */
export const maxDuration = 60;

/** A trimmed page as JSON, with room for escaping. */
const MAX_BODY_BYTES = MAX_TRIMMED_PAGE_CHARS * 2 + 10_000;

const refuse = (error: string, status = 400, extra: Record<string, unknown> = {}) => Response.json({ ok: false, error, ...extra }, { status });
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "import", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { store, body, role } = guarded;
  const action = text(body.action, 10);
  const who = store.sid || guarded.ref;
  // Each path has a calendar month's figure by plan (lib/import-limits.ts), the one each plan's
  // worst month counts (tests/plan-cost-registry.ts); the short windows only spread the work.
  const allowance = importAllowanceFor(store);
  // Nothing of a funnel migration runs while the plan's renewal is unpaid or a
  // payment for it is disputed (232 [CA1] unit 4b2, lib/plan-standing.ts).
  const paused = costPauseCode(store);
  if (paused) return refuse(paused, 409);

  try {
    if (action === "page") {
      // Sixty pages in ten minutes is several whole funnels, read and read again. Reading a page
      // touches no store record: the allowance bounds the work, not a bill.
      if (!(await withinLimit("import-cf-page", who, 60, 600))) return refuse("slow", 429);
      if (!(await withinMonth("import-cf-page-month", who, allowance.pageReads, windowId(store)))) return refuse("month", 429, { limit: allowance.pageReads });
      const html = typeof body.html === "string" ? body.html : "";
      if (!html.trim()) return refuse("empty");
      if (html.length > MAX_TRIMMED_PAGE_CHARS) return refuse("too_big", 413);
      const draft = convertSavedPage(html, text(body.file, 120));
      return Response.json({ ok: true, draft }, { headers: NO_STORE });
    }

    if (action === "plan" || action === "save") {
      if (!can(role, "page") || !can(role, "products")) return refuse("role", 403);
      // Each plan reads at most a few dozen records; each save writes ten pages at most. Both are
      // allowances of their own, checked before any work (docs/clickfunnels-import.md).
      if (action === "plan") {
        if (!(await withinLimit("import-cf-plan", who, 120, 600))) return refuse("slow", 429);
        if (!(await withinMonth("import-cf-plan-month", who, allowance.funnelChecks, windowId(store)))) return refuse("month", 429, { limit: allowance.funnelChecks });
      }
      if (action === "save") {
        if (!(await withinLimit("import-cf-save", who, 10, 86_400))) return refuse("slow", 429);
        if (!(await withinMonth("import-cf-save-month", who, allowance.funnelSaves, windowId(store)))) return refuse("month", 429, { limit: allowance.funnelSaves });
      }
      const input = { name: body.name, pages: body.pages };
      if (action === "plan") return Response.json({ ok: true, plan: await planFunnelImport(store, input) }, { headers: NO_STORE });
      const result = await saveFunnelImport(store, input);
      if (!result.ok) return refuse(result.reason, result.reason === "busy" || result.reason === "pages_changed" ? 409 : 400, { plan: result.plan });
      return Response.json({ ok: true, saved: result.saved, again: result.again, problems: result.problems }, { headers: NO_STORE });
    }

    return refuse("invalid");
  } catch (error) {
    console.error("a ClickFunnels funnel import failed", error);
    return refuse(action === "save" ? "setup_incomplete" : "server_error", 500);
  }
}
