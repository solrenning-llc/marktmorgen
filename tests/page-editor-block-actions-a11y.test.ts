/**
 * The page editor's block list, from a keyboard and a screen reader
 * (components/page-editor.tsx; AX274 Part A, WCAG 2.2 AAA).
 *
 * Seen in Chromium on 6 November 2026, /studio/pages at 320, 390 and 1280
 * pixels, with the keyboard only:
 *
 * - each block's Move up, Move down, Duplicate and Remove buttons were 40 by
 *   40 pixels, under the 44 by 44 of WCAG 2.5.5; so were a comparison
 *   table's yes and no cells and a list's Remove item, and a step's, a
 *   question's, a row's, a quotation's and a picture's buttons were 36;
 *   "Earlier versions", "Saved sections" and "Search and sharing" opened
 *   from a line 20 to 24 pixels high;
 * - at 320 pixels, and at 400% zoom, each block's name was squeezed to 12
 *   pixels beside its four buttons, so it could be neither read nor pressed
 *   (WCAG 1.4.10, 2.5.5);
 * - pressing Save turned it off under the focus, and the focus fell to the
 *   body whether the save worked or was refused (WCAG 2.4.3);
 * - moving a block to the first or last place it can take turned its button
 *   off while it had the focus, and the focus fell to the page's body
 *   (WCAG 2.4.3); nothing said where the block went (WCAG 4.1.3);
 * - removing a block took its row away with the focus in it, to the body,
 *   and nothing said it was gone or that Undo brings it back (WCAG 2.4.3,
 *   3.3.6, 4.1.3);
 * - the choice that is on, in Build or Preview, the page's style and a
 *   block's "Shows on", was told apart by color and shadow only, which
 *   forced colors take away (WCAG 1.4.1, 1.4.11); the editor's other
 *   switches already show a check beside the one that is on.
 *
 * What is checked here, against the real code: the sizes in the classes,
 * the buttons kept focusable at an edge, the words said after a move and a
 * removal, where the focus goes after a removal, and the check beside a
 * choice that is on, and the wide layout drawn by the style sheet from the
 * first paint: at 1280 pixels the editor was drawn in one column and then,
 * once its script ran, in two, so the column of blocks went from 856 to 426
 * pixels and what was under it moved down (a layout shift of 0.0895 on a
 * slow network). What is drawn and where the focus lands in a browser is
 * checked by the scratch audit named in the pull request, not here.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import * as insert from "@/lib/block-insert";

// Read by name, so a helper still missing fails its own lines rather than the whole file.
const helper = (name: string) => (insert as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>)[name] ?? (() => undefined);
const movedSaying = helper("movedSaying");
const removedSaying = helper("removedSaying");
const focusAfterRemoval = helper("focusAfterRemoval");

const editor = readFileSync("components/page-editor.tsx", "utf8");
const picker = readFileSync("components/page-style-picker.tsx", "utf8");

/** The block row's four buttons, from the first Move to the end of Remove. */
const rowStart = editor.indexOf("onClick={() => move(index, -1)}");
const rowEnd = editor.indexOf("<Icon name=\"trash\" size={17} />", rowStart);
const row = rowStart > 0 && rowEnd > rowStart ? editor.slice(rowStart - 200, rowEnd) : "";

part("Targets of at least 44 by 44 pixels (WCAG 2.5.5)");
is("the block row is found", row.length > 0, true);
is("no 40-pixel button anywhere in the editor", editor.includes("h-10 w-10"), false);
is("the row's four buttons are 44 pixels", (row.match(/h-11 w-11/g) ?? []).length, 4);

part("Smaller buttons inside a block's panel, and the lines that open more");
is("no 36-pixel button in a block's panel", /inline-flex h-9 w-9/.test(editor), false);
const summaries = [...editor.matchAll(/<summary className="([^"]*)"/g), ...readFileSync("components/saved-sections.tsx", "utf8").matchAll(/<summary className="([^"]*)"/g)].map((m) => m[1]);
is("three lines that open more, found", summaries.length, 3);
is("each at least 44 pixels high", summaries.every((c) => /\bpy-3\b/.test(c) && /-my-3\b/.test(c)), true);

part("A block's name keeps its room on a narrow screen (WCAG 1.4.10, 2.5.5)");
const header = editor.slice(editor.indexOf("{/* The handle: dragged with a mouse"), rowStart);
const headerRow = editor.slice(editor.lastIndexOf("<div className=", editor.indexOf("{/* The handle: dragged with a mouse")), editor.indexOf("{/* The handle: dragged with a mouse"));
is("the row wraps its buttons under the name when there is no room", /flex-wrap/.test(headerRow), true);
is("the name keeps at least 9rem", /min-w-\[9rem\]/.test(header), true);
is("the buttons stay together, at the end", /<div className="ml-auto flex shrink-0 items-center">/.test(editor), true);

part("Save keeps the focus (WCAG 2.4.3)");
const save = editor.slice(editor.indexOf('onClick={() => send(pageToSend(), "Page saved.")}') - 40, editor.indexOf('{busy ? "Saving…" : "Save the page"}'));
is("Save is never turned off under the focus", /\bdisabled=\{/.test(save), false);
is("it says it cannot save now, and stays focusable", /aria-disabled=\{busy \|\| !dirty \|\| undefined\}/.test(save), true);
is("a press while it cannot save does nothing", /function saveNow\(\) \{\s*if \(busy \|\| !dirty\) return;/.test(editor), true);
const swaps = editor.slice(editor.indexOf("onClick={() => swap(i, -1)}") - 40, editor.indexOf("aria-label={`Remove picture ${i + 1}`}"));
is("a picture's Earlier and Later are never turned off under the focus", /\bdisabled=\{/.test(swaps), false);

part("The wide layout is drawn from the first paint (no layout shift)");
const grid = editor.slice(editor.indexOf("on a narrow screen the gallery opens where a place is pressed."), editor.indexOf("{drafts.length === 0 ? ("));
is("the two columns come from the style sheet at 1280 pixels, not from the script", grid.includes('<div className="min-[1280px]:grid min-[1280px]:grid-cols-[minmax(0,1fr)_25.5rem] min-[1280px]:items-start min-[1280px]:gap-5">'), true);
is("saved sections under the blocks are hidden by the style sheet at 1280 pixels until the script moves them beside", editor.includes('{sideBySide ? null : <div className="min-[1280px]:hidden">{savedSections}</div>}'), true);

part("A move keeps the focus and says where the block went (WCAG 2.4.3, 4.1.3)");
const moveButtons = row.slice(0, row.indexOf("canDuplicate(block) ?"));
is("Move up and Move down are never turned off under the focus", /\bdisabled=\{/.test(moveButtons), false);
is("they say when they cannot move, and stay focusable", (moveButtons.match(/aria-disabled=\{/g) ?? []).length, 2);
is("what a move says", movedSaying("Text", 3, 9), "Moved Text to position 4 of 9.");
is("the editor says it after a move", /function move\(index: number, by: -1 \| 1\) \{[\s\S]*?setSaid\(movedSaying\(/.test(editor), true);

part("A removal moves the focus and says how to bring the block back (WCAG 2.4.3, 3.3.6, 4.1.3)");
is("what a removal says", removedSaying("Questions", 2), "Removed Questions from position 3. Undo, at the top of the editor, brings it back.");
is("after removing a middle block, the block now in its place", focusAfterRemoval(2, 5), 2);
is("after removing the last block, the one before it", focusAfterRemoval(4, 4), 3);
is("after removing the only block, the place to add one", focusAfterRemoval(0, 0), null);
const removeFn = editor.slice(editor.indexOf("function remove(index: number) {"), editor.indexOf("function duplicate(index: number) {"));
is("the editor says it after a removal", removeFn.includes("setSaid(removedSaying("), true);
is("and moves the focus where focusAfterRemoval says", removeFn.includes("focusAfterRemoval("), true);

part("The choice that is on is shown by more than color (WCAG 1.4.1, 1.4.11, forced colors)");
const buildPreview = editor.slice(editor.indexOf('aria-label="Build or preview"'), editor.indexOf('aria-label="Undo and redo"'));
is("Build or Preview: a check beside the one on", buildPreview.includes('<Icon name="check"'), true);
const shows = editor.slice(editor.indexOf("BLOCK_SHOWS.map((option) =>"), editor.indexOf("A shorter list for phones"));
is("Shows on: a check beside the one on", shows.includes('<Icon name="check"'), true);
is("Page style: a check beside the one on", picker.includes('<Icon name="check"'), true);

done();
