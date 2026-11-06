import type { NextRequest } from "next/server";
import { countStudio, creatorFrom } from "@/lib/studio-route";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { keptCopy } from "@/lib/store-readings";
import { earningsCsv, earningsFileName, earningsFromCopy } from "@/lib/earnings-csv";

/**
 * The twelve months of earnings as a CSV file (426 [BX2] unit 4;
 * lib/earnings-csv.ts): the months the earnings page last read and kept,
 * written out. It never reads Stripe or PayPal and never takes one of the
 * day's readings: one look at the kept copy (lib/store-readings.ts,
 * keptCopy). Whoever may see the store's numbers ("stats") may take it; it
 * holds no buyer's data. A download costs what a studio page costs,
 * STUDIO_PAGE_UNITS of the studio's requests: one taken by the guard on the
 * way in, the rest here before the copy is looked at.
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "stats");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  const plain = (status: number, body: string) =>
    new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

  const counted = await countStudio(store, null, STUDIO_PAGE_UNITS - 1);
  if (!counted.ok) return plain(429, counted.message);

  const copy = await keptCopy(store, "earnings");
  if (copy === undefined) {
    return plain(409, "Open Earnings by month first. This file is made from the earnings read there, and none are kept for your store right now. Nothing was read from Stripe or PayPal.");
  }
  const earnings = copy ? earningsFromCopy(copy.value) : null;
  // A copy that is not exactly what the rule makes, or whose time is not its months' own, makes no file.
  if (!copy || !earnings || earnings.at !== copy.at) {
    return plain(503, "Your earnings could not be read just now, so no file was made. Nothing was read from Stripe or PayPal. Open Earnings by month and try again.");
  }
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
