import type { NextRequest } from "next/server";
import { creatorFrom } from "@/lib/studio-route";
import { keptSaleFees } from "@/lib/sale-fees-reading";
import { saleFeesCsv } from "@/lib/sale-fees-months";
import { saleFees } from "@/lib/sale-fees-rules";
import { stateWords, unavailableWords } from "@/lib/sale-fees-view";

/**
 * Every sale's fees and what the creator kept, as a spreadsheet (282 [HG1],
 * unit 3; lib/sale-fees-months.ts, saleFeesCsv), from the same reading of the
 * creator's own Stripe account as the page (lib/sale-fees-reading.ts): the
 * kept copy while it is fresh, otherwise one of the day's readings, taken
 * before Stripe is called. It names no buyer, so whoever may see the store's
 * numbers ("stats") may download it. Dates in UTC. A reading that is not
 * whole gives no file: a part would look like the whole.
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "stats");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  const plain = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  const state = await keptSaleFees(store);
  if (state.kind !== "read") return plain(state.kind === "used" ? 429 : state.kind === "failed" ? 503 : 409, stateWords(state));
  const report = saleFees(state.kept.lines, { complete: true });
  const csv = saleFeesCsv(report, "UTC");
  if (csv === null) return plain(503, unavailableWords(report.available ? "incomplete" : report.why));
  const day = new Date(state.kept.at).toISOString().slice(0, 10);
  // The byte-order mark makes Excel read the file as UTF-8.
  return new Response(`﻿${csv}\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="fees-${store.handle}-${day}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
