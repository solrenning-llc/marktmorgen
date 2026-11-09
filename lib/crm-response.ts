import { DEAL_ID, type Deal } from "@/lib/crm-rules";

/** The deal as it is now, sent with a crm_conflict on an edit (635 [GL3]): the board puts the creator's changes back on it. */
export type CrmCurrentDeal = { deal: Deal; version: string };
/** A confirmed CRM change; `workflows` says whether a deal entering a stage had its workflow checked (lib/deal-stage-trigger.ts). */
export type CrmAnswer = { ok: true; workflows?: "checked" | "not_checked" } | { ok: false; error: string; current?: CrmCurrentDeal };
const REFUSALS = new Set(["title", "followup", "date", "assignee", "stage", "full", "unknown", "fields", "stages", "value", "invalid", "role", "origin", "signed_out", "locked", "store_gone", "none", "unavailable", "bad_request", "forbidden", "crm_deal_read_unavailable", "crm_schema_read_unavailable", "pipelines", "pipeline_limit", "pipeline_last", "moves", "crm_conflict", "pipeline_access", "store_full", "studio_used", "stale"]);
const VERSION = /^[0-9a-f]{32}$/;
const text = (value: unknown) => typeof value === "string";
const optionalText = (value: unknown) => value === undefined || typeof value === "string";

/** A conflict's `current`, only when it has the shape the server sends; anything else is never put in the editor. */
function currentDeal(raw: unknown): CrmCurrentDeal | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { deal, version } = raw as Record<string, unknown>;
  if (typeof version !== "string" || !VERSION.test(version) || !deal || typeof deal !== "object" || Array.isArray(deal)) return null;
  const d = deal as Record<string, unknown>;
  if (typeof d.id !== "string" || !DEAL_ID.test(d.id) || !text(d.title) || !text(d.email) || !text(d.stage) || !text(d.note)) return null;
  if (typeof d.cents !== "number" || !Number.isSafeInteger(d.cents) || d.cents < 0) return null;
  if (!optionalText(d.nextAction) || !optionalText(d.dueDate) || !optionalText(d.assignee)) return null;
  return { deal: deal as Deal, version };
}

/**
 * What a contact field shows when its save was refused. A page whose mark
 * cannot save ("stale": opened longer ago than PAGE_MARK_SECONDS, or its
 * person could not be read when it was drawn) is told to reload: trying again
 * from it never helps (independent review of #2287, LOW 1).
 */
export function crmRefusalMessage(error: string): string {
  if (error === "stale") return "This page was opened too long ago to save from. Copy your entry, then reload the page and try again.";
  if (error === "value") return "This field cannot keep that value. Your entry is still here; correct it and try again.";
  if (error === "unknown") return "This person or this field is no longer in your store, so nothing was saved. Reload the page to see your contacts as they are now.";
  if (error === "studio_used") return "Your studio has no requests left this month, so nothing was saved. Your entry is still here.";
  if (error === "unavailable") return "This could not be counted right now, so nothing was saved. Your entry is still here; try again in a minute.";
  return "This change was refused. Your entry is still here; check your access and try again.";
}

/** Transport or ambiguous replies cannot prove that a CRM write did not happen. */
export function crmAnswer(responseOk: boolean, raw: unknown): CrmAnswer {
  const uncertain: CrmAnswer = { ok: false, error: "crm_write_unconfirmed" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return uncertain;
  const answer = raw as Record<string, unknown>;
  if (!Object.hasOwn(answer, "ok")) return uncertain;
  if (responseOk && answer.ok === true && !Object.hasOwn(answer, "error")) return answer.workflows === "checked" || answer.workflows === "not_checked" ? { ok: true, workflows: answer.workflows } : { ok: true };
  if (answer.ok === false && typeof answer.error === "string" && REFUSALS.has(answer.error) && !["deal", "stages", "fields", "pipelines"].some(key => Object.hasOwn(answer, key))) {
    if (!Object.hasOwn(answer, "current")) return { ok: false, error: answer.error };
    // Only an edit's conflict carries the deal as it is now, and only in its exact shape.
    const current = answer.error === "crm_conflict" ? currentDeal(answer.current) : null;
    return current ? { ok: false, error: answer.error, current } : uncertain;
  }
  return uncertain;
}
