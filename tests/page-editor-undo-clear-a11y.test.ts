/**
 * The page editor's lists, Clear, Undo and Redo, from a keyboard and a screen
 * reader (components/page-editor.tsx; AX274 Part A, WCAG 2.2 AAA). The second
 * part of tests/page-editor-block-actions-a11y.test.ts.
 *
 * Seen in Chromium on 6 November 2026, /studio/pages, with the keyboard only,
 * after the block row's own buttons were fixed:
 *
 * - removing an item inside a block (a point, a question, a step, a row of a
 *   comparison, a quotation, a picture) took its Remove button away with the
 *   focus in it, to the page's body, whenever the item was the last of its
 *   list, and for any picture, whose rows follow the picture (WCAG 2.4.3);
 * - "Yes, clear it" turned itself off under the focus while the page was
 *   cleared, and the whole question went away once it was, so the focus fell
 *   to the body (WCAG 2.4.3);
 * - Undo and Redo, pressed or from Ctrl+Z and Ctrl+Shift+Z, changed the page
 *   and said nothing of what came back or went; the last step back turned the
 *   button off under the focus (WCAG 4.1.3, 2.4.3);
 * - a block's Move up or Move down pressed where it cannot move (the first,
 *   the last, the one under the hero, the hero) did nothing and said nothing
 *   (WCAG 4.1.3);
 * - the same words said twice in a row, a second "Nothing to undo.", were not
 *   said again: the status region's text did not change.
 *
 * What is checked here, against the real code: the words and the focus
 * targets worked out in lib/block-insert.ts, and the editor calling them. What
 * is drawn and where the focus lands in a browser is checked by the scratch
 * audit named in the pull request, not here.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import * as insert from "@/lib/block-insert";

// Read by name, so a helper still missing fails its own lines rather than the whole file.
const helper = (name: string) => (insert as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>)[name] ?? (() => undefined);
const itemFocusAfterRemoval = helper("itemFocusAfterRemoval");
const itemRemoveId = helper("itemRemoveId");
const itemAddId = helper("itemAddId");
const stepSaying = helper("stepSaying");
const noStepSaying = helper("noStepSaying");
const whyStuck = helper("whyStuck");
const stuckSaying = helper("stuckSaying");

const editor = readFileSync("components/page-editor.tsx", "utf8");
const main = editor.slice(0, editor.indexOf("function RowEditor("));
const between = (from: string, to: string) => {
  const a = editor.indexOf(from);
  const b = a < 0 ? -1 : editor.indexOf(to, a + from.length);
  return a < 0 || b < 0 ? "" : editor.slice(a, b);
};

part("Removing an item inside a block moves the focus (WCAG 2.4.3)");
is("the ids of an item's Remove button and of its list's Add button", [itemRemoveId("b1-y", 2), itemAddId("b1-y")], ["b1-y-remove-2", "b1-y-add"]);
is("a middle item: the one now in its place, once the list is drawn again", itemFocusAfterRemoval("b1", 1, 3), { focus: "b1-remove-1", gone: "b1-remove-2" });
is("the last item: the one before it", itemFocusAfterRemoval("b1", 2, 3), { focus: "b1-remove-1", gone: "b1-remove-2" });
is("the only item: the list's Add button", itemFocusAfterRemoval("b1", 0, 1), { focus: "b1-add", gone: "b1-remove-0" });
const lists = ["function QuotesEditor(", "function CompareEditor(", "function ListEditor(", "function PairEditor(", "function PicturesEditor("].map((name) => {
  const at = editor.indexOf(name);
  const end = editor.indexOf("\nfunction ", at + name.length);
  return at < 0 ? "" : editor.slice(at, end < 0 ? undefined : end);
});
is("the five lists are found", lists.map((l) => l.length > 0), [true, true, true, true, true]);
is("each item's Remove button has its id", lists.map((l) => l.includes("id={itemRemoveId(base, i)}")), [true, true, true, true, true]);
is("each list's Add button has its id", lists.map((l) => l.includes("id={itemAddId(base)}")), [true, true, true, true, true]);
is("each Remove sends the focus on", lists.map((l) => /focusItemAfterRemoval\(base, i, (items|rows)\.length(, away)?\)/.test(l)), [true, true, true, true, true]);
// A pictures list draws its Add button only while the page has room for another picture: with none left, the last
// picture removed sends the focus to the block's heading field, never to the body (Claude 5's LIGHT 1 on #2926).
is("a pictures list passes on where the focus goes with no Add button drawn", /focusItemAfterRemoval\(base, i, items\.length, away\)/.test(lists[4]), true);
const pictureBlocks = [between('case "pictures": {', "case \"countdown\""), between('case "feature": {', "</fieldset>")];
is("the pictures block and the picture-and-text block send it to their heading field", pictureBlocks.map((b) => b.includes("<PicturesEditor") && b.includes("away={`${base}-h`}") && b.includes("id={`${base}-h`}")), [true, true]);
// A picture in a column is one part of the row (single): it draws no Remove button of its own, so the row's own
// Remove moves the focus, and the pictures list never sends it too (Claude 5's LIGHT 2 on #2926).
const picturesOwn = lists[4];
const removeAt = picturesOwn.indexOf("id={itemRemoveId(base, i)}");
is("in a pictures list, the Remove button is drawn only when it is not a part of something else", removeAt > 0 && picturesOwn.lastIndexOf("{single ? null : (", removeAt) > 0, true);
const columnPicture = between('case "image":', 'case "video":');
is("a column's picture is single, without a place to send the focus of its own", columnPicture.includes("<PicturesEditor") && /\n\s+single\n/.test(columnPicture) && !columnPicture.includes("away="), true);
is("the row's own Remove takes a column's part away and says where the focus goes", /aria-label=\{`Remove: \$\{what\}`\} onClick=\{\(\) => remove\(place\)\}/.test(editor) && between("function remove(place: RowPlace) {", "\n  }\n").includes("`${base}-c${place.column}-add`"), true);
const sendOn = between("function focusItemAfterRemoval(", "\n}\n");
is("the focus waits for the list to be drawn again, then goes where itemFocusAfterRemoval says", /itemFocusAfterRemoval\(base, at, count\)/.test(sendOn) && /document\.getElementById\(gone\) \? null : document\.getElementById\(focus\)/.test(sendOn), true);

part("Clearing the page keeps the focus, then moves it (WCAG 2.4.3)");
// The button's own words, after its question: the refusal for a Clear (SIGNED_OUT_CLEARING) names "Yes, clear it" too.
const yesAt = editor.indexOf("Yes, clear it", editor.indexOf("Back to the plain page?"));
const yes = editor.slice(editor.lastIndexOf("<button", yesAt), yesAt);
is("Yes, clear it is never turned off under the focus", /(?<![-\w])disabled=\{/.test(yes), false);
is("it says it cannot clear now, and stays focusable", yes.includes("aria-disabled={busy || undefined}"), true);
is("a press while it cannot clear does nothing", /function clearNow\(\) \{\s*if \(busy\) return;/.test(main), true);
const cleared = between("if (page === null) {", "} else if (data.page");
is("once cleared, the focus is sent on", cleared.includes("focusAfterClear();"), true);
const clearFocus = between("function focusAfterClear() {", "\n  }\n");
is("to Add a block, once no block is drawn, or else the editor's heading", clearFocus.includes('[id^="row-"]') && clearFocus.includes('[data-place="0"]') && clearFocus.includes('getElementById("page-title")'), true);
is("the editor's heading can take the focus", /<h2 id="page-title" tabIndex=\{-1\}/.test(editor), true);

part("Undo and Redo say what came back or went (WCAG 4.1.3)");
const A = { id: "a", label: "Hero", draft: 1 };
const B = { id: "b", label: "Text", draft: 2 };
const C = { id: "c", label: "Questions", draft: 3 };
const X = { id: "x", label: "Video", draft: 4 };
is("a block brought back", stepSaying("back", [A, B, C], [A, X, B, C], false, 2), "Undone: Video is back on the page, at position 2 of 4.");
is("a block taken off again", stepSaying("forward", [A, B, C], [A, C], false, 1), "Redone: Text is off the page, from position 2.");
is("several back", stepSaying("back", [A], [A, B, C, X], false, 1), "Undone: 3 blocks are back on the page.");
is("several off", stepSaying("forward", [A, B, C, X], [A], false, 1), "Redone: 3 blocks are off the page.");
is("some back and some off", stepSaying("back", [A, B], [A, C], false, 1), "Undone: a change to the blocks on the page.");
is("a move", stepSaying("back", [A, B, C], [A, C, B], false, 1), "Undone: Questions moved to position 2 of 3.");
// A move of more than one place, by dragging or by Move pressed again within the history's 500 ms pause (one step):
// the block that went back, or forward, is named, never one only pushed aside by it (Claude 5's MEDIUM on #2926).
const P = { id: "p", label: "Guarantee", draft: 5 };
is("a drag from 5 to 2, undone: the block that went back is named", stepSaying("back", [A, P, B, C, X], [A, B, C, X, P], false, 1), "Undone: Guarantee moved to position 5 of 5.");
is("three quick Moves down, from 2 to 5, one step, redone: the block that went is named", stepSaying("forward", [A, B, C, X, P], [A, C, X, P, B], false, 0), "Redone: Text moved to position 5 of 5. Nothing more to redo.");
is("the same three Moves undone", stepSaying("back", [A, C, X, P, B], [A, B, C, X, P], false, 1), "Undone: Text moved to position 2 of 5.");
is("two quick Moves up of the Video, undone", stepSaying("back", [A, X, B, C, P], [A, B, C, X, P], false, 1), "Undone: Video moved to position 4 of 5.");
is("a drag from 3 to 5, undone", stepSaying("back", [A, B, X, P, C], [A, B, C, X, P], false, 2), "Undone: Questions moved to position 3 of 5.");
is("a drag from 3 to 5, redone", stepSaying("forward", [A, B, C, X, P], [A, B, X, P, C], false, 1), "Redone: Questions moved to position 5 of 5.");
is("a one-place move is said as before, the first block moved", [stepSaying("back", [A, B, C, X], [A, B, X, C], false, 1), stepSaying("forward", [A, B, C, X], [A, C, B, X], false, 1)], ["Undone: Video moved to position 3 of 4.", "Redone: Questions moved to position 2 of 4."]);
is("two blocks moved as far in one step: the first of them on the page", stepSaying("back", [A, B, C, X, P], [A, C, B, P, X], false, 1), "Undone: Questions moved to position 2 of 5.");
is("a change inside a block", stepSaying("back", [A, B, C], [A, { ...B, draft: 5 }, C], false, 1), "Undone: a change in Text, block 2.");
is("the page style", stepSaying("forward", [A, B], [A, B], true, 1), "Redone: the page style.");
is("anything else", stepSaying("back", [A, B], [A, B], false, 1), "Undone: the last change.");
is("the last step back says so", stepSaying("back", [A, B], [A], false, 0), "Undone: Text is off the page, from position 2. Nothing more to undo.");
is("the last step forward says so", stepSaying("forward", [A], [A, B], false, 0), "Redone: Text is back on the page, at position 2 of 2. Nothing more to redo.");
is("nothing to undo or redo", [noStepSaying("back"), noStepSaying("forward")], ["Nothing to undo.", "Nothing to redo."]);
const stepFn = between("function stepTo(direction: \"back\" | \"forward\") {", "\n  }\n");
is("a step says what it did", stepFn.includes("setSaid(stepSaying("), true);
is("a press with no step left says so", /if \(!step\) \{\s*setSaid\(noStepSaying\(direction\)\);\s*return;/.test(stepFn), true);
is("Ctrl+Z and Ctrl+Shift+Z press the same buttons", main.includes('document.getElementById("undo-step")?.click();') && main.includes('document.getElementById("redo-step")?.click();'), true);
const undoRedo = between('aria-label="Undo and redo"', "</div>");
is("Undo and Redo are never turned off under the focus", /(?<![-\w])disabled=\{/.test(undoRedo), false);
is("they say when there is nothing to do, and stay focusable", (undoRedo.match(/aria-disabled=\{/g) ?? []).length, 2);
// Off, they take the signs of an off button (.icon-btn, app/globals.css): the sand surface, the dashed
// --line-off edge and GrayText in forced colors. Told off by --ink-mute beside --ink-soft alone, they
// were 1.07:1 from a Redo that works, and forced colors drew both in ButtonText (WCAG 1.4.1, 1.4.11).
const undoRedoClasses = [...undoRedo.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
is("Undo and Redo, found", undoRedoClasses.length, 2);
is("off, each carries the off signs of an off button (icon-btn)", undoRedoClasses.every((c) => /(^| )icon-btn( |$)/.test(c)), true);
is("neither is told off by a near-identical gray alone", undoRedoClasses.some((c) => /aria-disabled:(text-ink-mute|hover:)/.test(c)), false);

part("A move that cannot be made says why (WCAG 4.1.3)");
const top = (i: number) => i === 0;
const none = () => false;
is("why a block cannot move", [whyStuck(0, 1, 3, top), whyStuck(1, -1, 3, top), whyStuck(0, -1, 3, none), whyStuck(2, 1, 3, none), whyStuck(1, 1, 3, none)], ["top", "under-top", "first", "last", null]);
is("what is said", [stuckSaying("Hero", "top", "Hero"), stuckSaying("Text", "under-top", "Hero"), stuckSaying("Text", "first", "Hero"), stuckSaying("Text", "last", "Hero")], [
  "Hero stays at the top of the page.",
  "Text is already first under the Hero, which stays at the top.",
  "Text is already first.",
  "Text is already last.",
]);
const moveFn = between("function move(index: number, by: -1 | 1) {", "\n  }\n");
is("the editor says it instead of doing nothing", /const stuck = whyStuck\(index, by, drafts\.length, /.test(moveFn) && /if \(stuck\) \{\s*setSaid\(stuckSaying\(/.test(moveFn), true);

part("The same words said twice are said again");
is("the editor's status region changes even when the words do not", main.includes('const [said, setSaidNow] = useState("");') && main.includes('setSaidNow(text ? `${text}${again.current ? "\\u00a0" : ""}` : "");'), true);

done();
