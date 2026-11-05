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
export function pausedWords(state: { unconfirmed: boolean; saving: boolean; refreshing?: boolean; editing: boolean }): string | null {
  if (state.unconfirmed) return "Changes are paused until you reload this page.";
  if (state.saving) return "Please wait. Your last change is still being saved.";
  // After a change was answered (saved or refused), the board loads the deals as they are now: nothing is being saved.
  if (state.refreshing) return "Please wait. The latest deals are loading.";
  if (state.editing) return "Finish the open form first: save it or cancel it.";
  return null;
}

/**
 * What the board says when a move was refused because the deal changed
 * meanwhile (635 [GL3]): where it is now decides the words, so nobody looks
 * for a card that is no longer shown. Nothing the creator chose is lost.
 */
export function moveConflictWords(now: "here" | "filtered" | { pipeline: string }): string {
  if (now === "here") return "This deal changed a moment ago, so it was not moved. Check it and move it again.";
  if (now === "filtered") return "This deal changed a moment ago, so it was not moved. It no longer matches your search or filter, so it is not shown here.";
  return `This deal changed a moment ago and is now in ${now.pipeline}, so it was not moved. Open ${now.pipeline} to check it.`;
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

/**
 * A calendar day (YYYY-MM-DD, as a deal keeps it) said the way the studio says
 * a day: "November 4, 2026" (3.1.3, AX274). Anything else is shown as it is,
 * never turned into an invented date.
 */
export function dealDayWords(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day) return day;
  return at.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** What the board says, once, about the words "pipeline" and "stage" (3.1.3). */
export const PIPELINE_WORDS = "A pipeline is the list of steps a deal goes through, from the first talk to won or lost. Each step is a stage.";

/** What "Counts as" means, said beside the stages it is chosen for (3.1.3, 3.3.5). */
export const KIND_WORDS_HELP = "“Counts as” says what a stage means: Open while you are still talking, Won when they bought, Lost when they did not.";

/** Why the board's dates name a time zone (3.1.4: the abbreviation spelled out where it is used). */
export function boardDayWords(today: string): string {
  return `Dates follow the calendar in Coordinated Universal Time (UTC), where today is ${dealDayWords(today)}.`;
}

/** A stage named in a button's spoken name ("Move stage “Talking” up"); a stage with no name yet is called by its place. */
export function stageControlName(name: string, index: number): string {
  const shown = name.trim();
  return shown ? `stage “${shown}”` : `stage ${index + 1}`;
}

/** A field named in a control's spoken name ("Remove field “Company”"); a field with no name yet is called by its place. */
export function fieldControlName(name: string, index: number): string {
  const shown = name.trim();
  return shown ? `field “${shown}”` : `field ${index + 1}`;
}

/** The saved fields a save would remove (their answers go with them, lib/crm.ts writeFields), in their saved order. */
export function removedFields<T extends { id: string }>(saved: readonly T[], draft: readonly { id: string }[]): T[] {
  const kept = new Set(draft.map((field) => field.id));
  return saved.filter((field) => !kept.has(field.id));
}

/** The review shown before a save that removes fields (3.3.6): what goes, and that it cannot come back. */
export function fieldRemovalWords(names: readonly string[]): { title: string; text: string } {
  const list = names.map((name) => `“${name}”`).join(", ");
  return {
    title: names.length === 1 ? "Remove 1 field and its answers?" : `Remove ${names.length} fields and their answers?`,
    text: `Saving removes ${list}. Every answer kept about a person for ${names.length === 1 ? "it" : "them"} is deleted. You cannot get ${names.length === 1 ? "it" : "them"} back.`,
  };
}

/** The review shown before a pipeline is removed (3.3.6): where its deals go, and that it cannot come back. */
export function pipelineRemovalWords(pipeline: string, holding: number, target: string | null): { title: string; text: string } {
  const deals = holding === 0 ? "" : `Its ${holding === 1 ? "deal moves" : `${holding} deals move`} to ${target ?? "the stage you chose"}. `;
  return { title: `Remove “${pipeline}”?`, text: `${deals}The pipeline and its stages are deleted. You cannot get them back.` };
}
