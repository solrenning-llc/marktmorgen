/**
 * The deals board's AAA review (635 [GL3], AX274): where focus goes after a
 * removal, which controls an error is about, why a control is off, and what
 * the one status region says. The browser check of the same board is
 * tests/e2e/deals-board-focus.mjs.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES, type Stage } from "@/lib/crm-rules";
import { moveConflictWords, MOVE_HINT, PIPELINE_NAME_ID, SHOWN_SAY_AFTER_MS, VIEW_ONLY_WORDS, crmFieldChoicesId, crmFieldNameId, dealErrorField, fieldProblems, neighborAfterRemoval, pausedWords, pipelineProblems, shownWords, stageKindId, stageNameId } from "@/lib/deal-board-focus";
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
is("names are read as the server keeps them (oneLine): spaces and control characters made one space, without case", [pipelineProblems({ name: "Big  deals", stages: DEFAULT_STAGES }, ["big deals"]), fieldProblems([{ id: "f1", name: "Start\tdate", type: "text", optionsText: "" }, { id: "f2", name: "start  date", type: "text", optionsText: "" }])], [[PIPELINE_NAME_ID], [crmFieldNameId("f2")]]);
is("a choice's options are cut at the server's 40 characters, so two that only differ after it are one", fieldProblems([{ id: "f4", name: "Offer", type: "choice", optionsText: `${"x".repeat(40)}a, ${"x".repeat(40)}b` }]), [crmFieldChoicesId("f4")]);
is("fields with names of their own and two choices: nothing", fieldProblems([{ id: "f1", name: "Company", type: "text", optionsText: "" }, { id: "f4", name: "Offer", type: "choice", optionsText: "Coaching, Course" }]), []);

part("Why a control is off (AX274, 6), in plain words");
is("in the order that matters: not confirmed, saving, an editor open; nothing when the board can be used", [
  pausedWords({ unconfirmed: true, saving: true, editing: true }),
  pausedWords({ unconfirmed: false, saving: true, editing: true }),
  pausedWords({ unconfirmed: false, saving: false, editing: true }),
  pausedWords({ unconfirmed: false, saving: false, editing: false }),
], ["Changes are paused until you reload this page.", "Please wait. Your last change is still being saved.", "Finish the open form first: save it or cancel it.", null]);
is("after an answer, loading the deals is never called saving (L-F)", [pausedWords({ unconfirmed: false, saving: false, refreshing: true, editing: false }), pausedWords({ unconfirmed: false, saving: false, refreshing: true, editing: true })], ["Please wait. The latest deals are loading.", "Please wait. The latest deals are loading."]);
is("a refused move says where the deal is now (M-A)", [moveConflictWords("here"), moveConflictWords("filtered"), moveConflictWords({ pipeline: "Coaching" })], ["This deal changed a moment ago, so it was not moved. Check it and move it again.", "This deal changed a moment ago, so it was not moved. It no longer matches your search or filter, so it is not shown here.", "This deal changed a moment ago and is now in Coaching, so it was not moved. Open Coaching to check it."]);
is("Move says how to use it while no new stage is chosen", MOVE_HINT, "Choose a new stage, then press Move.");
is("the view-only words use the typographic apostrophe", [VIEW_ONLY_WORDS.includes("store’s"), VIEW_ONLY_WORDS.includes("'")], [true, false]);
is("short sentences, each under 15 words", [MOVE_HINT, VIEW_ONLY_WORDS, pausedWords({ unconfirmed: true, saving: false, editing: false })!, pausedWords({ unconfirmed: false, saving: true, editing: false })!, pausedWords({ unconfirmed: false, saving: false, editing: true })!].every((words) => words.split(/(?<=\.)\s+/).every((sentence) => sentence.split(/\s+/).length < 15)), true);

part("The one status region (4.1.3)");
is("how many deals are shown, short, with one or many", [shownWords(3, 12), shownWords(1, 1), shownWords(1200, 1500)], ["Showing 3 of 12 deals.", "Showing 1 of 1 deal.", "Showing 1,200 of 1,500 deals."]);
is("said once the person stops typing, never at each key", SHOWN_SAY_AFTER_MS >= 500, true);

part("An off control is never faded (app/globals.css): its focus ring keeps its contrast (2.4.11, 2.4.13)");
const css = readFileSync("app/globals.css", "utf8");
const offButton = css.slice(css.indexOf('.btn[aria-disabled="true"],'), css.indexOf("}", css.indexOf('.btn[aria-disabled="true"],')));
is("an aria-disabled button is opaque, with a light dashed edge (--line-off), on sand, in --ink-soft (9.3:1)", [/opacity:\s*1;/.test(offButton), offButton.includes("border: 1px dashed var(--line-off)"), offButton.includes("background-color: var(--sand)"), offButton.includes("color: var(--ink-soft)"), css.includes("--line-off: #857f70;")], [true, true, true, true, true]);
is("on the dark surfaces it takes their own tokens (L-G)", /:is\(\.on-dark, \.surface-night, \.surface-daybreak, \.surface-navy, \.surface-signature\) \.btn\[aria-disabled="true"\][^{]*\{[^}]*background-color: transparent;[^}]*color: var\(--on-dark-2\);[^}]*border-color: var\(--on-dark-3\);/.test(css), true);
is("no rule fades an aria-disabled button", /\[aria-disabled="true"\][^{]*\{[^}]*opacity:\s*0\./.test(css), false);
is("an aria-disabled field is drawn as off without fading", /\.field\[aria-disabled="true"\] \{[^}]*border-style: dashed;[^}]*\}/.test(css) && !/\.field\[aria-disabled="true"\] \{[^}]*opacity/.test(css), true);
is("in forced colors the words are GrayText and the dashed border stays, for buttons and fields (L-C)", [/@media \(forced-colors: active\) \{\s*\/\*[^*]*\*\/\s*\.btn\[aria-disabled="true"\],[^}]*color: GrayText;\s*border-style: dashed;/.test(css), /@media \(forced-colors: active\) \{\s*\.field\[aria-disabled="true"\] \{\s*color: GrayText;\s*border-style: dashed;/.test(css)], [true, true]);

part("The board itself (read from its source: states a server drawing cannot reach)");
const board = readFileSync("components/deals-board.tsx", "utf8");
is("one status region and no other live region than the alerts", [(board.match(/role="status"/g) ?? []).length, (board.match(/aria-live=/g) ?? []).length], [1, 0]);
is("no control is disabled outright, so focus is never lost to a disabled control (2.4.3)", [(board.match(/(?<![-\w])disabled=\{/g) ?? []).length, board.includes("disabled={paused} whyId={WHY_ID}"), /<fieldset disabled/.test(board)], [1, true, false]);
is("removing a deal asks first and sends nothing before \"Remove deal\" (3.3.6)", [board.includes("setConfirming({ id: deal.id, stage: deal.stage }); moveFocus(`deal-confirm-${deal.id}`)"), board.includes('onClick={() => removeDeal(deal)}'), board.includes("Keep deal"), (board.match(/action: "undeal"/g) ?? []).length], [true, true, true, 1]);
is("a removal question left open closes for good once its deal is not on the board where it was asked (C3-118; browser check in tests/e2e/deals-board-focus.mjs)", [board.includes('view === "board" && visibleDeals.some(d => d.id === confirming.id && d.stage === confirming.stage)'), board.includes("if (confirming && !confirmingId) setConfirming(null);"), (board.match(/confirming === deal\.id/g) ?? []).length], [true, true, 0]);
is("a stage select only marks a stage; nothing sends it but Move (3.2.2, 3.2.5)", [board.includes('onChange={(e) => stageEvent(deal, { kind: "change", value: e.target.value })}'), board.includes("onBlur={() => stageEvent"), board.includes('if (step.pending !== undefined) sayLater(stageChosenText(step.pending, stageName))')], [true, false, true]);
is("the view-only notice is drawn once, at the top of the board", (board.match(/VIEW_ONLY_WORDS/g) ?? []).length, 2);
is("\"Use this\" is off while saving and says why (M3)", board.includes('{...offProps(locked, EDITOR_WHY_ID)} onClick={() => { if (locked) return; const taken = takeSaved'), true);
is("a 409 moves focus to the part in conflict, even from Save (H1)", board.includes("moveFocus(conflictFocus(rebased.conflicts))"), true);
is("a removed stage or field takes its error marks with it (M-B)", [board.includes("fixed(stageNameId(stage.id), stageKindId(stage.id))"), board.includes("fixed(crmFieldNameId(field.id), crmFieldChoicesId(field.id))")], [true, true]);
done();
