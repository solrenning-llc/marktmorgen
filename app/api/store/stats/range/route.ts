import type { NextRequest } from "next/server";
import { jsonAccess } from "@/lib/studio-route";
import { rangeProblem, readRange } from "@/lib/stats";
import { productIds, readTitles } from "@/lib/catalog";
import { readMarks } from "@/lib/auto-marks";

/**
 * Any stretch of days the creator picks (lib/stats.ts, readRange):
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD`, as far back as the days are kept. For
 * whoever may see the numbers.
 *
 * A product is called gone only when the store's own index no longer lists
 * it. A listed product whose name could not be read is said to be so
 * (`titlesUnavailable`), and marks that could not be read are `null`, never an
 * empty list: unknown is never absence (VR2 audit, rule 24).
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "stats");
  if (access instanceof Response) return access;
  const store = access.store;
  const from = request.nextUrl.searchParams.get("from") ?? "";
  const to = request.nextUrl.searchParams.get("to") ?? "";
  const problem = rangeProblem(from, to);
  if (problem) return Response.json({ ok: false, error: problem }, { status: 400 });
  try {
    const [range, titles, marks] = await Promise.all([
      readRange(store, from, to, Date.now(), { fullDetails: request.nextUrl.searchParams.get("details") === "all" }),
      readTitles(store).catch((error: unknown) => {
        console.error("reading product names for a stretch of days failed", error);
        return null;
      }),
      readMarks(store, from, to).catch((error: unknown) => {
        console.error("reading the marks of a stretch of days failed", error);
        return null;
      }),
    ]);
    if (!range) return Response.json({ ok: false, error: "server_error" }, { status: 503 });
    const listed = new Set(productIds(store));
    let titlesUnavailable = false;
    const products = range.products.map((p) => {
      const title = titles?.get(p.id);
      if (title !== undefined) return { ...p, title };
      if (!listed.has(p.id)) return { ...p, title: "A product no longer in your store" };
      titlesUnavailable = true;
      return { ...p, title: "Title could not be loaded" };
    });
    return Response.json(
      { ok: true, range: { ...range, products }, marks, ...(titlesUnavailable ? { titlesUnavailable } : {}) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("reading a stretch of days failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 502 });
  }
}
