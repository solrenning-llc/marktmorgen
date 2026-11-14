import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { withinLimit } from "@/lib/request-guard";
import { costPauseCode } from "@/lib/plan-standing";
import { isMapKind, readGuess, readHeader, suggestColumns } from "@/lib/csv-map-ai";

/**
 * An AI suggestion of which column is which, for the studio's import screen
 * (lib/csv-map-ai.ts). Only the owner and admins may (the "import"
 * permission, lib/team-roles.ts), as for the import itself.
 *
 *   POST { kind, header, guess }   header: the file's first row of names only;
 *                                  guess: the column the names gave each field, -1 for none
 *
 * Nothing is applied and nothing is kept: the screen shows each suggestion
 * and the creator confirms it, column by column. The model's most possible
 * cost is reserved in the store's monthly AI budget before it is asked
 * (askModel, lib/ai.ts). A store may ask a few times in ten minutes; a page
 * asks once per file.
 */
export const maxDuration = 30;

/** Names only: 500 names of 1,000 characters at the very most, as JSON. */
const MAX_BODY_BYTES = 24_000;

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "import", MAX_BODY_BYTES, () => "suggest");
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const refuse = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  // An unpaid renewal or a disputed plan payment stops what costs (lib/plan-standing.ts).
  const paused = costPauseCode(store);
  if (paused) return refuse(paused, 409);
  if (!isMapKind(body.kind)) return refuse("invalid");
  const header = readHeader(body.header);
  if (!header) return refuse("invalid");
  const guess = readGuess(body.kind, body.guess, header.length);
  if (!guess) return refuse("invalid");
  if (!(await withinLimit("import-columns", store.sid, 10, 600))) return refuse("slow", 429);
  try {
    const outcome = await suggestColumns(store, body.kind, header, guess);
    if (!outcome.ok) return Response.json({ ok: false, error: outcome.why }, { status: outcome.why === "failed" ? 502 : 200, headers: { "Cache-Control": "no-store" } });
    return Response.json({ ok: true, columns: outcome.columns }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("suggesting import columns failed", error);
    return refuse("server_error", 500);
  }
}
