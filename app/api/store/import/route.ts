import { windowId } from "@/lib/allowance-window";
import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { jsonAccess } from "@/lib/studio-route";
import { contentDisposition, withinLimit, withinMonth } from "@/lib/request-guard";
import { importAllowanceFor } from "@/lib/import-limits";
import { costPauseCode } from "@/lib/plan-standing";
import {
  BATCH_BYTES,
  IMPORT_ID_PATTERN,
  type ImportJob,
  type ImportKind,
  addRows,
  cancelImport,
  finishUpload,
  jobOf,
  previewImport,
  readBatch,
  reportCsv,
  runImport,
  startImport,
  storeImports,
  takeImportRows,
} from "@/lib/imports";

/**
 * Moving from another platform (lib/imports.ts), for the studio's page
 * /studio/import. Only the owner and admins may (the "import" permission,
 * lib/team-roles.ts).
 *
 *   GET  ?id=<import>                    how it stands
 *   GET  ?id=<import>&report=1           what was not brought in, as a spreadsheet
 *   POST { action: "preview", kind, source, expected, agreed, consentColumn, tags, email, rows }
 *                                        the dry run of one batch: nothing is written
 *   POST { action: "start", kind, source, expected, file, agreed, consentColumn, tags, email }
 *   POST { action: "rows", id, rows }    one batch of up to 1,000 rows
 *   POST { action: "finish", id }        every row is sent
 *   POST { action: "step", id }          a few seconds of work, while the page is open
 *   POST { action: "cancel", id }
 *
 * The page advances an import while it is open; the job every five minutes
 * finishes what is left (app/api/cron/imports). Each step and each batch is
 * counted per store, so a script cannot keep either busy.
 */
export const maxDuration = 60;

/** How long one step from the page may work. */
const STEP_MS = 8_000;

const KINDS = new Set<ImportKind>(["contacts", "products", "purchases", "members"]);

/** What the studio sent about how an import is to be read, for its start and its dry run. */
function startInput(body: Record<string, unknown>) {
  return {
    expected: Number(body.expected),
    file: text(body.file, 200),
    agreed: body.agreed === true,
    consentColumn: body.consentColumn === true,
    tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string").slice(0, 10) : [],
    email: body.email === true,
    stopped: body.stopped === true,
    dateOrder: text(body.dateOrder, 3),
    source: body.source === "clickfunnels" ? ("clickfunnels" as const) : ("csv" as const),
  };
}

/** What the page is told about an import: nothing it does not show. */
function view(job: ImportJob) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    file: job.file,
    at: job.at,
    finishedAt: job.finishedAt,
    expected: job.expected,
    total: job.total,
    done: job.done,
    counts: { ...job.counts, contacts: job.counts.contacts ?? 0, stopped: job.counts.stopped ?? 0 },
    email: job.options.email,
    source: job.options.source ?? "csv",
  };
}

export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "import");
  if (access instanceof Response) return access;
  const { store } = access;
  const id = request.nextUrl.searchParams.get("id") ?? "";
  try {
    if (!id) {
      const jobs = await storeImports(store);
      return Response.json({ ok: true, imports: jobs.map(view) }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (!IMPORT_ID_PATTERN.test(id)) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    const job = await jobOf(store, id);
    if (!job) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    if (request.nextUrl.searchParams.get("report") === "1") {
      if (!(await withinLimit("import-report", store.sid, 60, 600))) return new Response("Too many downloads for now. Try again in a few minutes.", { status: 429 });
      if (!(await withinMonth("import-report-month", store.sid, importAllowanceFor(store).reports, windowId(store)))) return new Response("Your store has downloaded all the import reports its figure allows for now.", { status: 429 });
      const csv = await reportCsv(job);
      const day = new Date(job.at).toISOString().slice(0, 10);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": contentDisposition("attachment", `${store.handle}-import-${job.kind}-${day}-not-imported.csv`),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return Response.json({ ok: true, import: view(job) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("reading an import failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "import", BATCH_BYTES);
  if (!guarded.ok) return guarded.response;
  const { store, body, email } = guarded;
  const action = text(body.action, 10);
  const id = text(body.id, 24);
  const refuse = (error: string, status = 400, extra: Record<string, unknown> = {}) => Response.json({ ok: false, error, ...extra }, { status });
  // While the plan's renewal is unpaid or a payment for it is disputed, an
  // import does not start, check or move on (232 [CA1] unit 4b2,
  // lib/plan-standing.ts costPauseCode); one already started keeps its place
  // (lib/imports.ts runImport). An upload already under way may still send
  // its rows and finish, so it is queued rather than lost; they count against
  // the month's rows as always, and nothing is applied until it is paid.
  // Canceling, reading where one stands and the report stay open.
  const paused = action === "start" || action === "preview" || action === "step" ? costPauseCode(store) : null;
  if (paused) return refuse(paused, 409);

  try {
    if (action === "start") {
      const kind = text(body.kind, 12) as ImportKind;
      if (!KINDS.has(kind)) return refuse("invalid");
      // Twenty imports a day is far more than moving a store takes.
      if (!(await withinLimit("import-start", store.sid || guarded.ref, 20, 86_400))) return refuse("slow", 429);
      const starts = importAllowanceFor(store).starts;
      if (!(await withinMonth("import-start-month", store.sid || guarded.ref, starts, windowId(store)))) return refuse("starts_month", 429, { limit: starts });
      const started = await startImport(store, email, kind, startInput(body));
      if (!started.ok) return refuse(started.reason, started.reason === "busy" ? 409 : 400, { limit: started.limit });
      return Response.json({ ok: true, import: view(started.job) });
    }

    if (action === "preview") {
      const kind = text(body.kind, 12) as ImportKind;
      if (!KINDS.has(kind)) return refuse("invalid");
      // A batch of contacts or products costs two reads; one of past buyers reads every product it
      // names, so those have a smaller allowance. Each has a calendar month's figure by plan
      // (lib/import-limits.ts), the one each plan's worst month counts (tests/plan-cost-registry.ts).
      const who = store.sid || guarded.ref;
      const buyers = kind === "purchases";
      const allowance = importAllowanceFor(store);
      if (!(await withinLimit("import-preview", who, 400, 600))) return refuse("slow", 429);
      if (!(await withinMonth(buyers ? "import-preview-buyers-month" : "import-preview-month", who, buyers ? allowance.buyerChecks : allowance.checks, windowId(store)))) {
        return refuse("checks_month", 429, { limit: buyers ? allowance.buyerChecks : allowance.checks });
      }
      const rows = readBatch(kind, body.rows);
      if (!rows) return refuse("rows");
      const preview = await previewImport(store, kind, startInput(body), rows);
      if (!preview.ok) return refuse(preview.reason, 400, { limit: preview.limit });
      return Response.json({ ok: true, rows: preview.rows, room: preview.room }, { headers: { "Cache-Control": "private, no-store" } });
    }

    if (!IMPORT_ID_PATTERN.test(id)) return refuse("unknown", 404);

    if (action === "rows") {
      // Fifty batches carry the biggest import; four hundred in ten minutes is room for retries.
      if (!(await withinLimit("import-rows", store.sid || guarded.ref, 400, 600))) return refuse("slow", 429);
      const job = await jobOf(store, id);
      if (!job) return refuse("unknown", 404);
      const rows = readBatch(job.kind, body.rows);
      if (!rows) return refuse("rows");
      // Counted as they arrive, against the plan's rows for the month (lib/import-limits.ts).
      const took = await takeImportRows(store, rows.length, Date.now(), Buffer.byteLength(JSON.stringify(rows)));
      if (!took.ok) return refuse(took.reason, took.reason === "unavailable" ? 503 : 429, { limit: took.limit });
      const added = await addRows(store, id, rows);
      return added.ok ? Response.json({ ok: true, import: view(added.job) }) : refuse(added.reason, 409);
    }

    if (action === "finish") {
      const done = await finishUpload(store, id);
      if (!done.ok) return refuse(done.reason, 409);
      // The first few seconds of work right away, so a small file is done
      // by the time the page shows it; past the month's steps the five-minute job does it.
      // Queued and left while the plan's costs are paused: no step is spent on it (unit 4b2).
      if (costPauseCode(store)) return Response.json({ ok: true, import: view(done.job) });
      if (!(await withinMonth("import-step-month", store.sid || guarded.ref, importAllowanceFor(store).steps, windowId(store)))) return Response.json({ ok: true, import: view(done.job) });
      const after = await runImport(id, Date.now() + STEP_MS);
      return Response.json({ ok: true, import: view(after ?? done.job) });
    }

    if (action === "step") {
      if (!(await withinLimit("import-step", store.sid || guarded.ref, 900, 600))) return refuse("slow", 429);
      const job = await jobOf(store, id);
      if (!job) return refuse("unknown", 404);
      // Past the month's steps the page stops pushing; the five-minute job finishes every import.
      if (!(await withinMonth("import-step-month", store.sid || guarded.ref, importAllowanceFor(store).steps, windowId(store)))) return Response.json({ ok: true, import: view(job) });
      const after = await runImport(id, Date.now() + STEP_MS);
      return Response.json({ ok: true, import: view(after ?? job) });
    }

    if (action === "cancel") {
      const job = await cancelImport(store, id);
      return job ? Response.json({ ok: true, import: view(job) }) : refuse("unknown", 404);
    }

    return refuse("invalid");
  } catch (error) {
    console.error("an import request failed", error);
    return refuse("server_error", 500);
  }
}
