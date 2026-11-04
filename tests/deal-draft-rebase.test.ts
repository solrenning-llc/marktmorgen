/**
 * 635 [GL3]: the deals board's editor sends only what the creator changed,
 * and on a conflict puts those changes back on the deal as it is now
 * (lib/deal-draft.ts), so nothing typed is lost and nothing written by a
 * workflow step meanwhile is overwritten.
 */
import { changedFields, dealChanges, draftFromDeal, emptyDraft, rebaseDraft } from "@/lib/deal-draft";
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
is("only the note changed: the step's assignee, next action and date come in, with the creator's note", [rebased.note, rebased.assignee, rebased.nextAction, rebased.dueDate, rebased.stage], ["Sent the proposal", "maya@example.com", "Call Dana back", "2026-11-10", "lead00"]);
is("and the next save sends only the note again", dealChanges(draftFromDeal(now, "usd"), rebased, "usd"), { id: "abcdefghij", note: "Sent the proposal" });
const both = rebaseDraft(base, { ...base, assignee: "sam@example.com", nextAction: "Send the contract" }, now, "usd");
is("a field changed by both keeps the creator's value", [both.assignee, both.nextAction, both.dueDate], ["sam@example.com", "Send the contract", "2026-11-10"]);
const cleared = rebaseDraft({ ...base, note: "First call" }, { ...base, note: "" }, { ...now, note: "Edited by a teammate" }, "usd");
is("a field the creator emptied stays empty", cleared.note, "");
is("nothing typed: the deal as it is now", rebaseDraft(base, base, now, "usd"), draftFromDeal(now, "usd"));
done();
