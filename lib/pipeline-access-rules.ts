/**
 * Who on the team may see and change each sales pipeline: 639 [GL7](7),
 * unit 1. For each teammate the store can mark a pipeline "view" (they see
 * its deals and change none) or "none" (they do not see it at all); a
 * pipeline not marked is "edit", as every pipeline was before, so nothing
 * changes until the store restricts someone. The owner and Admins always
 * edit every pipeline: the people who run the store and its team are never
 * locked out of it. Browser-safe.
 */
import { CRM_ID, FIRST_PIPELINE_ID, type Pipeline, pipelineNames } from "@/lib/crm-rules";
import type { Role } from "@/lib/team-roles";

export type PipelineAccess = "edit" | "view" | "none";
/** What a teammate is restricted to, by pipeline: only the restricted ones are written. */
export type AccessMap = Record<string, "view" | "none">;

const PIPELINE = (id: string) => id === FIRST_PIPELINE_ID || CRM_ID.test(id);

/** A teammate's restrictions as sent or stored, made safe: only real pipeline ids, only "view" or "none". */
export function parseAccessMap(raw: unknown): AccessMap {
  const out: AccessMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 50) break;
    if (PIPELINE(id) && (value === "view" || value === "none")) out[id] = value;
  }
  return out;
}

/**
 * What one person may do with one pipeline: the owner and Admins edit every
 * one; anyone else as the store set, "edit" when not set. A record that
 * could not be read (null) opens nothing: it is never taken for none.
 */
export function accessOf(role: Role, map: AccessMap | null, pipelineId: string): PipelineAccess {
  if (role === "owner" || role === "admin") return "edit";
  if (map === null) return "none";
  return map[pipelineId] ?? "edit";
}

/** The pipeline a stage belongs to, or null for a stage no pipeline has. */
export function pipelineOfStage(pipelines: readonly Pipeline[], stageId: string): string | null {
  return pipelines.find((p) => p.stages.some((s) => s.id === stageId))?.id ?? null;
}

/** The pipelines one person sees, each with what they may do in it; those they may not see are left out. */
export function visiblePipelines(pipelines: readonly Pipeline[], role: Role, map: AccessMap | null): (Pipeline & { access: "edit" | "view" })[] {
  return pipelines.flatMap((p) => {
    const access = accessOf(role, map, p.id);
    return access === "none" ? [] : [{ ...p, access }];
  });
}

/** What a refused change tells the person, in plain words. */
export const PIPELINE_ACCESS_REFUSAL = "Your access does not let you change this pipeline. Ask the store's owner to change your access.";

/** One pipeline's access as the team's activity log keeps it: by id, with its name as saved then. */
export type AccessChange = { id: string; name: string; now: PipelineAccess; was: PipelineAccess };
/** A change of one teammate's pipeline access, kept in the activity log so each pipeline is named when the log is shown. */
export type AccessLog = { email: string; one: boolean; changes: AccessChange[] };

const ACCESS_WORDS: Record<PipelineAccess, string> = { edit: "can change", view: "can only see", none: "no access" };
const isAccess = (v: unknown): v is PipelineAccess => v === "edit" || v === "view" || v === "none";

/**
 * The log line's words. `nameOf` names each pipeline: on the team page, as
 * the store's pipelines are named now (lib/crm-rules.ts, pipelineNames), so
 * two that share a name are told apart however the pipelines change later;
 * when written, by the name each had then.
 */
export function accessLogWords(log: AccessLog, nameOf: (change: AccessChange) => string): string {
  const said = (c: AccessChange) => `${ACCESS_WORDS[c.now]} (was ${ACCESS_WORDS[c.was]})`;
  if (!log.changes.length) return `Saved ${log.email}'s pipeline access with no change`;
  if (log.one) return `Set ${log.email}'s access to the ${nameOf(log.changes[0])} pipeline: ${said(log.changes[0])}`;
  return `Set ${log.email}'s pipeline access. ${log.changes.map((c) => `${nameOf(c)}: ${said(c)}`).join("; ")}`;
}

/** An activity log's access change as stored, or null when it is not one (the line's own words are then shown). */
export function parseAccessLog(raw: unknown): AccessLog | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.email !== "string" || value.email.length > 254 || typeof value.one !== "boolean" || !Array.isArray(value.changes) || value.changes.length > 50) return null;
  const changes: AccessChange[] = [];
  for (const entry of value.changes) {
    const c = entry as Record<string, unknown> | null;
    if (!c || typeof c.id !== "string" || !PIPELINE(c.id) || typeof c.name !== "string" || c.name.length > 200 || !isAccess(c.now) || !isAccess(c.was)) return null;
    changes.push({ id: c.id, name: c.name, now: c.now, was: c.was });
  }
  return { email: value.email, one: value.one, changes };
}

/**
 * How the team page names each pipeline of a logged access change: as the
 * store's pipelines are named now (told apart when two share a name); one
 * since removed by the name it had, said as removed; with the pipelines
 * unreadable (null), by the name it had.
 */
export function accessLogNamer(pipelines: readonly Pick<Pipeline, "id" | "name">[] | null): (change: AccessChange) => string {
  const names = pipelines ? pipelineNames(pipelines) : null;
  return (change) => (names ? (names.get(change.id) ?? `${change.name} (since removed)`) : change.name);
}
