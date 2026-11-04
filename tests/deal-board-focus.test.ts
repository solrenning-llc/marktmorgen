/**
 * The deals board's AAA review (635 [GL3], AX274): where focus goes after a
 * removal, which controls an error is about, why a control is off, and what
 * the one status region says. The browser check of the same board is
 * tests/e2e/deals-board-focus.mjs.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES, type Stage } from "@/lib/crm-rules";
import { MOVE_HINT, PIPELINE_NAME_ID, SHOWN_SAY_AFTER_MS, VIEW_ONLY_WORDS, crmFieldChoicesId, crmFieldNameId, dealErrorField, fieldProblems, neighborAfterRemoval, pausedWords, pipelineProblems, shownWords, stageKindId, stageNameId } from "@/lib/deal-board-focus";
import { done, is, part } from "./check";

part("Focus after a removal (2.4.3)");
is("the one after it", neighborAfterRemoval(["a", "b", "c"], "b"), "c");
is("the last one: the one before it", neighborAfterRemoval(["a", "b", "c"], "c"), "b");
is("the only one: nothing, so the board falls back to the stage's heading", neighborAfterRemoval(["a"], "a"), null);
is("one not in the list: nothing", neighborAfterRemoval(["a", "b"], "z"), null);

part("An error tied to its field (3.3.1, 3.3.3)");
is("each refusal about one deal field points to that field", ["title", "value", "followup", "date", "assignee", "stage"].map(dealErrorField), ["deal-field-title", "deal-field-value", "deal-field-nextAction", "deal-field-dueDate", "deal-field-assignee", "deal-field-stage"]);
is("a refusal about no one field points nowhere (it goes in the alert)", ["full", "crm_conflict", "crm_write_unconfirmed", "pipeline_access", "toString", "__proto__"].map(dealErrorField), [null, null, null, null, null, null]);
const stages: Stage[] = [{ id: "s1", name: "New", kind: "open" }, { id: "s2", name: " ", kind: "won" }, { id: "s3", name: "Lost", kind: "lost" }];
is("a pipeline: an empty stage name", pipelineProblems({ name: "Sales", stages }, []), [stageNameId("s2")]);
is("a pipeline: an empty name, or one another pipeline has (any case), comes first", [pipelineProblems({ name: "", stages: DEFAULT_STAGES }, []), pipelineProblems({ name: " sales ", stages: DEFAULT_STAGES }, ["Sales"])], [[PIPELINE_NAME_ID], [PIPELINE_NAME_ID]]);
is("a pipeline with no won stage points to the first stage's \"Counts as\"", pipelineProblems({ name: "Sales", stages: stages.map((s) => ({ ...s, name: "x", kind: "open" as const })) }, []), [stageKindId("s1")]);
is("a pipeline the board sees nothing wrong with: no control", pipelineProblems({ name: "Sales", stages: DEFAULT_STAGES }, ["Coaching"]), []);
is("fields: an empty or repeated name, and a choice with fewer than two options", fieldProblems([
  { id: "f1", name: "Company", type: "text", optionsText: "" },
  { id: "f2", name: " company ", type: "text", optionsText: "" },
  { id: "f3", name: "", type: "text", optionsText: "" },
  { id: "f4", name: "Offer", type: "choice", optionsText: "Coaching, , Coaching" },
]), [crmFieldNameId("f2"), crmFieldNameId("f3"), crmFieldChoicesId("f4")]);
is("fields with names of their own and two choices: nothing", fieldProblems([{ id: "f1", name: "Company", type: "text", optionsText: "" }, { id: "f4", name: "Offer", type: "choice", optionsText: "Coaching, Course" }]), []);

part("Why a control is off (AX274, 6), in plain words");
is("in the order that matters: not confirmed, saving, an editor open; nothing when the board can be used", [
  pausedWords({ unconfirmed: true, saving: true, editing: true }),
  pausedWords({ unconfirmed: false, saving: true, editing: true }),
  pausedWords({ unconfirmed: false, saving: false, editing: true }),
  pausedWords({ unconfirmed: false, saving: false, editing: false }),
], ["Changes are paused until you reload this page.", "Please wait. Your last change is still being saved.", "Finish the open form first: save it or cancel it.", null]);
is("Move says how to use it while no new stage is chosen", MOVE_HINT, "Choose a new stage, then press Move.");
is("short sentences, each under 15 words", [MOVE_HINT, VIEW_ONLY_WORDS, pausedWords({ unconfirmed: true, saving: false, editing: false })!, pausedWords({ unconfirmed: false, saving: true, editing: false })!, pausedWords({ unconfirmed: false, saving: false, editing: true })!].every((words) => words.split(/(?<=\.)\s+/).every((sentence) => sentence.split(/\s+/).length < 15)), true);

part("The one status region (4.1.3)");
is("how many deals are shown, short, with one or many", [shownWords(3, 12), shownWords(1, 1), shownWords(1200, 1500)], ["Showing 3 of 12 deals.", "Showing 1 of 1 deal.", "Showing 1,200 of 1,500 deals."]);
is("said once the person stops typing, never at each key", SHOWN_SAY_AFTER_MS >= 500, true);

part("The board itself (read from its source: states a server drawing cannot reach)");
const board = readFileSync("components/deals-board.tsx", "utf8");
is("one status region and no other live region than the alerts", [(board.match(/role="status"/g) ?? []).length, (board.match(/aria-live=/g) ?? []).length], [1, 0]);
is("no control is disabled outright, so focus is never lost to a disabled control (2.4.3)", [(board.match(/(?<![-\w])disabled=\{/g) ?? []).length, board.includes("disabled={paused} whyId={WHY_ID}"), /<fieldset disabled/.test(board)], [1, true, false]);
is("removing a deal asks first and sends nothing before \"Remove deal\" (3.3.6)", [board.includes("setConfirming(deal.id); moveFocus(`deal-confirm-${deal.id}`)"), board.includes('onClick={() => removeDeal(deal)}'), board.includes("Keep deal"), (board.match(/action: "undeal"/g) ?? []).length], [true, true, true, 1]);
is("a stage select only marks a stage; nothing sends it but Move (3.2.2, 3.2.5)", [board.includes('onChange={(e) => stageEvent(deal, { kind: "change", value: e.target.value })}'), board.includes("onBlur={() => stageEvent"), board.includes('if (event.kind === "change" && step.pending !== undefined) say(')], [true, false, true]);
is("the view-only notice is drawn once, at the top of the board", (board.match(/VIEW_ONLY_WORDS/g) ?? []).length, 2);
done();
