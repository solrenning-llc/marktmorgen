import { windowId } from "@/lib/allowance-window";
import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { ensureStatsId } from "@/lib/store";
import { withinLimit, withinMonth } from "@/lib/request-guard";
import { IMPORTS_PAUSED, importAllowanceFor } from "@/lib/import-limits";
import { BATCH_BYTES } from "@/lib/imports";
import { costPauseCode } from "@/lib/plan-standing";
import { can } from "@/lib/team-roles";
import { HUBSPOT_MAX_CELL, HUBSPOT_MAX_COLUMNS, HUBSPOT_MAX_ROWS, type HubSpotFile, importHubSpotDeals } from "@/lib/hubspot-import";

/**
 * Moving deals from HubSpot (lib/hubspot-import.ts, the rules in
 * lib/hubspot-csv.ts), for the studio's import page. The owner and Admins
 * only: it needs the "import" permission, and the "orders" one that the
 * deals board needs (lib/team-roles.ts).
 *
 *   POST { action: "check", header, rows, lines?, currency? }  the dry run: nothing is written
 *   POST { action: "save",  header, rows, lines?, currency? }  brings the deals in, all or nothing
 *
 * The file is read into rows on the creator's computer (lib/csv.ts), as the
 * other imports' are; `currency` is the one the creator says the file's
 * amounts are in, when the file does not say: a three-letter code, or it is
 * taken as not said. A dry run counts as one of the
 * month's import checks, a save as one of its imports started and every row
 * it carries against the month's rows (lib/import-limits.ts).
 */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store" };

const WORDS = {
  rows: `The file could not be read. A file brought in here has up to ${HUBSPOT_MAX_ROWS.toLocaleString("en-US")} rows of up to ${HUBSPOT_MAX_COLUMNS} columns, each cell up to ${HUBSPOT_MAX_CELL.toLocaleString("en-US")} characters. Choose the file again, or split it in two.`,
  role: "Only the store's owner and Admins who can see orders can bring deals in. Ask the owner to do it, or to give you that role.",
  slow: "Too many files were brought in for now. Wait a few minutes, then try again.",
  month: "Your store has used all the imports its plan allows this billing month. Bring the file in when the next billing month starts.",
  invalid: "This request could not be read. Reload the page and try again.",
  unavailable: "Your deals could not be read just now, so nothing was brought in. Try again in a minute.",
  server_error: "Something went wrong, and nothing was brought in. Try again in a minute.",
};

const refuse = (error: string, message: string, status = 400, extra: Record<string, unknown> = {}) => Response.json({ ok: false, error, message, ...extra }, { status, headers: NO_STORE });

/** The file as sent, whole, or null: a cell too long or a row too wide refuses it, never cut. */
function readFile(body: Record<string, unknown>): HubSpotFile | null {
  const cells = (value: unknown): string[] | null =>
    Array.isArray(value) && value.length <= HUBSPOT_MAX_COLUMNS && value.every((cell) => typeof cell === "string" && cell.length <= HUBSPOT_MAX_CELL) ? (value as string[]) : null;
  const header = cells(body.header);
  if (!header || !header.length || !Array.isArray(body.rows) || body.rows.length > HUBSPOT_MAX_ROWS) return null;
  const rows: string[][] = [];
  for (const row of body.rows) {
    const read = cells(row);
    if (!read) return null;
    rows.push(read);
  }
  if (body.lines === undefined) return { header, rows };
  const lines = body.lines;
  if (!Array.isArray(lines) || lines.length !== rows.length || !lines.every((n) => Number.isSafeInteger(n) && n > 1)) return null;
  return { header, rows, lines: lines as number[] };
}

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "import", BATCH_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, role } = guarded;
  const action = text(body.action, 10);
  if (action !== "check" && action !== "save") return refuse("invalid", WORDS.invalid);
  if (!can(role, "orders")) return refuse("role", WORDS.role, 403);
  // Nothing of an import runs while the plan's renewal is unpaid or a payment
  // for it is disputed (232 [CA1] unit 4b2, lib/plan-standing.ts).
  const paused = costPauseCode(guarded.store);
  if (paused) return refuse(paused, IMPORTS_PAUSED[paused], 409);
  const file = readFile(body);
  if (!file) return refuse("rows", WORDS.rows);

  try {
    const store = guarded.store.statsId ? guarded.store : await ensureStatsId(guarded.ref);
    if (!store?.statsId) return refuse("unavailable", WORDS.unavailable, 503);
    const who = store.sid || guarded.ref;
    const allowance = importAllowanceFor(store);
    // The same figures as the other imports: a dry run is one of the month's
    // checks, a save one of its imports started (lib/import-limits.ts).
    if (action === "check") {
      if (!(await withinLimit("import-preview", who, 400, 600))) return refuse("slow", WORDS.slow, 429);
      if (!(await withinMonth("import-preview-month", who, allowance.checks, windowId(store)))) return refuse("checks_month", WORDS.month, 429, { limit: allowance.checks });
    } else {
      if (!(await withinLimit("import-start", who, 20, 86_400))) return refuse("slow", WORDS.slow, 429);
      if (!(await withinMonth("import-start-month", who, allowance.starts, windowId(store)))) return refuse("starts_month", WORDS.month, 429, { limit: allowance.starts });
    }
    const bytes = Buffer.byteLength(JSON.stringify({ header: file.header, rows: file.rows }));
    const result = await importHubSpotDeals(store, file, { write: action === "save", statedCurrency: typeof body.currency === "string" && /^[A-Za-z]{3}$/.test(body.currency) ? body.currency : "", bytes });
    if (!result.ok) {
      const status = result.reason === "busy" || result.reason === "changed" || result.reason === "store_full" || result.reason === "deals_full" ? 409 : result.reason === "rows_month" ? 429 : result.reason === "unavailable" ? 503 : result.reason === "unconfirmed" ? 502 : 400;
      return refuse(result.reason, result.message, status, result.limit === undefined ? {} : { limit: result.limit });
    }
    return Response.json({ ok: true, summary: result.summary }, { headers: NO_STORE });
  } catch (error) {
    console.error("a HubSpot deals import failed", error);
    return refuse("server_error", WORDS.server_error, 500);
  }
}
