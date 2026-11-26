import type { NextRequest } from "next/server";
import { creatorFrom } from "@/lib/studio-route";
import { SALE_FEES_FILE_MAX_BYTES, keptSaleFeesCopy } from "@/lib/sale-fees-reading";
import { saleFeesCsv } from "@/lib/sale-fees-months";
import { saleFees } from "@/lib/sale-fees-rules";
import { FILE_TOO_LARGE_WORDS, NO_COPY_WORDS, exportReachRefusal, stateWords, unavailableWords } from "@/lib/sale-fees-view";
import { readingSince } from "@/lib/earnings-by-month";

/**
 * Every sale's fees and what the creator kept, as a spreadsheet (282 [HG1],
 * unit 3; lib/sale-fees-months.ts, saleFeesCsv), from the same reading of the
 * creator's own Stripe account as the page (lib/sale-fees-reading.ts): only
 * the copy the page kept (keptSaleFeesCopy), never a new reading, so the file
 * is what the page showed and the download never calls Stripe. It names no buyer; it is the owner's only
 * ("payments"), as the page: each sale's net and charge id (audit 9c68). Dates in UTC. A reading that is not
 * whole gives no file: a part would look like the whole.
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "payments");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  const plain = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  // Only the copy the page kept: the file is the reading the page showed, never a new one (audit 8834 follow-up).
  const state = await keptSaleFeesCopy(store);
  if (state.kind === "failed") return plain(503, stateWords(state));
  if (state.kind === "none") return plain(409, NO_COPY_WORDS);
  // A reading that stopped before the year's first month gives no file: it would look like the whole year (audit 1285).
  const short = exportReachRefusal(state.kept.since, readingSince(state.kept.at, "UTC"));
  if (short !== null) return plain(409, short);
  const report = saleFees(state.kept.lines, { complete: true });
  // Every row says when the reading was taken, so a file from a copy kept before a failed or refused reading says it
  // too, inside the file, and every file is the same table (audits 2fb6, 0861).
  const csv = saleFeesCsv(report, "UTC", state.kept.at);
  if (csv === null) return plain(503, unavailableWords(report.available ? "incomplete" : report.why));
  // Never larger than what the download is priced to send (SALE_FEES_FILE_MAX_BYTES; audit 2fb6).
  if (Buffer.byteLength(csv, "utf8") + 4 > SALE_FEES_FILE_MAX_BYTES) return plain(503, FILE_TOO_LARGE_WORDS);
  const day = new Date(state.kept.at).toISOString().slice(0, 10);
  // The byte-order mark makes Excel read the file as UTF-8.
  return new Response(`﻿${csv}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="fees-${store.handle}-${day}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
