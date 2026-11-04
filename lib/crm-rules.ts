/**
 * Fields of a store's own about each person, and its deals (added 13 October
 * 2026): the two parts of a CRM a creator who sells calls, coaching or
 * services asks for, and the two ClickFunnels sells as contact attributes and
 * opportunities.
 *
 *   - A field is a question the creator keeps the answer to for each person:
 *     their company, their time zone, the date of a first call, which offer
 *     interests them. Up to MAX_CRM_FIELDS, each text, a number, a date or one
 *     of a few choices. Filled in on the person's page in the studio, and
 *     written into the file of the list as columns of their own.
 *   - A deal is somebody the creator is talking to about a sale that does not
 *     happen at a checkout (a coaching package, a custom project), with what
 *     it is worth and the stage it has reached. The stages are the creator's,
 *     each open, won or lost, and the board adds up each.
 *
 * Nothing here is read by anybody but the store's own team, and nothing here
 * sends anything to anybody: a deal is a note that adds up, never a message.
 *
 * Pure and browser-safe: the studio and the routes read these rules.
 */
import type { Tier } from "@/lib/plan";

export const MAX_CRM_FIELDS = 10;
export const MAX_FIELD_NAME = 40;
export const MAX_FIELD_OPTIONS = 10;
export const MAX_FIELD_OPTION = 40;
export const MAX_FIELD_VALUE = 200;

export const MAX_STAGES = 8;
export const MAX_STAGE_NAME = 30;
export const MAX_DEALS = 1_000;
export const MAX_DEAL_TITLE = 90;
export const MAX_DEAL_NOTE = 500;
/** A deal's worth, in cents: up to a hundred million in the store's currency. */
export const MAX_DEAL_CENTS = 10_000_000_000;

export const CRM_ID = /^[a-z0-9]{6}$/;
export const DEAL_ID = /^[a-z0-9]{10}$/;

export type FieldType = "text" | "number" | "date" | "choice" | "phone" | "url" | "several";
export const FIELD_TYPES: { type: FieldType; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "date", label: "Date" },
  { type: "choice", label: "One of a few choices" },
  { type: "phone", label: "Phone number (with country code)" },
  { type: "url", label: "Web address" },
  { type: "several", label: "Several of a few choices" },
];

/** Whether a kind of field holds a list of choices (one, or several). */
export const hasChoices = (type: FieldType): boolean => type === "choice" || type === "several";

export type CrmField = { id: string; name: string; type: FieldType; options: string[] };

/** Whether a kind of field is one a store can keep. */
export const isFieldType = (value: unknown): value is FieldType => FIELD_TYPES.some((kind) => kind.type === value);

export type StageKind = "open" | "won" | "lost";
export type Stage = { id: string; name: string; kind: StageKind };

export type Deal = {
  /** Server-owned identity for a conversion from a retained form response. */
  formResponseRef?: string;
  id: string;
  title: string;
  /** Who it is with, when the creator says; "" for nobody named yet. */
  email: string;
  /** What it is worth, in cents of the store's currency. */
  cents: number;
  stage: string;
  note: string;
  /** Next action, date and responsible teammate; optional for older records. */
  nextAction?: string;
  dueDate?: string;
  assignee?: string;
  createdAt: number;
  updatedAt: number;
};

/** The stages a store starts with: the usual road from a first word to a yes or a no. */
export const DEFAULT_STAGES: Stage[] = [
  { id: "lead00", name: "New", kind: "open" },
  { id: "talk00", name: "Talking", kind: "open" },
  { id: "offr00", name: "Offer sent", kind: "open" },
  { id: "won000", name: "Won", kind: "won" },
  { id: "lost00", name: "Lost", kind: "lost" },
];

/** One line as the deals board keeps it: controls made spaces, spaces made one, trimmed (exported for a workflow step, lib/flow-rules.ts). */
export const oneLine = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** A new id: six letters and digits for a field or a stage, ten for a deal. */
export function newCrmId(length = 6, random: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length }, () => letters[random(letters.length)]).join("");
}

/** A store's fields as stored or sent, made safe: each with a name, once, a choice with two options at least. */
export function parseFields(raw: unknown): CrmField[] {
  const out: CrmField[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_CRM_FIELDS || !entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const id = typeof value.id === "string" && CRM_ID.test(value.id) ? value.id : "";
    const name = oneLine(value.name, MAX_FIELD_NAME);
    const type = FIELD_TYPES.find((t) => t.type === value.type)?.type;
    if (!id || !name || !type || out.some((f) => f.id === id || f.name.toLowerCase() === name.toLowerCase())) continue;
    const options =
      hasChoices(type)
        ? [...new Set((Array.isArray(value.options) ? value.options : []).map((o) => oneLine(o, MAX_FIELD_OPTION)).filter(Boolean))].slice(0, MAX_FIELD_OPTIONS)
        : [];
    if (hasChoices(type) && options.length < 2) continue;
    out.push({ id, name, type, options });
  }
  return out;
}

/** A value for a field as typed, made what the field keeps; "" clears it, null when it cannot be one. */
export function fieldValue(field: CrmField, raw: unknown): string | null {
  if (field.type === "several") return severalValue(field, raw);
  const text = oneLine(raw, MAX_FIELD_VALUE);
  if (!text) return "";
  switch (field.type) {
    case "text":
      return text;
    case "number": {
      const n = Number(text.replace(/,/g, ""));
      return Number.isFinite(n) && Math.abs(n) < 1e15 ? String(n) : null;
    }
    case "date":
      return validCrmDate(text) ? text : null;
    case "choice":
      return field.options.includes(text) ? text : null;
    case "phone":
      return crmPhone(text);
    case "url":
      // Read whole, never cut: a web address cut short is another address.
      return crmUrl(raw);
  }
}

/**
 * Several of a field's choices (639 [GL7](2)), as a list or as lines of text,
 * kept one per line in the field's own order: a choice never holds a line
 * break, so the lines always read back the same. "" when none is picked;
 * null when one is not among the field's choices.
 */
export function severalValue(field: Pick<CrmField, "options">, raw: unknown): string | null {
  const pieces = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("\n") : null;
  if (pieces === null) return null;
  const picked = new Set(pieces.map((p) => oneLine(p, MAX_FIELD_OPTION)).filter(Boolean));
  if ([...picked].some((p) => !field.options.includes(p))) return null;
  return field.options.filter((o) => picked.has(o)).join("\n");
}

/** The choices a value of several holds. */
export const severalPicked = (value: string): string[] => value.split("\n").filter(Boolean);

/**
 * A web address as a contact field keeps it (639 [GL7](2)): http or https
 * only, with a real host, as the browser reads it; "example.com/page" is
 * read as https. Nothing else (a mailto, a javascript: address, a bare word)
 * is ever kept, since the contact's record shows it as a link.
 */
export function crmUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const typed = raw.trim();
  if (!typed || typed.length > MAX_FIELD_VALUE || /\s/.test(typed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  // A host with a dot and letters in its last part (example.com), not a bare word or an address by numbers.
  if (!/\.[a-z]{2,}$/i.test(url.hostname.replace(/\.$/, ""))) return null;
  const kept = url.toString();
  return kept.length <= MAX_FIELD_VALUE ? kept : null;
}

/**
 * A phone number as a contact field keeps it: the international form, "+"
 * then the country code and number, 7 to 15 digits (ITU-T E.164), from what
 * was typed with spaces, dots, dashes or brackets and a leading "+" or "00".
 * Without a country code it is refused, since no one could tell which
 * country it dials; null when it cannot be one.
 */
export function crmPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const typed = raw.trim().replace(/[\s().\-]/g, "");
  const digits = typed.startsWith("+") ? typed.slice(1) : typed.startsWith("00") ? typed.slice(2) : null;
  return digits !== null && /^[1-9][0-9]{6,14}$/.test(digits) ? "+" + digits : null;
}

/**
 * The link that opens a chat with this number in the creator's own WhatsApp
 * (https://wa.me/<digits>, the form WhatsApp documents for its click to chat
 * links). It only opens the app: nothing is written or sent for them, and
 * the store keeps nothing about it. null when the value is not a phone number.
 */
export function whatsappLink(value: unknown): string | null {
  const phone = crmPhone(value);
  return phone ? "https://wa.me/" + phone.slice(1) : null;
}

/** A store's stages as stored or sent: each named, once, at least one open, one won and one lost. */
export function parseStages(raw: unknown): Stage[] | null {
  const out: Stage[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_STAGES || !entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const id = typeof value.id === "string" && CRM_ID.test(value.id) ? value.id : "";
    const name = oneLine(value.name, MAX_STAGE_NAME);
    const kind: StageKind | null = value.kind === "open" || value.kind === "won" || value.kind === "lost" ? value.kind : null;
    if (!id || !name || !kind || out.some((s) => s.id === id)) continue;
    out.push({ id, name, kind });
  }
  const kinds = new Set(out.map((s) => s.kind));
  return kinds.has("open") && kinds.has("won") && kinds.has("lost") ? out : null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** A deal as sent or stored, made safe; null without a title or a stage the store has. */
export function parseDeal(raw: unknown, stages: readonly Stage[]): Deal | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && DEAL_ID.test(value.id) ? value.id : "";
  const title = oneLine(value.title, MAX_DEAL_TITLE);
  const stage = typeof value.stage === "string" && stages.some((s) => s.id === value.stage) ? value.stage : "";
  if (!id || !title || !stage) return null;
  const email = oneLine(value.email, 254).toLowerCase();
  const cents = typeof value.cents === "number" && Number.isFinite(value.cents) ? Math.max(0, Math.min(MAX_DEAL_CENTS, Math.round(value.cents))) : 0;
  const note =
    typeof value.note === "string"
      ? value.note
          .replace(/\r\n?/g, "\n")
          .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
          .trim()
          .slice(0, MAX_DEAL_NOTE)
      : "";
  const at = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);
  const follow = readFollowUp(value);
  return { ...(typeof value.formResponseRef === "string" && /^[a-f0-9]{64}$/.test(value.formResponseRef) ? { formResponseRef: value.formResponseRef } : {}), id, title, email: EMAIL.test(email) ? email : "", cents, stage, note, ...(follow.ok ? follow.value : {}), createdAt: at(value.createdAt), updatedAt: at(value.updatedAt) };
}

/** Each stage's deals, how many and what they are worth, in the stages' order. */
export function boardTotals(stages: readonly Stage[], deals: readonly Deal[]): { stage: Stage; count: number; cents: number }[] {
  return stages.map((stage) => {
    const here = deals.filter((d) => d.stage === stage.id);
    return { stage, count: here.length, cents: here.reduce((sum, d) => sum + d.cents, 0) };
  });
}

/** Calendar dates are kept as dates, never shifted through a browser time zone. */
export function validCrmDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

export type FollowUp = { nextAction?: string; dueDate?: string; assignee?: string };

/** Missing fields preserve older data; explicit empty strings clear a field. */
export function readFollowUp(raw: Record<string, unknown>): { ok: true; value: FollowUp } | { ok: false; error: "followup" | "date" | "assignee" } {
  const out: FollowUp = {};
  if (raw.nextAction !== undefined) {
    if (typeof raw.nextAction !== "string" || raw.nextAction.length > 200) return { ok: false, error: "followup" };
    out.nextAction = oneLine(raw.nextAction, 200);
  }
  if (raw.dueDate !== undefined) {
    if (raw.dueDate !== "" && !validCrmDate(raw.dueDate)) return { ok: false, error: "date" };
    out.dueDate = raw.dueDate as string;
  }
  if (raw.assignee !== undefined) {
    if (typeof raw.assignee !== "string") return { ok: false, error: "assignee" };
    const email = raw.assignee.trim().toLowerCase();
    if (email && (email.length > 254 || !EMAIL.test(email))) return { ok: false, error: "assignee" };
    out.assignee = email;
  }
  if (out.dueDate && !out.nextAction) return { ok: false, error: "followup" };
  return { ok: true, value: out };
}

/** Open deals to act on, ordered by date then longest without a change. */
export function dealFollowUps(stages: readonly Stage[], deals: readonly Deal[], today: string): { overdue: Deal[]; today: Deal[]; upcoming: Deal[]; unplanned: Deal[] } {
  const open = new Set(stages.filter(s => s.kind === "open").map(s => s.id));
  const rows = deals.filter(d => open.has(d.stage)).slice().sort((a,b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31") || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  return {
    overdue: rows.filter(d => d.nextAction && validCrmDate(d.dueDate) && d.dueDate < today),
    today: rows.filter(d => d.nextAction && d.dueDate === today),
    upcoming: rows.filter(d => d.nextAction && validCrmDate(d.dueDate) && d.dueDate > today),
    unplanned: rows.filter(d => !d.nextAction || !validCrmDate(d.dueDate)),
  };
}

/*
 * Pipelines (added 17 October 2026, HighLevel audit H02): more than one deal
 * board, each with its own ordered stages. A creator who sells coaching and
 * also takes brand partnerships keeps two roads, each with its own "won".
 *
 * A deal names a stage, never a pipeline: stage ids are unique across every
 * pipeline of a store, so the pipeline a deal is in is the one its stage is
 * in. Moving a deal to another pipeline is moving it to one of that
 * pipeline's stages, and every deal saved before pipelines existed is in
 * the first pipeline, unchanged (its stages are the ones the store had).
 *
 * Totals are what the deals' recorded values add up to, stage by stage and
 * open, won and lost: no probability, weighting or forecast is invented.
 */
export const MAX_PIPELINE_NAME = 40;
/** The most pipelines any store keeps, whatever its plan; a store that moves to a smaller plan keeps what it made. */
export const MAX_PIPELINES = 10;
/** Pipelines a store may have by plan; a store with no active plan keeps the one board it always had. */
export const PIPELINES_BY_TIER: Record<Tier, number> = { creator: 2, pro: 5, scale: 10 };
export const TRIAL_PIPELINES = 2;
export const UNPAID_PIPELINES = 1;
/** The pipeline every store starts with, and the one deals saved before pipelines existed are in. */
export const FIRST_PIPELINE_ID = "sales0";
export const FIRST_PIPELINE_NAME = "Sales";

export type Pipeline = { id: string; name: string; stages: Stage[] };

type PlanView = { tier: Tier; subscriptionActive: boolean; trialEnds: number };

/** How many pipelines this store may have. */
export function pipelineLimit(store: PlanView, nowSeconds = Date.now() / 1000): number {
  if (!store.subscriptionActive) return UNPAID_PIPELINES;
  if (store.trialEnds > nowSeconds) return TRIAL_PIPELINES;
  return PIPELINES_BY_TIER[store.tier] ?? UNPAID_PIPELINES;
}

/** The limits in one sentence, for the help and feature pages. */
export function pipelineLimitWords(): string {
  return `Pipelines: ${PIPELINES_BY_TIER.creator} on Store, ${PIPELINES_BY_TIER.pro} on Studio, ${PIPELINES_BY_TIER.scale} on Scale (${TRIAL_PIPELINES} during the free trial), each with up to ${MAX_STAGES} stages; up to ${MAX_DEALS.toLocaleString("en-US")} deals across all of them.`;
}

/** The first pipeline as a store had it before pipelines: its board's stages, under the first pipeline's name. */
export const firstPipeline = (stages: readonly Stage[]): Pipeline => ({ id: FIRST_PIPELINE_ID, name: FIRST_PIPELINE_NAME, stages: [...stages] });

/** A pipeline as sent or stored, made safe: a name, and stages that parseStages accepts in full. */
export function parsePipeline(raw: unknown): Pipeline | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && CRM_ID.test(value.id) ? value.id : "";
  const name = oneLine(value.name, MAX_PIPELINE_NAME);
  const sent = Array.isArray(value.stages) ? value.stages : [];
  const stages = sent.length <= MAX_STAGES ? parseStages(sent) : null;
  // Every stage sent is kept, or none: a stage silently dropped would hide its deals.
  if (!id || !name || !stages || stages.length !== sent.length) return null;
  return { id, name, stages };
}

/**
 * A store's pipelines as stored or sent: each valid, at most MAX_PIPELINES,
 * no id twice, no stage id in two, no name twice. Null when any is not.
 * `sameNames` reads a record as stored, where two pipelines may share a
 * name: a teammate who cannot see a pipeline may give theirs the same name
 * (changePipeline), so a hidden pipeline's name is never told by a refusal.
 */
export function parsePipelines(raw: unknown, sameNames = false): Pipeline[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PIPELINES) return null;
  const out: Pipeline[] = [];
  const stageIds = new Set<string>();
  for (const entry of raw) {
    const pipeline = parsePipeline(entry);
    if (!pipeline || out.some((p) => p.id === pipeline.id || (!sameNames && p.name.toLowerCase() === pipeline.name.toLowerCase()))) return null;
    for (const stage of pipeline.stages) {
      if (stageIds.has(stage.id)) return null;
      stageIds.add(stage.id);
    }
    out.push(pipeline);
  }
  return out;
}

/**
 * A copy of a pipeline to start another from (639 [GL7](8); owner's
 * HighLevel audit): the same stages, names and kinds in the same order, each
 * with a new id no stage of the store has, and none of its deals. Named
 * "<name> copy", then "<name> copy 2" and so on, never a name the store
 * already uses, within MAX_PIPELINE_NAME. Nothing is saved: the board opens
 * it for the creator to read, change and save as a new pipeline.
 */
export function copyPipeline(source: Pipeline, pipelines: readonly Pipeline[], newId: () => string = () => newCrmId()): Pipeline {
  const taken = new Set(allStages(pipelines).map((s) => s.id));
  const ids = new Set(pipelines.map((p) => p.id));
  const fresh = (used: Set<string>) => {
    for (;;) {
      const id = newId();
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  const names = new Set(pipelines.map((p) => p.name.toLowerCase()));
  let name = "";
  for (let n = 1; ; n += 1) {
    const tail = n === 1 ? " copy" : ` copy ${n}`;
    name = `${source.name.slice(0, MAX_PIPELINE_NAME - tail.length).trimEnd()}${tail}`;
    if (!names.has(name.toLowerCase())) break;
  }
  return { id: fresh(ids), name, stages: source.stages.map((stage) => ({ id: fresh(taken), name: stage.name, kind: stage.kind })) };
}

/** Every stage of every pipeline, in order: what a deal's stage is checked against. */
export const allStages = (pipelines: readonly Pipeline[]): Stage[] => pipelines.flatMap((p) => p.stages);

/** The pipeline a stage is in. */
export const pipelineOf = (pipelines: readonly Pipeline[], stageId: string): Pipeline | undefined => pipelines.find((p) => p.stages.some((s) => s.id === stageId));

/**
 * Each pipeline's name as the owner's screens show it (639 [GL7](7)): as
 * saved, except that pipelines sharing a name (a teammate who could not see
 * one may give theirs the same name) are told apart in the order they were
 * made, "Sales", "Sales (2)", never two choices that read the same. Only
 * the pipelines given are counted, so a teammate's screens, given only the
 * ones they see, never hint at a hidden one.
 */
export function pipelineNames(pipelines: readonly Pick<Pipeline, "id" | "name">[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set(pipelines.map((p) => p.name.toLowerCase()));
  const seen = new Set<string>();
  for (const p of pipelines) {
    const key = p.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.set(p.id, p.name);
      continue;
    }
    let n = 2;
    while (taken.has(`${key} (${n})`)) n += 1;
    taken.add(`${key} (${n})`);
    out.set(p.id, `${p.name} (${n})`);
  }
  return out;
}

/** True when two of these pipelines share a name, so the board can say why one reads "Sales (2)". */
export const pipelinesShareName = (pipelines: readonly Pick<Pipeline, "name">[]): boolean => new Set(pipelines.map((p) => p.name.toLowerCase())).size < pipelines.length;

/** A stage's name as a list of every stage shows it: with its pipeline's name (told apart, pipelineNames) once a store has more than one. */
export function stageLabel(pipelines: readonly Pipeline[], stage: Pick<Stage, "id" | "name">): string {
  if (pipelines.length < 2) return stage.name;
  const pipeline = pipelineOf(pipelines, stage.id);
  return pipeline ? `${pipelineNames(pipelines).get(pipeline.id) ?? pipeline.name}: ${stage.name}` : stage.name;
}

/** Every stage, named with its pipeline when there is more than one (for a form's or a workflow's choice of stage). */
export const labeledStages = (pipelines: readonly Pipeline[]): Stage[] => allStages(pipelines).map((s) => ({ ...s, name: stageLabel(pipelines, s) }));

export type PipelineTotals = { pipeline: Pipeline; deals: number; open: { count: number; cents: number }; won: { count: number; cents: number }; lost: { count: number; cents: number } };

/** What a pipeline's deals add up to, by what their stages mean: recorded values, nothing weighted or forecast. */
export function pipelineTotals(pipeline: Pipeline, deals: readonly Deal[]): PipelineTotals {
  const kind = new Map(pipeline.stages.map((s) => [s.id, s.kind]));
  const out: PipelineTotals = { pipeline, deals: 0, open: { count: 0, cents: 0 }, won: { count: 0, cents: 0 }, lost: { count: 0, cents: 0 } };
  for (const deal of deals) {
    const k = kind.get(deal.stage);
    if (!k) continue;
    out.deals += 1;
    out[k].count += 1;
    out[k].cents += deal.cents;
  }
  return out;
}

export type PipelineChange = { ok: true; pipelines: Pipeline[]; moves: Record<string, string> } | { ok: false; error: "pipelines" | "pipeline_limit" | "pipeline_last" | "unknown" | "moves" };

/**
 * A change to one pipeline, checked against the store's pipelines now: its
 * name and stages saved (a new id adds it), or (`remove`) the pipeline taken
 * away. `moves` says, for each stage that goes, which stage still kept its
 * deals go to; a stage that goes with deals in it and no such choice is
 * refused ("moves"), so a deal is never deleted or moved where the creator
 * did not say; for a pipeline removed, `moves` may be one stage for all of
 * its deals. `counts` is how many deals each stage holds now. The name saved
 * must differ from every other pipeline's that the saver sees (`sees`, 639
 * [GL7](7)); one they may not see never refuses it, so a refusal never tells
 * them a hidden pipeline's name.
 */
export function changePipeline(
  current: readonly Pipeline[],
  change: { pipeline?: unknown; remove?: string },
  moves: unknown,
  counts: ReadonlyMap<string, number>,
  limit: number,
  sees: (pipelineId: string) => boolean = () => true,
): PipelineChange {
  let next: Pipeline[];
  let saved: Pipeline | null = null;
  if (change.remove !== undefined) {
    if (!current.some((p) => p.id === change.remove)) return { ok: false, error: "unknown" };
    if (current.length < 2) return { ok: false, error: "pipeline_last" };
    next = current.filter((p) => p.id !== change.remove);
  } else {
    const pipeline = parsePipeline(change.pipeline);
    if (!pipeline) return { ok: false, error: "pipelines" };
    const at = current.findIndex((p) => p.id === pipeline.id);
    // A new pipeline counts against the plan's number; an existing one may always be edited.
    if (at < 0 && current.length >= Math.min(limit, MAX_PIPELINES)) return { ok: false, error: "pipeline_limit" };
    next = at < 0 ? [...current, pipeline] : current.map((p, i) => (i === at ? pipeline : p));
    saved = pipeline;
  }
  const checked = parsePipelines(next, true);
  if (!checked) return { ok: false, error: "pipelines" };
  const named = saved;
  // A name kept as it was (two pipelines may already share one) never refuses the rest of the change.
  const before = named ? current.find((p) => p.id === named.id) : undefined;
  const renamed = !before || before.name.toLowerCase() !== named!.name.toLowerCase();
  if (named && renamed && checked.some((p) => p.id !== named.id && sees(p.id) && p.name.toLowerCase() === named.name.toLowerCase())) return { ok: false, error: "pipelines" };
  const kept = new Set(allStages(checked).map((s) => s.id));
  // One stage for every deal that has to move (a pipeline removed), or a stage for each stage removed.
  const asked = moves && typeof moves === "object" && !Array.isArray(moves) ? (moves as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const stage of allStages(current)) {
    if (kept.has(stage.id) || !(counts.get(stage.id) ?? 0)) continue;
    const target = typeof moves === "string" ? moves : Object.hasOwn(asked, stage.id) ? asked[stage.id] : undefined;
    if (typeof target !== "string" || !kept.has(target)) return { ok: false, error: "moves" };
    out[stage.id] = target;
  }
  return { ok: true, pipelines: checked, moves: out };
}

/** A new pipeline's stages to start from: the usual road, with ids of its own. */
export function starterStages(newId: () => string = () => newCrmId()): Stage[] {
  return [
    { id: newId(), name: "New", kind: "open" },
    { id: newId(), name: "Talking", kind: "open" },
    { id: newId(), name: "Won", kind: "won" },
    { id: newId(), name: "Lost", kind: "lost" },
  ];
}
