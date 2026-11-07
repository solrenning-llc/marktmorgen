import type { NextRequest } from "next/server";
import { countStudio, creatorFrom, studioPath } from "@/lib/studio-route";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { keptCopy } from "@/lib/store-readings";
import { EARNINGS_FILE_NOTICES, earningsCsv, earningsFileName, earningsFromCopy } from "@/lib/earnings-csv";

/**
 * The twelve months of earnings as a CSV file (426 [BX2] unit 4;
 * lib/earnings-csv.ts): the months the earnings page last read and kept,
 * written out. It never reads Stripe or PayPal and never takes one of the
 * day's readings: one look at the kept copy (lib/store-readings.ts,
 * keptCopy). Whoever may see the store's numbers ("stats") may take it; it
 * holds no buyer's data. A download costs what a studio page costs,
 * STUDIO_PAGE_UNITS of the studio's requests: one taken by the guard on the
 * way in, the rest here before the copy is looked at.
 *
 * The download is a whole-page navigation (a GET form), so a refusal is never
 * a bare text page: it goes back to the earnings page with its own notice
 * (?file=none, ?file=unread; app/studio/earnings/page.tsx), and a used studio
 * figure goes where every studio page goes then (app/studio/paused).
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "stats");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  const back = (path: string) => new Response(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });

  const counted = await countStudio(store, null, STUDIO_PAGE_UNITS - 1);
  if (!counted.ok) return back(studioPath(store, `why=${counted.reason}`, "paused"));

  const copy = await keptCopy(store, "earnings");
  if (copy === undefined) return back(studioPath(store, `file=${EARNINGS_FILE_NOTICES.none}`, "earnings"));
  const earnings = copy ? earningsFromCopy(copy.value) : null;
  // A copy that is not exactly what the rule makes, or whose time is not its months' own, makes no file.
  if (!copy || !earnings || earnings.at !== copy.at) return back(studioPath(store, `file=${EARNINGS_FILE_NOTICES.unread}`, "earnings"));
  // The byte-order mark makes Excel read the file as UTF-8.
  return new Response(`﻿${earningsCsv(earnings)}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${earningsFileName(store.handle, earnings)}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
