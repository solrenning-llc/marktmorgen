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
 *   switches already show a check beside the one that is on;
 * - a save refused because the session ended said only "Log in again.":
 *   signing in in the same tab loses the page being edited, which this tab
 *   still holds (WCAG 2.2.5).
 *
 * What is checked here, against the real code: the sizes in the classes,
 * the buttons kept focusable at an edge, the words said after a move and a
 * removal, where the focus goes after a removal, and the check beside a
 * choice that is on, and the wide layout drawn by the style sheet from the
 * first paint: at 1280 pixels the editor was drawn in one column and then,
 * once its script ran, in two, so the column of blocks went from 856 to 426
 * pixels and what was under it moved down (a layout shift of 0.0895 on a
 * slow network). Where the focus lands, what the live region says and how
 * the icon buttons are drawn in forced colors are checked in a real browser
 * by tests/e2e/page-editor-actions.mjs, on the real component.
 *
 * Found in review (6 November 2026): an arrow that cannot move looked like
 * one that works (--ink-mute beside --ink-soft, 1.07:1, and ButtonText in
 * forced colors); the same words said twice were not said again; the
 * refusal said "sign in" where the site says "Log in"; and a Clear refused
 * because the session ended said to press Save the page, which is off then.
 * The refusal is drawn here from the real component, by react-dom/server.
 */
import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { done, is, part } from "./check";
import * as insert from "@/lib/block-insert";
import * as pageEditor from "@/components/page-editor";

const { MESSAGES } = pageEditor;

// Read by name, so a helper still missing fails its own lines rather than the whole file.
const helper = (name: string) => (insert as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>)[name] ?? (() => undefined);
const movedSaying = helper("movedSaying");
const removedSaying = helper("removedSaying");
const focusAfterRemoval = helper("focusAfterRemoval");

const editor = readFileSync("components/page-editor.tsx", "utf8");
const styles = readFileSync("app/globals.css", "utf8");
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
const saveLabel = editor.indexOf('{busy ? "Saving…" : "Save the page"}');
const save = editor.slice(editor.lastIndexOf("<button", saveLabel), saveLabel);
is("Save is never turned off under the focus", /(?<![-\w])disabled=\{/.test(save), false);
is("it says it cannot save now, and stays focusable", /aria-disabled=\{busy \|\| !dirty \|\| undefined\}/.test(save), true);
is("a press while it cannot save does nothing", /function saveNow\(\) \{\s*if \(busy \|\| !dirty\) return;/.test(editor), true);
const swaps = editor.slice(editor.indexOf("onClick={() => swap(i, -1)}") - 40, editor.indexOf("aria-label={`Remove picture ${i + 1}`}"));
is("a picture's Earlier and Later are never turned off under the focus", /(?<![-\w])disabled=\{/.test(swaps), false);

part("The wide layout is drawn from the first paint (no layout shift)");
const gridAt = editor.indexOf("on a narrow screen the gallery opens where a place is pressed.");
const grid = editor.slice(gridAt, editor.indexOf("{drafts.length === 0 ? (", gridAt));
is("the two columns come from the style sheet at 1280 pixels, not from the script", grid.includes('<div className="min-[1280px]:grid min-[1280px]:grid-cols-[minmax(0,1fr)_25.5rem] min-[1280px]:items-start min-[1280px]:gap-5">'), true);
is("saved sections under the blocks are hidden by the style sheet at 1280 pixels until the script moves them beside", editor.includes('{sideBySide ? null : <div className="min-[1280px]:hidden">{savedSections}</div>}'), true);

part("A move keeps the focus and says where the block went (WCAG 2.4.3, 4.1.3)");
const moveButtons = row.slice(0, row.indexOf("canDuplicate(block) ?"));
is("Move up and Move down are never turned off under the focus", /(?<![-\w])disabled=\{/.test(moveButtons), false);
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

part("An arrow that cannot move looks off, as an off button does (WCAG 1.4.1, 1.4.11, forced colors)");
// Words in --ink-mute beside --ink-soft are 1.07:1 apart, so an off arrow looked like one that works, and forced
// colors drew both in ButtonText. The arrows take the signs of .btn[aria-disabled]: the sand surface and the
// dashed --line-off edge, and GrayText in forced colors.
const offArrows = [...moveButtons.matchAll(/aria-disabled=\{[^}]*\}\s*className="([^"]*)"/g), ...row.matchAll(/onClick=\{\(\) => duplicate\(index\)\}\s*aria-disabled=\{[^}]*\}\s*className="([^"]*)"/g), ...swaps.matchAll(/aria-disabled=\{[^}]*\}\s*className="([^"]*)"/g)].map((m) => m[1]);
is("Move up, Move down, Duplicate, and a picture's Earlier and Later, found", offArrows.length, 5);
is("each carries the off signs of an off button (icon-btn)", offArrows.every((c) => /(^| )icon-btn( |$)/.test(c)), true);
is("none is told off by a near-identical gray alone", editor.includes("aria-disabled:text-ink-mute"), false);
/** The declarations of the first rule whose selector list names `selector`, after `from`. */
const ruleFor = (selector: string, from = 0) => {
  const at = styles.indexOf(selector, from);
  if (at < 0) return { list: "", body: "" };
  const open = styles.indexOf("{", at);
  const start = styles.lastIndexOf("}", at) + 1;
  return { list: styles.slice(start, open), body: styles.slice(open + 1, styles.indexOf("}", open)) };
};
const light = ruleFor('.btn[aria-disabled="true"],');
is("the off button's rule names the round buttons too", light.list.includes('.icon-btn[aria-disabled="true"]') && light.list.includes('.icon-btn[aria-disabled="true"]:hover'), true);
is("which draw the sand surface and the dashed edge", /background-color: var\(--sand\)/.test(light.body) && /border: 1px dashed var\(--line-off\)/.test(light.body), true);
const forced = ruleFor('.btn[aria-disabled="true"],', styles.indexOf("@media (forced-colors: active)", styles.indexOf('.btn[aria-disabled="true"],')));
is("in forced colors, the round buttons are GrayText with a dashed edge", forced.list.includes('.icon-btn[aria-disabled="true"]') && /color: GrayText/.test(forced.body) && /border-style: dashed/.test(forced.body), true);

part("The same words said twice are said again (WCAG 4.1.3)");
const editorBody = editor.slice(editor.indexOf("export function PageEditor("), editor.indexOf("function RowEditor("));
is("the editor's status words alternate a no-break space, as RowEditor's do", /const \[said, setSaidNow\] = useState\(""\);\s*const again = useRef\(false\);\s*const setSaid = \(text: string\) => \{\s*again\.current = !again\.current;\s*setSaidNow\(text \? `\$\{text\}\$\{again\.current \? "\\u00a0" : ""\}` : ""\);/.test(editorBody), true);

part("A session that ended: log in again without losing the page (WCAG 2.2.5, 3.3.1)");
is("the refusal of a save says the changes are still here and how to keep them, in the site's words (Log in)", MESSAGES.signed_out, "Your session ended. Your changes are still here, not saved yet: log in again in a new tab, then come back to this tab and press Save the page.");
// Read by name, so what is still missing fails its own lines rather than the whole file.
const named = pageEditor as unknown as Record<string, unknown>;
const refusalWords = (typeof named.refusalWords === "function" ? named.refusalWords : () => undefined) as (error: string | undefined, clearing: boolean) => string | undefined;
const ErrorNotice = (typeof named.ErrorNotice === "function" ? named.ErrorNotice : () => null) as FunctionComponent<{ error: string }>;
is("a refused save says to press Save the page", refusalWords("signed_out", false), MESSAGES.signed_out);
const clearing = refusalWords("signed_out", true) ?? "";
// Clear is offered only with nothing unsaved, and "Save the page" is off then: the refusal says to press its own Yes again.
is("a refused Clear says the page was not cleared and to press Yes, clear it again", clearing, "Your session ended, so the page was not cleared. Log in again in a new tab, then come back to this tab and press Yes, clear it again.");
is("other refusals keep their own words", [refusalWords("store_full", true), refusalWords("no such error", false)], [MESSAGES.store_full, MESSAGES.server_error]);
const notice = (error: string) => renderToStaticMarkup(createElement(ErrorNotice, { error }));
for (const [what, error] of [["a save", MESSAGES.signed_out], ["a Clear", clearing]] as const) {
  const html = notice(error);
  is(`after ${what}, the alert says it`, html.startsWith('<p class="notice notice-error mt-4" role="alert">') && html.includes(error), true);
  is(`after ${what}, a link opens the log-in page in a new tab, so this tab keeps the page`, /<a href="\/signin" target="_blank" rel="noopener noreferrer"[^>]*>/.test(html), true);
  // Its name as a screen reader reads it: its words, and an empty new-tab note's words written by app/globals.css.
  const link = /<a href="\/signin"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? "";
  // Markup dropped one character at a time (no single-pass regex), as tests/orders-accessibility.test.ts does.
  let words = "";
  let inTag = false;
  for (const ch of link.replaceAll('<span class="new-tab-note sr-only"></span>', " (opens in a new tab)")) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) words += ch;
  }
  const name = words.replace(/\s+/g, " ").trim();
  is(`after ${what}, the link says once, in words everyone sees, that it opens a new tab (WCAG 2.4.4, 2.5.3)`, name, "Log in again in a new tab");
}
is("another refusal has no log-in link", notice(MESSAGES.store_full).includes("/signin"), false);
is("the editor draws its refusals with ErrorNotice", /\{error \? <ErrorNotice error=\{error\} \/> : null\}/.test(editor), true);
is("and words them with refusalWords", editor.includes("refusalWords(data.error, page === null)"), true);

done();
