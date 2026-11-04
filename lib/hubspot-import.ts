/**
 * Moving from HubSpot, the deals half on the server (639 [GL7](10), unit 2,
 * added 4 November 2026): a deals file HubSpot exported, read by the rules
 * of lib/hubspot-csv.ts, made into the store's own pipelines, stages and
 * deals (lib/crm.ts). No screen yet; the route is
 * app/api/store/import/hubspot.
 *
 * What it keeps to:
 *
 *   - Nothing that exists is renamed, moved or deleted. A pipeline of the
 *     file whose name the store already uses (any case) is that pipeline; a
 *     stage likewise, within its pipeline; a deal with no pipeline in the
 *     file goes to the store's first pipeline, whatever its name. A file's
 *     won or lost stage with no stage of that name goes to the pipeline's
 *     own won or lost stage, and the summary says so. Only the open stages
 *     and pipelines the store does not have are made, within the plan's
 *     pipelines (pipelineLimit) and MAX_STAGES a pipeline, and only for the
 *     deals that will come in: the rows refused or already here are set
 *     aside first, so they never take a pipeline's place. A deal past them
 *     is refused with what to do.
 *   - Never twice: each deal's id here is worked out from HubSpot's Record
 *     ID (hubSpotDealId), and its note says "From HubSpot, Record ID X." A
 *     deal whose id is here and whose note says so is already here: listed
 *     by row and name, never added again nor overwritten, whatever the
 *     creator changed on it since. One whose id is here but whose note does
 *     not say so is refused with a sentence, never taken for the same deal.
 *     Two HubSpot accounts can use the same Record ID for different deals:
 *     the list of deals already here, with the name each has here, is how
 *     the creator sees that. A deal the creator deleted here comes back if
 *     the file is brought in again, as with every other import.
 *   - The close date has no field of its own here (a deal's due date is the
 *     creator's next follow-up), so it goes in the note: "Closed on
 *     YYYY-MM-DD (from HubSpot)." for a won or lost deal, "Expected to close
 *     on ..." for an open one, as HubSpot's own close date means for those.
 *   - Whole or nothing: a file with more new deals than the store has room
 *     for (MAX_DEALS), past the store's data room, or past the month's rows
 *     an import may bring in (lib/import-limits.ts, takeImportRows) is
 *     refused whole and nothing is written: the room is taken first, then
 *     the rows, then the pipelines and every deal are written in one step
 *     (lib/crm.ts, IMPORT_CRM_DEALS). When that step writes nothing (the
 *     pipelines changed, a deal's id was taken, the store filled up, or the
 *     lock ran out or could not be confirmed, so the step was never sent),
 *     the room and the rows go back. When whether it wrote
 *     cannot be confirmed, both stay counted, as for what was written.
 *   - One import of deals or change of pipelines at a time per store, under
 *     the store's CRM lock (lib/crm.ts, takeCrmLock): every change of
 *     pipelines or stages on the board takes it too, so the board never
 *     removes a stage from deals it read before an import wrote some there.
 *     The next one waits a moment, then is refused. A single deal saved on
 *     the board does not take the lock: the one step writes only over the
 *     pipelines record read before, and only when every deal's id is still
 *     free and every deal fits; otherwise nothing is written.
 *   - No workflow starts: a deal brought in from a file is not a deal
 *     entering a stage (lib/deal-stage-trigger.ts), so nobody is emailed.
 *
 * A deal keeps the first address in its associated-contacts column, when
 * the column has one; deleting that person deletes the deal, as every deal
 * (lib/crm.ts, forgetCrmPerson).
 */
import { createHash } from "node:crypto";
import { CrmDealReadUnavailable, CrmDealWriteUnconfirmed, CrmDealsFull, CrmLockLost, CrmSchemaConflict, CrmSchemaReadUnavailable, CrmSchemaWriteUnconfirmed, importRoom, importSnapshot, readDealMarks, takeCrmLock, writeImport } from "@/lib/crm";
import { type Deal, type Pipeline, type Stage, MAX_DEALS, MAX_PIPELINES, MAX_STAGES, allStages, newCrmId, parseDeal, parsePipelines, pipelineLimit } from "@/lib/crm-rules";
import { HUBSPOT_LABELS, type HubSpotDealDraft, type HubSpotRefusal, STAGE_PAST_REASON, hubSpotDealColumns, hubSpotFileOf, oneLine, pipelineRoomReason, planHubSpotDeals, tooManyDealsSentence } from "@/lib/hubspot-csv";
import { giveImportRows, takeImportRows } from "@/lib/imports";
import { rowsWords } from "@/lib/import-limits";
import { type Held, LockBusyError, releaseLock } from "@/lib/redis-lock";
import { DataRoomError, giveData, needData } from "@/lib/store-data";
import type { Store } from "@/lib/store";

/** The rows a file sent here may have, the header apart: twice what a store holds, for the rows refused or already there. */
export const HUBSPOT_MAX_ROWS = MAX_DEALS * 2;
/** The columns a row may have. */
export const HUBSPOT_MAX_COLUMNS = 200;
/** The longest cell taken as it arrives; one longer refuses the file (nothing is cut). */
export const HUBSPOT_MAX_CELL = 2_000;

/** A HubSpot Record ID as it is kept: letters and digits (HubSpot's are digits). */
const RECORD_ID = /^[0-9A-Za-z_-]{1,40}$/;
const ID_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A deal's id here for a HubSpot Record ID: always the same one, so a deal brought in twice is found. */
export function hubSpotDealId(recordId: string): string {
  const digest = createHash("sha256").update(`hubspot-deal:${recordId}`).digest();
  let id = "";
  for (let i = 0; id.length < 10; i += 1) id += ID_LETTERS[digest[i] % ID_LETTERS.length];
  return id;
}

/** The note a deal brought in from HubSpot carries. */
export function hubSpotDealNote(recordId: string, closeDate: string | null, closed: boolean): string {
  const lines = [`From HubSpot, Record ID ${recordId}.`];
  if (closeDate) lines.push(closed ? `Closed on ${closeDate} (from HubSpot).` : `Expected to close on ${closeDate} (from HubSpot).`);
  return lines.join("\n");
}

export type HubSpotFile = { header: string[]; rows: string[][]; lines?: number[] };

export type HubSpotImportSummary = {
  /** False for a dry run: nothing was written. */
  written: boolean;
  pipelinesCreated: { name: string; stages: string[] }[];
  /** Open stages made in a pipeline the store already had. */
  stagesCreated: { pipeline: string; stage: string }[];
  /** A won or lost stage of the file that went to the pipeline's own won or lost stage. */
  stagesJoined: { pipeline: string; from: string; to: string }[];
  added: number;
  alreadyThere: number;
  /** Each deal already here: its row, its name in the file and its name here. */
  alreadyThereDeals: { line: number; title: string; here: string }[];
  refused: HubSpotRefusal[];
  /** What a deal came in without (an amount, a close date, a second person), and why. */
  notices: { line: number; note: string }[];
  ignored: string[];
};

export type HubSpotImportRefusal =
  | "not_hubspot"
  | "no_record_id"
  | "too_many"
  | "deals_full"
  | "busy"
  | "lock_lost"
  | "changed"
  | "store_full"
  | "rows_month"
  | "unavailable"
  | "unconfirmed";

export type HubSpotImportResult = { ok: true; summary: HubSpotImportSummary } | { ok: false; reason: HubSpotImportRefusal; message: string; limit?: number };

/** What each refusal says, with what to do. */
export const HUBSPOT_IMPORT_WORDS: Record<Exclude<HubSpotImportRefusal, "too_many" | "store_full" | "rows_month">, string> = {
  deals_full: `Your store reached its ${MAX_DEALS.toLocaleString("en-US")} deals while this file was being brought in, so nothing was brought in. Delete deals you no longer need, then bring the file in again.`,
  not_hubspot:
    'This is not a deals file exported from HubSpot with English column names. In HubSpot, export your deals list, choose English under "Language of column headers", then bring that file in.',
  no_record_id:
    "This deals file has no Record ID column, so deals brought in from it could be brought in twice. In HubSpot, export your deals list with all properties, so the file has the Record ID column, then bring that file in.",
  // The lock is taken by another import and by every change of pipelines on the board: the sentence names neither.
  busy: "Your deals or pipelines are being changed right now, so nothing was brought in. Wait a moment, then bring the file in again.",
  lock_lost: "Saving could not start in time, so nothing was brought in. Bring the file in again.",
  changed: "Your pipelines changed while this file was being brought in, so nothing was brought in. Bring the file in again.",
  unavailable: "Your deals could not be read just now, so nothing was brought in. Try again in a minute.",
  unconfirmed: "Saving could not be confirmed. Bring the same file in again: deals already here are never added twice.",
};

const refuse = (reason: HubSpotImportRefusal, message: string, limit?: number): HubSpotImportResult => ({ ok: false, reason, message, ...(limit === undefined ? {} : { limit }) });

type Planned = { summary: HubSpotImportSummary; pipelines: Pipeline[] | null; deals: Deal[] };

/** A fresh id no taken one has. */
function freshId(taken: Set<string>): string {
  for (;;) {
    const id = newCrmId();
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}


type DealsPlan = Extract<ReturnType<typeof planHubSpotDeals>, { ok: true }>;

/** The line a deal brought in from HubSpot Record ID `recordId` carries in its note. */
const fromLine = (recordId: string) => `From HubSpot, Record ID ${recordId}.`;

/**
 * The file's plan against the store as it stands: first the rows set aside
 * (no or unreadable Record ID, already here, or another deal's place), then
 * the pipelines and stages for the deals left only, then those deals. The
 * pipelines after the import are null when none changes. Pure but for the
 * ids it makes.
 */
function planAgainst(
  store: Store,
  plan: DealsPlan,
  snapshot: { pipelines: Pipeline[]; dealIds: Set<string> },
  marks: Map<string, { title: string; note: string }>,
  nowSeconds: number,
): Planned {
  const refused: HubSpotRefusal[] = [...plan.refused];
  const alreadyThereDeals: HubSpotImportSummary["alreadyThereDeals"] = [];
  const coming: (HubSpotDealDraft & { id: string })[] = [];
  for (const draft of plan.deals) {
    if (!draft.recordId) {
      refused.push({ line: draft.line, column: HUBSPOT_LABELS.recordId, value: "", reason: "This deal has no Record ID, so bringing the file in again would add it twice. Export the deals from HubSpot again with the Record ID column filled in, then bring that file in." });
      continue;
    }
    if (!RECORD_ID.test(draft.recordId)) {
      refused.push({ line: draft.line, column: HUBSPOT_LABELS.recordId, value: draft.recordId, reason: "This Record ID is not one HubSpot writes (letters and digits, up to 40), so the deal was not brought in. Export the deals from HubSpot again, then bring that file in." });
      continue;
    }
    const id = hubSpotDealId(draft.recordId);
    if (snapshot.dealIds.has(id)) {
      const mark = marks.get(id);
      if (mark && mark.note.split("\n").includes(fromLine(draft.recordId))) alreadyThereDeals.push({ line: draft.line, title: draft.title, here: mark.title });
      else
        refused.push({
          line: draft.line,
          column: HUBSPOT_LABELS.recordId,
          value: draft.recordId,
          reason: `A deal here already holds the place of HubSpot Record ID ${draft.recordId}, but its note does not say it came from that record, so this row was not brought in. If that deal is this one, there is nothing to do. If not, open it on your deals board and check its note, then bring the file in again.`,
        });
      continue;
    }
    coming.push({ ...draft, id });
  }

  // Pipelines and stages only for the deals that will come in, in the file's order.
  const limit = Math.min(pipelineLimit(store, nowSeconds), MAX_PIPELINES);
  const pipelineRoom = Math.max(0, limit - snapshot.pipelines.length);
  const next: Pipeline[] = snapshot.pipelines.map((p) => ({ ...p, stages: [...p.stages] }));
  const pipeIds = new Set(next.map((p) => p.id));
  const stageIds = new Set(allStages(next).map((s) => s.id));
  const usedLabels = new Map<string, Set<string>>();
  for (const draft of coming) {
    const key = draft.pipeline.toLowerCase();
    if (!usedLabels.has(key)) usedLabels.set(key, new Set());
    usedLabels.get(key)!.add(draft.stage.toLowerCase());
  }
  /** By pipeline name (lower case), each file stage's label (lower case) to the stage it goes to; null for a pipeline past the plan's. */
  const route = new Map<string, Map<string, string> | null>();
  const pipelinesCreated: HubSpotImportSummary["pipelinesCreated"] = [];
  const stagesCreated: HubSpotImportSummary["stagesCreated"] = [];
  const stagesJoined: HubSpotImportSummary["stagesJoined"] = [];
  let made = 0;
  for (const proposed of plan.pipelines) {
    const key = proposed.name.toLowerCase();
    const used = usedLabels.get(key);
    if (!used) continue;
    const map = new Map<string, string>();
    const existing = next.find((p) => p.name.toLowerCase() === key);
    if (existing) {
      for (const stage of proposed.stages.filter((s) => s.fromFile && used.has(s.name.toLowerCase()))) {
        const label = stage.name.toLowerCase();
        const same = existing.stages.find((s) => s.name.toLowerCase() === label);
        if (same) map.set(label, same.id);
        else if (stage.kind !== "open") {
          const own = existing.stages.find((s) => s.kind === stage.kind) as Stage;
          map.set(label, own.id);
          stagesJoined.push({ pipeline: existing.name, from: stage.name, to: own.name });
        } else if (existing.stages.length < MAX_STAGES) {
          const added: Stage = { id: freshId(stageIds), name: stage.name, kind: "open" };
          // After the pipeline's last open stage, before its won and lost ones.
          let at = 0;
          existing.stages.forEach((s, i) => { if (s.kind === "open") at = i + 1; });
          existing.stages.splice(at, 0, added);
          map.set(label, added.id);
          stagesCreated.push({ pipeline: existing.name, stage: stage.name });
        }
      }
    } else if (made < pipelineRoom) {
      made += 1;
      // Its open stages that deals come into, and its won and lost ones, as the file names them.
      const stages = proposed.stages.filter((s) => s.kind !== "open" || !s.fromFile || used.has(s.name.toLowerCase()));
      // A pipeline here always has an open stage, even when every deal coming into it is closed.
      if (!stages.some((s) => s.kind === "open")) stages.unshift(proposed.stages.find((s) => s.kind === "open") ?? { name: "New", kind: "open", fromFile: false });
      const pipeline: Pipeline = { id: freshId(pipeIds), name: proposed.name, stages: stages.map((s) => ({ id: freshId(stageIds), name: s.name, kind: s.kind })) };
      next.push(pipeline);
      stages.forEach((s, i) => { if (s.fromFile) map.set(s.name.toLowerCase(), pipeline.stages[i].id); });
      pipelinesCreated.push({ name: pipeline.name, stages: pipeline.stages.map((s) => s.name) });
    } else {
      route.set(key, null);
      continue;
    }
    route.set(key, map);
  }

  const stages = allStages(next);
  const deals: Deal[] = [];
  const notices: HubSpotImportSummary["notices"] = [];
  for (const draft of coming) {
    const map = route.get(draft.pipeline.toLowerCase());
    if (!map) {
      refused.push({ line: draft.line, column: HUBSPOT_LABELS.deals.pipeline, value: draft.pipeline, reason: pipelineRoomReason(pipelineRoom) });
      continue;
    }
    const stage = map.get(draft.stage.toLowerCase());
    if (!stage) {
      refused.push({ line: draft.line, column: HUBSPOT_LABELS.deals.stage, value: draft.stage, reason: STAGE_PAST_REASON });
      continue;
    }
    const closed = stages.find((s) => s.id === stage)?.kind !== "open";
    const deal = parseDeal({ id: draft.id, title: draft.title, email: draft.email, cents: draft.cents ?? 0, stage, note: hubSpotDealNote(draft.recordId, draft.closeDate, closed), createdAt: nowSeconds, updatedAt: nowSeconds }, stages);
    if (!deal) {
      refused.push({ line: draft.line, column: HUBSPOT_LABELS.deals.title, value: draft.title, reason: "This deal could not be read. Check its name and stage in HubSpot, then export again." });
      continue;
    }
    deals.push(deal);
    for (const note of [draft.amountNote, draft.closeDateNote, draft.emailNote]) if (note) notices.push({ line: draft.line, note });
  }
  refused.sort((a, b) => a.line - b.line);

  const changed = pipelinesCreated.length > 0 || stagesCreated.length > 0;
  const checked = changed ? parsePipelines(next) : null;
  if (changed && !checked) throw new CrmSchemaReadUnavailable();
  return {
    summary: { written: false, pipelinesCreated, stagesCreated, stagesJoined, added: deals.length, alreadyThere: alreadyThereDeals.length, alreadyThereDeals, refused, notices, ignored: plan.ignored },
    pipelines: checked,
    deals,
  };
}

/**
 * Brings a HubSpot deals file into the store's CRM, or, with `write` false,
 * says what it would do (the dry run: nothing is written, no lock, no rows
 * counted). `bytes` is what the request carried, counted with the rows.
 */
export async function importHubSpotDeals(store: Store, file: HubSpotFile, options: { write: boolean; statedCurrency?: string; bytes?: number; now?: number }): Promise<HubSpotImportResult> {
  const now = options.now ?? Date.now();
  const nowSeconds = Math.floor(now / 1000);
  if (hubSpotFileOf(file.header) !== "deals") {
    const columns = hubSpotDealColumns(file.header);
    if (columns.title >= 0 && columns.stage >= 0 && columns.recordId < 0) return refuse("no_record_id", HUBSPOT_IMPORT_WORDS.no_record_id);
    return refuse("not_hubspot", HUBSPOT_IMPORT_WORDS.not_hubspot);
  }
  const statsId = store.statsId;
  if (!statsId) return refuse("unavailable", HUBSPOT_IMPORT_WORDS.unavailable);

  let held: Held | null = null;
  let counted = 0;
  try {
    if (options.write) held = await takeCrmLock(statsId);
    const snapshot = await importSnapshot(statsId);
    // The file's pipelines may be as many as a store holds, less the store's own ones the file does not name.
    const firstPipeline = snapshot.pipelines[0].name;
    const pipelineAt = hubSpotDealColumns(file.header).pipeline;
    const named = new Set(file.rows.map((r) => ((pipelineAt >= 0 ? oneLine(r[pipelineAt]) : "") || firstPipeline).toLowerCase()));
    const fileRoom = MAX_PIPELINES - snapshot.pipelines.filter((p) => !named.has(p.name.toLowerCase())).length;
    // The deals that really come in are counted below, once the rows already here or past a pipeline are set aside.
    const plan = planHubSpotDeals(file, { currency: store.currency, statedCurrency: options.statedCurrency ?? "", pipelineRoom: fileRoom, dealRoom: Number.POSITIVE_INFINITY, firstPipeline });
    if (!plan.ok) return refuse("too_many", plan.sentence);
    // A pipeline past what a store holds is past the plan's too: its rows say the plan's room.
    const planRoom = Math.max(0, Math.min(pipelineLimit(store, nowSeconds), MAX_PIPELINES) - snapshot.pipelines.length);
    for (const r of plan.refused) if (r.reason === pipelineRoomReason(fileRoom)) r.reason = pipelineRoomReason(planRoom);
    const taken = [...new Set(plan.deals.flatMap((d) => (d.recordId && RECORD_ID.test(d.recordId) && snapshot.dealIds.has(hubSpotDealId(d.recordId)) ? [hubSpotDealId(d.recordId)] : [])))];
    const marks = await readDealMarks(statsId, taken);
    const { summary, pipelines, deals } = planAgainst(store, plan, snapshot, marks, nowSeconds);
    if (snapshot.dealIds.size + deals.length > MAX_DEALS) return refuse("too_many", tooManyDealsSentence(deals.length, MAX_DEALS - snapshot.dealIds.size));
    if (!held) return { ok: true, summary };

    // The room first, then the month's rows; nothing is written until both are taken.
    const room = importRoom(snapshot.raw, pipelines, deals);
    await needData(store, room.take);
    const rows = await takeImportRows(store, file.rows.length, now, options.bytes ?? 0);
    if (!rows.ok) {
      await giveData(store, room.back);
      if (rows.reason === "unavailable") return refuse("unavailable", HUBSPOT_IMPORT_WORDS.unavailable);
      return refuse("rows_month", `Your store can bring in ${rowsWords(rows.limit)} a month from files, and this file would go past that. Nothing was brought in. Bring it in when your next billing month starts, or bring in a smaller file.`, rows.limit);
    }
    counted = rows.counted;
    await writeImport(statsId, held, snapshot.raw, pipelines, deals, store);
    counted = 0;
    return { ok: true, summary: { ...summary, written: true } };
  } catch (error) {
    // The month's rows go back only when the step surely wrote nothing; unconfirmed, they stay counted, as the room does.
    if (counted && (error instanceof CrmSchemaConflict || error instanceof CrmDealsFull || error instanceof CrmLockLost || error instanceof LockBusyError)) await giveImportRows(store, counted, now).catch(() => undefined);
    if (error instanceof LockBusyError) return refuse("busy", HUBSPOT_IMPORT_WORDS.busy);
    if (error instanceof CrmLockLost) return refuse("lock_lost", HUBSPOT_IMPORT_WORDS.lock_lost);
    if (error instanceof DataRoomError) return refuse("store_full", error.message);
    if (error instanceof CrmSchemaConflict) return refuse("changed", HUBSPOT_IMPORT_WORDS.changed);
    if (error instanceof CrmDealsFull) return refuse("deals_full", HUBSPOT_IMPORT_WORDS.deals_full);
    if (error instanceof CrmSchemaReadUnavailable || error instanceof CrmDealReadUnavailable) return refuse("unavailable", HUBSPOT_IMPORT_WORDS.unavailable);
    if (error instanceof CrmSchemaWriteUnconfirmed || error instanceof CrmDealWriteUnconfirmed) return refuse("unconfirmed", HUBSPOT_IMPORT_WORDS.unconfirmed);
    throw error;
  } finally {
    if (held) await releaseLock(held);
  }
}
