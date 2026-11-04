/** A confirmed CRM change; `workflows` says whether a deal entering a stage had its workflow checked (lib/deal-stage-trigger.ts). */
export type CrmAnswer = { ok: true; workflows?: "checked" | "not_checked" } | { ok: false; error: string };
const REFUSALS = new Set(["title", "followup", "date", "assignee", "stage", "full", "unknown", "fields", "stages", "value", "invalid", "role", "origin", "signed_out", "locked", "store_gone", "none", "unavailable", "bad_request", "forbidden", "crm_deal_read_unavailable", "crm_schema_read_unavailable", "pipelines", "pipeline_limit", "pipeline_last", "moves", "crm_conflict", "pipeline_access"]);
/** Transport or ambiguous replies cannot prove that a CRM write did not happen. */
export function crmAnswer(responseOk: boolean, raw: unknown): CrmAnswer {
  const uncertain: CrmAnswer = { ok: false, error: "crm_write_unconfirmed" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return uncertain;
  const answer = raw as Record<string, unknown>;
  if (!Object.hasOwn(answer, "ok")) return uncertain;
  if (responseOk && answer.ok === true && !Object.hasOwn(answer, "error")) return answer.workflows === "checked" || answer.workflows === "not_checked" ? { ok: true, workflows: answer.workflows } : { ok: true };
  if (answer.ok === false && typeof answer.error === "string" && REFUSALS.has(answer.error) && !["deal", "stages", "fields", "pipelines"].some(key => Object.hasOwn(answer, key))) return { ok: false, error: answer.error };
  return uncertain;
}
