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
 *     stage likewise, within its pipeline. A file's won or lost stage with
 *     no stage of that name goes to the pipeline's own won or lost stage, and
 *     the summary says so. Only the open stages and pipelines the store does
 *     not have are made, within the plan's pipelines (pipelineLimit) and
 *     MAX_STAGES a pipeline; a deal past them is refused with what to do. A
 *     stage or pipeline none of the new deals goes into is not made.
 *   - Never twice: each deal's id here is worked out from HubSpot's Record
 *     ID (hubSpotDealId), so a deal already brought in is found by its id and
 *     counted as already there, never added again nor overwritten, whatever
 *     the creator changed on it since. The Record ID is also written in the
 *     deal's note, for the creator to see where it came from.
 *   - The close date has no field of its own here (a deal's due date is the
 *     creator's next follow-up), so it goes in the note: "Closed on
 *     YYYY-MM-DD (from HubSpot)." for a won or lost deal, "Expected to close
 *     on ..." for an open one, as HubSpot's own close date means for those.
 *   - Whole or nothing: a file with more new deals than the store has room
 *     for (MAX_DEALS), past the store's data room, or past the month's rows
 *     an import may bring in (lib/import-limits.ts, takeImportRows) is
 *     refused whole and nothing is written: the room is taken first, then
 *     the rows, then everything is written in two steps (pipelines, deals).
 *   - One import of deals at a time per store, under the store's CRM lock
 *     (lib/crm.ts, takeCrmLock); a second one waits a moment, then is
 *     refused. A pipeline changed on the board while this was read is never
 *     overwritten: the write compares the record it read
 *     (SAVE_CRM_PIPELINES), and nothing is written.
 *   - No workflow starts: a deal brought in from a file is not a deal
 *     entering a stage (lib/deal-stage-trigger.ts), so nobody is emailed.
 *
 * A deal keeps the first address HubSpot associated with it; deleting that
 * person deletes the deal, as every deal (lib/crm.ts, forgetCrmPerson).
 */
import { createHash } from "node:crypto";
import { CrmDealReadUnavailable, CrmDealWriteUnconfirmed, CrmSchemaConflict, CrmSchemaReadUnavailable, CrmSchemaWriteUnconfirmed, importRoom, importSnapshot, takeCrmLock, writeImport } from "@/lib/crm";
import { type Deal, type Pipeline, type Stage, MAX_DEALS, MAX_PIPELINES, MAX_STAGES, allStages, newCrmId, parseDeal, parsePipelines, pipelineLimit } from "@/lib/crm-rules";
import { HUBSPOT_LABELS, type HubSpotRefusal, STAGE_PAST_REASON, hubSpotFileOf, pipelineRoomReason, planHubSpotDeals, tooManyDealsSentence } from "@/lib/hubspot-csv";
import { takeImportRows } from "@/lib/imports";
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
  refused: HubSpotRefusal[];
  /** What a deal came in without (an amount, a close date, a second person), and why. */
  notices: { line: number; note: string }[];
  ignored: string[];
};

export type HubSpotImportRefusal =
  | "not_hubspot"
  | "too_many"
  | "busy"
  | "changed"
  | "store_full"
  | "rows_month"
  | "unavailable"
  | "unconfirmed";

export type HubSpotImportResult = { ok: true; summary: HubSpotImportSummary } | { ok: false; reason: HubSpotImportRefusal; message: string; limit?: number };

/** What each refusal says, with what to do. */
export const HUBSPOT_IMPORT_WORDS: Record<Exclude<HubSpotImportRefusal, "too_many" | "store_full" | "rows_month">, string> = {
  not_hubspot:
    'This is not a deals file exported from HubSpot with English column names. In HubSpot, export your deals list, choose English under "Language of column headers", then bring that file in.',
  busy: "Another file of deals is being brought into this store right now. Wait a minute, then bring this file in again.",
  changed: "Your pipelines changed while this file was being brought in, so nothing was brought in. Bring the file in again.",
  unavailable: "Your deals could not be read just now, so nothing was brought in. Try again in a minute.",
  unconfirmed: "Saving could not be confirmed. Bring the same file in again: deals already here are never added twice.",
};

const refuse = (reason: HubSpotImportRefusal, message: string, limit?: number): HubSpotImportResult => ({ ok: false, reason, message, ...(limit === undefined ? {} : { limit }) });

type Planned = { summary: HubSpotImportSummary; pipelines: Pipeline[] | null; deals: Deal[]; lines: Map<string, number> };

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

/**
 * The file against the store as it stands: the pipelines after the import
 * (null when none changes) and the new deals. Pure but for the clock.
 */
function planAgainst(store: Store, file: HubSpotFile, snapshot: { pipelines: Pipeline[]; dealIds: Set<string> }, statedCurrency: string, nowSeconds: number): { ok: true; planned: Planned } | { ok: false; sentence: string } {
  const plan = planHubSpotDeals(file, { currency: store.currency, statedCurrency, pipelineRoom: MAX_PIPELINES, dealRoom: MAX_DEALS });
  if (!plan.ok) return { ok: false, sentence: plan.sentence };
  const limit = Math.min(pipelineLimit(store, nowSeconds), MAX_PIPELINES);
  const pipelineRoom = Math.max(0, limit - snapshot.pipelines.length);
  const next: Pipeline[] = snapshot.pipelines.map((p) => ({ ...p, stages: [...p.stages] }));
  const pipeIds = new Set(next.map((p) => p.id));
  const stageIds = new Set(allStages(next).map((s) => s.id));
  /** By pipeline name (lower case), each file stage's label (lower case) to the stage it goes to. */
  const route = new Map<string, Map<string, string>>();
  const over = new Map<string, Set<string>>();
  const madePipelines = new Set<string>();
  const madeStages = new Map<string, string>(); // stage id -> pipeline id, for open stages made in an existing pipeline
  const joined: { pipeline: string; from: string; to: string; stage: string }[] = [];
  let made = 0;

  for (const proposed of plan.pipelines) {
    const key = proposed.name.toLowerCase();
    const map = new Map<string, string>();
    const past = new Set<string>();
    const existing = next.find((p) => p.name.toLowerCase() === key);
    if (existing) {
      for (const stage of proposed.stages.filter((s) => s.fromFile)) {
        const label = stage.name.toLowerCase();
        const same = existing.stages.find((s) => s.name.toLowerCase() === label);
        if (same) map.set(label, same.id);
        else if (stage.kind !== "open") {
          const own = existing.stages.find((s) => s.kind === stage.kind) as Stage;
          map.set(label, own.id);
          joined.push({ pipeline: existing.name, from: stage.name, to: own.name, stage: own.id });
        } else if (existing.stages.length < MAX_STAGES) {
          const added: Stage = { id: freshId(stageIds), name: stage.name, kind: "open" };
          // After the pipeline's last open stage, before its won and lost ones.
          let at = 0;
          existing.stages.forEach((s, i) => { if (s.kind === "open") at = i + 1; });
          existing.stages.splice(at, 0, added);
          madeStages.set(added.id, existing.id);
          map.set(label, added.id);
        } else past.add(label);
      }
    } else if (snapshot.pipelines.length + made < limit) {
      made += 1;
      const pipeline: Pipeline = { id: freshId(pipeIds), name: proposed.name, stages: proposed.stages.map((s) => ({ id: freshId(stageIds), name: s.name, kind: s.kind })) };
      next.push(pipeline);
      madePipelines.add(pipeline.id);
      proposed.stages.forEach((s, i) => { if (s.fromFile) map.set(s.name.toLowerCase(), pipeline.stages[i].id); });
    } else {
      route.set(key, new Map());
      over.set(key, new Set(["*"]));
      continue;
    }
    route.set(key, map);
    over.set(key, past);
  }

  const refused: HubSpotRefusal[] = [...plan.refused];
  const notices: { line: number; note: string }[] = [];
  const stages = allStages(next);
  const deals: Deal[] = [];
  const lines = new Map<string, number>();
  const used = new Set<string>();
  let alreadyThere = 0;
  for (const draft of plan.deals) {
    const key = draft.pipeline.toLowerCase();
    const label = draft.stage.toLowerCase();
    const past = over.get(key);
    if (past?.has("*")) {
      refused.push({ line: draft.line, column: HUBSPOT_LABELS.deals.pipeline, value: draft.pipeline, reason: pipelineRoomReason(pipelineRoom) });
      continue;
    }
    const stage = route.get(key)?.get(label);
    if (!stage || past?.has(label)) {
      refused.push({ line: draft.line, column: HUBSPOT_LABELS.deals.stage, value: draft.stage, reason: STAGE_PAST_REASON });
      continue;
    }
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
      alreadyThere += 1;
      continue;
    }
    const closed = stages.find((s) => s.id === stage)?.kind !== "open";
    const deal = parseDeal({ id, title: draft.title, email: draft.email, cents: draft.cents ?? 0, stage, note: hubSpotDealNote(draft.recordId, draft.closeDate, closed), createdAt: nowSeconds, updatedAt: nowSeconds }, stages);
    if (!deal) {
      refused.push({ line: draft.line, column: HUBSPOT_LABELS.deals.title, value: draft.title, reason: "This deal could not be read. Check its name and stage in HubSpot, then export again." });
      continue;
    }
    deals.push(deal);
    lines.set(deal.id, draft.line);
    used.add(stage);
    for (const note of [draft.amountNote, draft.closeDateNote, draft.emailNote]) if (note) notices.push({ line: draft.line, note });
  }
  refused.sort((a, b) => a.line - b.line);

  // Only what a new deal goes into is made: a stage or a pipeline left empty is taken back out.
  const keptPipelines = new Set([...madePipelines].filter((id) => next.find((p) => p.id === id)?.stages.some((s) => used.has(s.id))));
  const final = next
    .filter((p) => !madePipelines.has(p.id) || keptPipelines.has(p.id))
    .map((p) => ({ ...p, stages: p.stages.filter((s) => !madeStages.has(s.id) || used.has(s.id)) }));
  const changed = keptPipelines.size > 0 || [...madeStages.keys()].some((id) => used.has(id));
  const checked = changed ? parsePipelines(final) : null;
  if (changed && !checked) throw new CrmSchemaReadUnavailable();
  const summary: HubSpotImportSummary = {
    written: false,
    pipelinesCreated: final.filter((p) => keptPipelines.has(p.id)).map((p) => ({ name: p.name, stages: p.stages.map((s) => s.name) })),
    stagesCreated: final.flatMap((p) => p.stages.filter((s) => madeStages.has(s.id)).map((s) => ({ pipeline: p.name, stage: s.name }))),
    stagesJoined: joined.filter((j) => used.has(j.stage)).map(({ pipeline, from, to }) => ({ pipeline, from, to })),
    added: deals.length,
    alreadyThere,
    refused,
    notices,
    ignored: plan.ignored,
  };
  return { ok: true, planned: { summary, pipelines: checked, deals, lines } };
}

/**
 * Brings a HubSpot deals file into the store's CRM, or, with `write` false,
 * says what it would do (the dry run: nothing is written, no lock, no rows
 * counted). `bytes` is what the request carried, counted with the rows.
 */
export async function importHubSpotDeals(store: Store, file: HubSpotFile, options: { write: boolean; statedCurrency?: string; bytes?: number; now?: number }): Promise<HubSpotImportResult> {
  const now = options.now ?? Date.now();
  const nowSeconds = Math.floor(now / 1000);
  if (hubSpotFileOf(file.header) !== "deals") return refuse("not_hubspot", HUBSPOT_IMPORT_WORDS.not_hubspot);
  const statsId = store.statsId;
  if (!statsId) return refuse("unavailable", HUBSPOT_IMPORT_WORDS.unavailable);

  let held: Held | null = null;
  try {
    if (options.write) held = await takeCrmLock(statsId);
    const snapshot = await importSnapshot(statsId);
    const planned = planAgainst(store, file, snapshot, options.statedCurrency ?? "", nowSeconds);
    if (!planned.ok) return refuse("too_many", planned.sentence);
    const { summary, pipelines, deals, lines } = planned.planned;
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
    const written = await writeImport(statsId, held, snapshot.raw, pipelines, deals, store);
    const full = deals.filter((d) => written.full.includes(d.id));
    return {
      ok: true,
      summary: {
        ...summary,
        written: true,
        added: written.saved,
        refused: [
          ...summary.refused,
          ...full.map((d) => ({ line: lines.get(d.id) ?? 0, column: HUBSPOT_LABELS.deals.title, value: d.title, reason: `Your store reached its ${MAX_DEALS.toLocaleString("en-US")} deals while this file was being brought in, so this deal was not saved. Delete deals you no longer need, then bring the file in again.` })),
        ].sort((a, b) => a.line - b.line),
      },
    };
  } catch (error) {
    if (error instanceof LockBusyError) return refuse("busy", HUBSPOT_IMPORT_WORDS.busy);
    if (error instanceof DataRoomError) return refuse("store_full", error.message);
    if (error instanceof CrmSchemaConflict) return refuse("changed", HUBSPOT_IMPORT_WORDS.changed);
    if (error instanceof CrmSchemaReadUnavailable || error instanceof CrmDealReadUnavailable) return refuse("unavailable", HUBSPOT_IMPORT_WORDS.unavailable);
    if (error instanceof CrmSchemaWriteUnconfirmed || error instanceof CrmDealWriteUnconfirmed) return refuse("unconfirmed", HUBSPOT_IMPORT_WORDS.unconfirmed);
    throw error;
  } finally {
    if (held) await releaseLock(held);
  }
}
