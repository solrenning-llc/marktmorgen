/**
 * Who on the team may see and change each sales pipeline: 639 [GL7](7),
 * unit 1. For each teammate the store can mark a pipeline "view" (they see
 * its deals and change none) or "none" (they do not see it at all); a
 * pipeline not marked is "edit", as every pipeline was before, so nothing
 * changes until the store restricts someone. The owner and Admins always
 * edit every pipeline: the people who run the store and its team are never
 * locked out of it. Browser-safe.
 */
import { CRM_ID, FIRST_PIPELINE_ID, type Pipeline } from "@/lib/crm-rules";
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
export const PIPELINE_ACCESS_REFUSAL = "You can see this pipeline but not change it. Ask the store's owner or an Admin to change your access.";
