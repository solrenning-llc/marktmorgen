/**
 * 635 [GL3]: the deals board's editor sends only what the creator changed,
 * and on a conflict puts those changes back on the deal as it is now
 * (lib/deal-draft.ts), so nothing typed is lost and nothing written by a
 * workflow step meanwhile is overwritten.
 */
import { DEAL_HIDDEN, DEAL_SAVE_ID, changedFields, conflictFocus, conflictMessage, dealChanges, dealFieldId, draftFromDeal, emptyDraft, oneAtATime, rebaseDraft, refusalKind, savedNowText } from "@/lib/deal-draft";
import type { Deal } from "@/lib/crm-rules";
import { done, is, part } from "./check";

const opened: Deal = { id: "abcdefghij", title: "Six sessions", email: "dana@example.com", cents: 90000, stage: "lead00", note: "First call", createdAt: 1, updatedAt: 1 };
const base = draftFromDeal(opened, "usd");
// What a "rotate" step wrote after the board was loaded.
const now: Deal = { ...opened, assignee: "maya@example.com", nextAction: "Call Dana back", dueDate: "2026-11-10", updatedAt: 2 };

part("What a save sends");
is("a deal as opened: empty fields are empty text", [base.value, base.assignee, base.nextAction, base.dueDate], ["900", "", "", ""]);
is("nothing changed: only the id, no field", dealChanges(base, base, "usd"), { id: "abcdefghij" });
is("only the note changed: only the note", dealChanges(base, { ...base, note: "Sent the proposal" }, "usd"), { id: "abcdefghij", note: "Sent the proposal" });
is("the amount, in cents, only when it changed", [dealChanges(base, { ...base, value: "1250.50" }, "usd"), dealChanges(base, { ...base, value: "" }, "usd")], [{ id: "abcdefghij", cents: 125050 }, { id: "abcdefghij", cents: 0 }]);
is("an amount that is not one: nothing sent", dealChanges(base, { ...base, value: "a lot" }, "usd"), null);
is("an amount that is not one but unchanged is never read", dealChanges({ ...base, value: "a lot" }, { ...base, value: "a lot", title: "x" }, "usd"), { id: "abcdefghij", title: "x" });
is("what changed, by field", changedFields(base, { ...base, stage: "won000", assignee: "sam@example.com" }), ["stage", "assignee"]);
is("a new deal starts empty in the first open stage", emptyDraft("lead00"), { id: "", title: "", email: "", value: "", stage: "lead00", note: "", nextAction: "", dueDate: "", assignee: "" });

part("Putting the creator's changes back on the deal as it is now");
const typed = { ...base, note: "Sent the proposal" };
const rebased = rebaseDraft(base, typed, now, "usd");
is("only the note changed: the step's assignee, next action and date come in, with the creator's note", [rebased.draft.note, rebased.draft.assignee, rebased.draft.nextAction, rebased.draft.dueDate, rebased.draft.stage], ["Sent the proposal", "maya@example.com", "Call Dana back", "2026-11-10", "lead00"]);
is("no part changed on both sides: no conflict", rebased.conflicts, []);
is("and the next save sends only the note again", dealChanges(draftFromDeal(now, "usd"), rebased.draft, "usd"), { id: "abcdefghij", note: "Sent the proposal" });
const both = rebaseDraft(base, { ...base, assignee: "sam@example.com", nextAction: "Send the contract" }, now, "usd");
is("a part changed by both keeps the creator's value", [both.draft.assignee, both.draft.nextAction], ["sam@example.com", "Send the contract"]);
is("the next action and its date are one: the creator's action never gets the step's date", [both.draft.nextAction, both.draft.dueDate], ["Send the contract", ""]);
is("each part changed by both is a conflict, with what is saved now", both.conflicts, [{ unit: "followUp", saved: { nextAction: "Call Dana back", dueDate: "2026-11-10" } }, { unit: "assignee", saved: { assignee: "maya@example.com" } }]);
is("a part both changed to the same thing is no conflict", rebaseDraft(base, { ...base, assignee: "maya@example.com" }, now, "usd").conflicts, []);
const cleared = rebaseDraft({ ...base, note: "First call" }, { ...base, note: "" }, { ...now, note: "Edited by a teammate" }, "usd");
is("a field the creator emptied stays empty, and what was saved is offered", [cleared.draft.note, cleared.conflicts], ["", [{ unit: "note", saved: { note: "Edited by a teammate" } }]]);
is("nothing typed: the deal as it is now", rebaseDraft(base, base, now, "usd"), { draft: draftFromDeal(now, "usd"), conflicts: [] });

part("What the editor says and where focus goes");
const words = conflictMessage(both.conflicts);
is("the message names each part somebody else changed too", words, "This deal changed while you were editing. Your changes are kept. Someone else also changed the next action and its date and the responsible teammate. What is saved now is shown beside each. Choose, then save again.");
is("every sentence is under 21 words", words.split(/(?<=\.) /).every((sentence) => sentence.split(/\s+/).length < 21), true);
is("with no part in conflict, it says only that the changes are kept", conflictMessage([]), "This deal changed while you were editing. Your changes are kept. Check them and save again.");
const many = conflictMessage(["title", "email", "value", "stage", "note"].map((unit) => ({ unit: unit as never, saved: {} })));
is("many parts are counted, so no sentence runs long", [many.includes("Someone else also changed 5 parts of it."), many.split(/(?<=\.) /).every((sentence) => sentence.split(/\s+/).length < 21)], [true, true]);
is("focus goes to the first part in conflict, in the editor's order", [conflictFocus(both.conflicts), conflictFocus([{ unit: "note", saved: {} }, { unit: "value", saved: {} }])], [dealFieldId("nextAction"), dealFieldId("value")]);
is("and to Save when none is", conflictFocus([]), DEAL_SAVE_ID);
const stageName = (id: string) => ({ won000: "Won" } as Record<string, string>)[id] ?? "?";
is("what is saved now, in words", [
  savedNowText(both.conflicts[0], "usd", stageName),
  savedNowText({ unit: "followUp", saved: { nextAction: "Call", dueDate: "" } }, "usd", stageName),
  savedNowText({ unit: "followUp", saved: { nextAction: "", dueDate: "" } }, "usd", stageName),
  savedNowText({ unit: "assignee", saved: { assignee: "" } }, "usd", stageName),
  savedNowText({ unit: "value", saved: { value: "1250.5" } }, "usd", stageName),
  savedNowText({ unit: "stage", saved: { stage: "won000" } }, "usd", stageName),
  savedNowText({ unit: "note", saved: { note: "" } }, "usd", stageName),
], ["Call Dana back, on 2026-11-10", "Call, with no date", "no next action", "Unassigned", "1250.5 USD", "Won", "nothing"]);

part("A refused change: put back, closed, or said");
is("an edit's conflict with the deal as it is now: put back", refusalKind("deal", { error: "crm_conflict", current: {} }), "rebase");
is("an edit's conflict with nothing sent back (moved where they cannot see it): closed", [refusalKind("deal", { error: "crm_conflict" }), DEAL_HIDDEN], ["hidden", "This deal moved where you cannot see it. Nothing was saved."]);
is("a pipeline change's conflict, or any other refusal: its own words", [refusalKind("pipeline", { error: "crm_conflict" }), refusalKind("deal", { error: "title" })], ["message", "message"]);

part("One change at a time, decided at once");
const gate = oneAtATime();
is("the first change goes, a second before its answer does not, the next one after it does", [gate.enter(), gate.enter(), (gate.leave(), gate.enter())], [true, false, true]);
done();
