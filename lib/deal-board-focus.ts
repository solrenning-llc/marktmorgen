/**
 * The deals board's AAA review (635 [GL3], AX274): where focus goes after a
 * control is removed, which fields an error is about, and the one status
 * region's words. Pure rules, so the board and its tests read the same ones.
 */
import { MAX_FIELD_NAME, MAX_FIELD_OPTION, MAX_PIPELINE_NAME, MAX_STAGE_NAME, hasChoices, oneLine, type FieldType, type Stage } from "@/lib/crm-rules";
import { dealFieldId, type DraftField } from "@/lib/deal-draft";

/** After removing one of a list (a deal in a stage, a stage, a field): the one after it, else the one before, else null. */
export function neighborAfterRemoval(ids: readonly string[], removed: string): string | null {
  const at = ids.indexOf(removed);
  if (at < 0) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** The deal editor's field each refusal is about (3.3.1); a refusal not listed is about no one field. */
export const DEAL_ERROR_FIELDS: Readonly<Record<string, DraftField>> = { title: "title", value: "value", followup: "nextAction", date: "dueDate", assignee: "assignee", stage: "stage" };

/** The id of the deal editor's field a refusal is about, or null. */
export function dealErrorField(error: string): string | null {
  const field = Object.hasOwn(DEAL_ERROR_FIELDS, error) ? DEAL_ERROR_FIELDS[error] : undefined;
  return field ? dealFieldId(field) : null;
}

/** The ids of the pipeline editor's controls, so an error can point to them and focus can go to them. */
export const PIPELINE_NAME_ID = "pipeline-name";
export const PIPELINE_REMOVE_TO_ID = "pipeline-remove-to";
export const stageNameId = (stage: string) => `stage-name-${stage}`;
export const stageKindId = (stage: string) => `stage-kind-${stage}`;
export const stageMovesId = (stage: string) => `stage-moves-${stage}`;

/** A name as the server keeps it (lib/crm-rules.ts, oneLine), compared without case. */
const kept = (value: string, max: number) => oneLine(value, max).toLowerCase();

/**
 * What in the pipeline editor keeps it from being saved (3.3.1), in the
 * editor's order: an empty name, a name another pipeline has, a stage with
 * no name, and (on the first stage's "Counts as") a kind missing. Names are
 * read as the server keeps them (oneLine), so the board never passes what
 * the server would refuse. Empty when nothing is wrong that the board can see.
 */
export function pipelineProblems(draft: { name: string; stages: readonly Stage[] }, otherNames: readonly string[]): string[] {
  const ids: string[] = [];
  const name = kept(draft.name, MAX_PIPELINE_NAME);
  if (!name || otherNames.some((other) => kept(other, MAX_PIPELINE_NAME) === name)) ids.push(PIPELINE_NAME_ID);
  for (const stage of draft.stages) if (!kept(stage.name, MAX_STAGE_NAME)) ids.push(stageNameId(stage.id));
  const kinds = new Set(draft.stages.map((stage) => stage.kind));
  if (draft.stages.length && !(kinds.has("open") && kinds.has("won") && kinds.has("lost"))) ids.push(stageKindId(draft.stages[0].id));
  return ids;
}

/** The ids of the fields editor's controls. */
export const crmFieldNameId = (field: string) => `crm-field-name-${field}`;
export const crmFieldChoicesId = (field: string) => `crm-field-choices-${field}`;

/** What in the fields editor keeps it from being saved (3.3.1): an empty or repeated name, a choice with fewer than two options, read as the server keeps them (oneLine, options cut at MAX_FIELD_OPTION). */
export function fieldProblems(fields: readonly { id: string; name: string; type: FieldType; optionsText: string }[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    const name = kept(field.name, MAX_FIELD_NAME);
    if (!name || seen.has(name)) ids.push(crmFieldNameId(field.id));
    seen.add(name);
    const options = new Set(field.optionsText.split(",").map((option) => oneLine(option, MAX_FIELD_OPTION)).filter(Boolean));
    if (hasChoices(field.type) && options.size < 2) ids.push(crmFieldChoicesId(field.id));
  }
  return ids;
}

/** Why a control on the board cannot be used now, said beside it (aria-describedby), in plain words; null when it can. */
export function pausedWords(state: { unconfirmed: boolean; saving: boolean; editing: boolean }): string | null {
  if (state.unconfirmed) return "Changes are paused until you reload this page.";
  if (state.saving) return "Please wait. Your last change is still being saved.";
  if (state.editing) return "Finish the open form first: save it or cancel it.";
  return null;
}

/** The one status region's words after the search or a filter changed, said once the person stops typing. */
export function shownWords(shown: number, loaded: number): string {
  return `Showing ${shown.toLocaleString("en-US")} of ${loaded.toLocaleString("en-US")} ${loaded === 1 ? "deal" : "deals"}.`;
}

/** How long the board waits after the last key before it says how many deals are shown (never at each key). */
export const SHOWN_SAY_AFTER_MS = 800;

/** What a card's Move button points to while no new stage is chosen: why it does nothing yet (AX274, 6). */
export const MOVE_HINT = "Choose a new stage, then press Move.";

/** Said once, at the top of the board, for a pipeline this person may only see (639 [GL7](7)); each refused change says why too. */
export const VIEW_ONLY_WORDS = "You can see this pipeline but not change it. Ask the store’s owner to change your access.";
