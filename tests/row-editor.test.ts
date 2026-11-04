/**
 * Changing a row of columns in the studio (lib/row-edit-rules.ts, used by
 * RowEditor in components/page-editor.tsx; queue item 375 [TB1], unit 2).
 *
 * What is checked, against the real rules:
 *
 *   - one, two or three columns: more are added empty; fewer move every
 *     element of the columns taken away, in order, to the end of the last
 *     column kept, and the change is refused when that column would be too
 *     full, so nothing is ever lost;
 *   - adding stops at a column's limit and at the row's, with the reason;
 *   - moving up, down and to another column, at every edge, and never past a
 *     full column; removing says where the keyboard goes next;
 *   - every change leaves the row it was given as it was (the editor's undo
 *     holds each step), and an element that does not change is the same one;
 *   - what an element still needs before saving is what the save route
 *     refuses, said in words, and a row the editor says is ready is kept
 *     whole by the page's own reading;
 *   - the editor is offered on a product's page, not on the store's own
 *     pages nor in a saved section, and moves and removes with buttons.
 *
 * Not checked here (needs a browser: tests/e2e): focus landing after each
 * action, the status line being read out, and a picture upload.
 */
import { readFileSync } from "node:fs";
import { BLOCK_GROUPS } from "@/components/block-picker";
import { NOT_IN_SECTIONS } from "@/lib/saved-blocks";
import { SITE_KINDS } from "@/lib/site-page-rules";
import {
  BLOCK_KINDS,
  MAX_COLUMN_ELEMENTS,
  MAX_ITEM,
  MAX_ROW_ELEMENTS,
  MAX_ROW_LIST_ITEMS,
  ROW_ELEMENT_KINDS,
  ROW_ICONS,
  type RowElement,
  pageProblem,
  parsePage,
} from "@/lib/sales-page";
import {
  ROW_EDIT_WHY,
  ROW_ELEMENT_NAMES,
  ROW_ICON_NAMES,
  type RowColumns,
  addElement,
  addRefusal,
  blankElement,
  moveElement,
  removeElement,
  replaceElement,
  rowElementCount,
  rowElementProblem,
  releaseHeld,
  rowProblem,
  setColumnCount,
} from "@/lib/row-edit-rules";
import { done, is, part } from "./check";

const h = (text: string): RowElement => ({ kind: "heading", text });
const words = (columns: RowColumns) => columns.map((column) => column.map((element) => (element.kind === "heading" ? element.text : element.kind)));
const full = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => h(`${prefix}${i + 1}`));
const frozen = (columns: RowElement[][]) => JSON.stringify(columns);
const picture = { path: `images/${"a".repeat(24)}/${"0".repeat(32)}.webp`, width: 1200, height: 800, alt: "", caption: "" };

part("How many columns");
{
  const two: RowElement[][] = [[h("A1"), h("A2")], [h("B1")]];
  const before = frozen(two);
  const three = setColumnCount(two, 3);
  is("more columns are added empty at the end", three.ok && words(three.columns), [["A1", "A2"], ["B1"], []]);
  const one = setColumnCount(two, 1);
  is("fewer columns move the others' parts to the end of the last kept, in order", one.ok && words(one.columns), [["A1", "A2", "B1"]]);
  is("nothing is lost: the row's count is the same", one.ok && rowElementCount(one.columns), 3);
  const fromThree = setColumnCount([[h("A1")], [h("B1")], [h("C1"), h("C2")]], 2);
  is("three to two: the third column's parts follow the second's", fromThree.ok && words(fromThree.columns), [["A1"], ["B1", "C1", "C2"]]);
  const threeToOne = setColumnCount([[h("A1")], [h("B1")], [h("C1")]], 1);
  is("three to one: second's then third's, after the first's", threeToOne.ok && words(threeToOne.columns), [["A1", "B1", "C1"]]);
  is("the same count changes nothing", setColumnCount(two, 2).ok && words((setColumnCount(two, 2) as { columns: RowElement[][] }).columns), [["A1", "A2"], ["B1"]]);
  is("the row given is left as it was", frozen(two), before);
  for (const count of [0, 4, 1.5, -1]) is(`${count} columns: refused`, setColumnCount(two, count), { ok: false, why: "columns" });
  const crowded: RowElement[][] = [full(5, "A"), full(4, "B")];
  is(`fewer columns that would put more than ${MAX_COLUMN_ELEMENTS} in one: refused, nothing changed`, setColumnCount(crowded, 1), { ok: false, why: "fewer_full" });
  const exactly: RowElement[][] = [full(4, "A"), full(4, "B")];
  is(`exactly ${MAX_COLUMN_ELEMENTS} in the last column: allowed`, setColumnCount(exactly, 1).ok, true);
  const kept = setColumnCount(two, 1);
  is("the parts moved are the same objects, not copies", kept.ok && kept.columns[0][2] === two[1][0], true);
}

part("Adding");
{
  const row: RowElement[][] = [[], [h("B1")]];
  const before = frozen(row);
  const added = addElement(row, 0, h("A1"));
  is("added at the end of its column, and says where", added.ok && [words(added.columns), added.at], [[["A1"], ["B1"]], { column: 0, index: 0 }]);
  is("the row given is left as it was", frozen(row), before);
  is("a column that is not there: refused", addElement(row, 2, h("X")), { ok: false, why: "missing" });
  const fullColumn: RowElement[][] = [full(MAX_COLUMN_ELEMENTS, "A"), []];
  is(`a column of ${MAX_COLUMN_ELEMENTS}: refused, with the reason`, [addRefusal(fullColumn, 0), addElement(fullColumn, 0, h("X")).ok], ["column_full", false]);
  is("the other column still takes one", addRefusal(fullColumn, 1), null);
  const fullRow: RowElement[][] = [full(4, "A"), full(4, "B"), full(4, "C")];
  is(`a row of ${MAX_ROW_ELEMENTS}: refused in every column, with the reason`, [0, 1, 2].map((c) => addRefusal(fullRow, c)), ["row_full", "row_full", "row_full"]);
  is(`one short of ${MAX_ROW_ELEMENTS}: allowed`, addRefusal([full(4, "A"), full(4, "B"), full(3, "C")], 2), null);
}

part("Moving");
{
  const row: RowElement[][] = [[h("A1"), h("A2"), h("A3")], [h("B1")]];
  const before = frozen(row);
  const up = moveElement(row, { column: 0, index: 1 }, "up");
  is("up: one place earlier, and says where", up.ok && [words(up.columns)[0], up.at], [["A2", "A1", "A3"], { column: 0, index: 0 }]);
  const down = moveElement(row, { column: 0, index: 1 }, "down");
  is("down: one place later, and says where", down.ok && [words(down.columns)[0], down.at], [["A1", "A3", "A2"], { column: 0, index: 2 }]);
  is("up from the top: refused", moveElement(row, { column: 0, index: 0 }, "up"), { ok: false, why: "edge" });
  is("down from the bottom: refused", moveElement(row, { column: 0, index: 2 }, "down"), { ok: false, why: "edge" });
  const across = moveElement(row, { column: 0, index: 0 }, { column: 1 });
  is("to another column: to its end, and says where", across.ok && [words(across.columns), across.at], [[["A2", "A3"], ["B1", "A1"]], { column: 1, index: 1 }]);
  is("the count never changes", across.ok && rowElementCount(across.columns), 4);
  is("to its own column: refused", moveElement(row, { column: 0, index: 0 }, { column: 0 }), { ok: false, why: "same_column" });
  is("to a column that is not there: refused", moveElement(row, { column: 0, index: 0 }, { column: 2 }), { ok: false, why: "missing" });
  is("a part that is not there: refused", moveElement(row, { column: 1, index: 3 }, "up"), { ok: false, why: "missing" });
  const fullTarget: RowElement[][] = [[h("A1")], full(MAX_COLUMN_ELEMENTS, "B")];
  is("to a full column: refused, nothing lost", [moveElement(fullTarget, { column: 0, index: 0 }, { column: 1 }), rowElementCount(fullTarget)], [{ ok: false, why: "column_full" }, MAX_COLUMN_ELEMENTS + 1]);
  is("the row given is left as it was", frozen(row), before);
  is("a part that moves is the same object", up.ok && up.columns[0][0] === row[0][1], true);
}

part("Removing");
{
  const row: RowElement[][] = [[h("A1"), h("A2"), h("A3")], [h("B1")]];
  const before = frozen(row);
  const middle = removeElement(row, { column: 0, index: 1 });
  is("the part is gone, and the one that took its place is next", middle.ok && [words(middle.columns)[0], middle.at, middle.removed], [["A1", "A3"], { column: 0, index: 1 }, h("A2")]);
  const last = removeElement(row, { column: 0, index: 2 });
  is("the last one: the one before it is next", last.ok && last.at, { column: 0, index: 1 });
  const only = removeElement(row, { column: 1, index: 0 });
  is("the only one: nothing next (the column's Add control)", only.ok && [words(only.columns)[1], only.at], [[], null]);
  is("a part that is not there: refused", removeElement(row, { column: 2, index: 0 }), { ok: false, why: "missing" });
  is("the row given is left as it was, so undo has it whole", frozen(row), before);
}

part("Replacing what was typed");
{
  const row: RowElement[][] = [[h("A1"), h("A2")]];
  const changed = replaceElement(row, { column: 0, index: 1 }, h("Typed"));
  is("only that part changes", changed.ok && words(changed.columns), [["A1", "Typed"]]);
  is("the other part is the same object", changed.ok && changed.columns[0][0] === row[0][0], true);
  is("a place that is not there: refused", replaceElement(row, { column: 0, index: 5 }, h("X")), { ok: false, why: "missing" });
}

part("New parts");
is("every kind has a name", ROW_ELEMENT_KINDS.every((kind) => Boolean(ROW_ELEMENT_NAMES[kind])), true);
is("every icon has a name a person reads, each different", [ROW_ICONS.every((icon) => Boolean(ROW_ICON_NAMES[icon])), new Set(Object.values(ROW_ICON_NAMES)).size], [true, ROW_ICONS.length]);
is(
  "words start empty; a picture and a video start from what is chosen",
  ROW_ELEMENT_KINDS.map((kind) => blankElement(kind)),
  [{ kind: "heading", text: "" }, { kind: "subheading", text: "" }, { kind: "paragraph", text: "" }, { kind: "list", items: [] }, { kind: "icon", name: "check", label: "" }, { kind: "button", label: "", url: "" }, null, null, null],
);
is("every refusal is said in words", Object.values(ROW_EDIT_WHY).every((text) => text.length > 10 && !/undefined/.test(text)), true);

part("What a part still needs before saving");
{
  const cases: [string, RowElement, boolean][] = [
    ["a heading with words", h("Plan a week"), true],
    ["an empty heading", h("  "), false],
    ["an empty smaller heading", { kind: "subheading", text: "" }, false],
    ["words", { kind: "paragraph", text: "One.\n\nTwo." }, true],
    ["empty words", { kind: "paragraph", text: "\n \n" }, false],
    ["a list with a point and empty lines", { kind: "list", items: ["", "Seven dinners", ""] }, true],
    ["a list of empty lines", { kind: "list", items: ["", " "] }, false],
    [`a list of ${MAX_ROW_LIST_ITEMS + 1} points`, { kind: "list", items: Array.from({ length: MAX_ROW_LIST_ITEMS + 1 }, (_, i) => `P${i}`) }, false],
    [`${MAX_ROW_LIST_ITEMS} points and empty lines (left out)`, { kind: "list", items: ["", ...Array.from({ length: MAX_ROW_LIST_ITEMS }, (_, i) => `P${i}`), " ", ""] }, true],
    [`a point longer than ${MAX_ITEM}`, { kind: "list", items: ["x".repeat(MAX_ITEM + 1)] }, false],
    [`a point of ${MAX_ITEM} letters once runs of space are made one`, { kind: "list", items: [`${"x".repeat(MAX_ITEM - 2)}      xx`.replace(/x{2}$/, "x")] }, true],
    ["an icon without words", { kind: "icon", name: "clock", label: "" }, true],
    ["the page's own button, no words", { kind: "button", label: "", url: "" }, true],
    ["a button elsewhere with words", { kind: "button", label: "See the recipes", url: "https://example.com/recipes" }, true],
    ["a button elsewhere without words", { kind: "button", label: "", url: "https://example.com/recipes" }, false],
    ["a button to plain http", { kind: "button", label: "Go", url: "http://example.com" }, false],
    ["a button to javascript:", { kind: "button", label: "Go", url: "javascript:alert(1)" }, false],
    ["a picture described", { kind: "image", picture: { ...picture, alt: "A page of the planner" }, decorative: false }, true],
    ["a picture not described", { kind: "image", picture, decorative: false }, false],
    ["a picture marked as decoration", { kind: "image", picture, decorative: true }, true],
    ["a video in a window with button words", { kind: "video-window", video: { provider: "youtube", id: "dQw4w9WgXcQ", hash: "" }, title: "", label: "Watch the walkthrough" }, true],
    ["a video in a window without button words", { kind: "video-window", video: { provider: "youtube", id: "dQw4w9WgXcQ", hash: "" }, title: "Tour", label: "  " }, false],
  ];
  for (const [what, element, ready] of cases) {
    const problem = rowElementProblem(element);
    is(`${what}: ${ready ? "ready" : "says what it needs"}`, ready ? problem : typeof problem === "string" && problem.length > 20, ready ? null : true);
    // The editor and the save route agree: what is ready is kept whole, what is not is refused.
    const raw = { blocks: [{ id: "row00001", kind: "row", columns: [[element]] }] };
    is(`${what}: the save route ${ready ? "keeps it" : "refuses it"}`, pageProblem(raw, parsePage(raw)) === null, ready);
  }
  const row: RowElement[][] = [[h("Fine")], [{ kind: "button", label: "", url: "https://example.com" }, h("")]];
  is("a row's first part that needs something, with where it is", rowProblem(row), { column: 1, index: 0, problem: rowElementProblem(row[1][0]) });
  is("a ready row: nothing", rowProblem([[h("Fine")], []]), null);
}

part("A slot held while a picture is being sent");
{
  // A picture being sent to a column holds its place there until it arrives, so nothing can take that place
  // meanwhile and the file sent is never left over with no part to show it.
  const seven: RowElement[][] = [full(MAX_COLUMN_ELEMENTS - 1, "A"), [h("B1")]];
  const held = [1, 0];
  is("a column with a held slot that makes it full takes nothing more", [addRefusal(seven, 0, held), addElement(seven, 0, h("X"), held).ok], ["column_full", false]);
  is("nor a part moved into it", moveElement(seven, { column: 1, index: 0 }, { column: 0 }, held), { ok: false, why: "column_full" });
  const eleven: RowElement[][] = [full(4, "A"), full(4, "B"), full(3, "C")];
  is("a held slot counts toward the whole row", addRefusal(eleven, 2, [0, 1, 0]), "row_full");
  is("fewer columns while a picture is on its way to one taken away: refused", setColumnCount([[h("A1")], []], 1, [0, 1]), { ok: false, why: "sending" });
  is("fewer columns that would overfill the last one with its held slot: refused", setColumnCount([full(4, "A"), full(4, "B")], 1, [1, 0]), { ok: false, why: "fewer_full" });
  is("fewer columns that fit with the held slot: allowed", setColumnCount([full(3, "A"), full(3, "B")], 1, [1, 0]).ok, true);
  is("the picture that arrives takes its own held slot", addElement(seven, 0, h("Picture"), releaseHeld(held, 0)).ok, true);
  is("releasing a slot leaves the others", [releaseHeld([1, 2, 0], 1), releaseHeld([0, 0], 0), held], [[1, 1, 0], [0, 0], [1, 0]]);
  is("with nothing held, every rule is as before", [addRefusal(seven, 0), addRefusal(seven, 0, [])], [null, null]);
  const editor = readFileSync("components/page-editor.tsx", "utf8");
  is("the editor holds the slot while sending and says a refusal beside the Add control", [editor.includes("onSending="), editor.includes("releaseHeld(held.current"), /uploadNote\[column\]/.test(editor)], [true, true, true]);
}

part("Offered on a product's page only");
is("in the block list as Columns", BLOCK_KINDS.find((k) => k.kind === "row")?.label, "Columns");
is("in the gallery, with what shows", BLOCK_GROUPS.find((g) => g.kinds.includes("row"))?.title, "Show it");
is("not on the store's own pages", SITE_KINDS.includes("row"), false);
is("never in a saved section: its pictures belong to its page", NOT_IN_SECTIONS.includes("row"), true);

part("The editor uses the rules, with buttons");
{
  const editor = readFileSync("components/page-editor.tsx", "utf8");
  const rowEditor = editor.slice(editor.indexOf("function RowEditor("), editor.indexOf("/** A list of one-line points. */"));
  is("the row is edited, not only shown", [editor.includes("<RowEditor"), editor.includes("its columns cannot be changed in this editor")], [true, false]);
  is("no name given by hand: the block list has it", editor.includes('kind === "row" ? "Columns"'), false);
  is("moves and removals by button, no dragging in the row", [/Move up/.test(rowEditor), /Move down/.test(rowEditor), /Move to column/.test(rowEditor), /Remove/.test(rowEditor), /draggable|onDrag/.test(rowEditor)], [true, true, true, true, false]);
  is("each change goes through the rules", ["setColumnCount(", "addElement(", "moveElement(", "removeElement(", "replaceElement("].every((call) => rowEditor.includes(call)), true);
  is("a full column says why, and is not silently disabled", rowEditor.includes("aria-disabled") && rowEditor.includes("aria-describedby={reasonId}") && !/[^-]disabled=\{/.test(rowEditor), true);
  is("what happened is said in a status line", rowEditor.includes('role="status"'), true);
  is("a part is checked before the page is sent", editor.includes("rowProblem(b.columns)"), true);
  // Seen in a browser at 1280 pixels: in the narrow block list beside the side menu and the page, the choice shrank to 64 pixels and showed "H".
  is("the Add to column choice is never narrower than its longest name; the Add button goes below it instead", rowEditor.includes('<div className="flex flex-wrap items-end gap-2">') && rowEditor.includes('<div className="min-w-[min(14rem,100%)] flex-1">\n            <label htmlFor={id} className="field-label">{`Add to column ${column + 1}`}</label>'), true);
  {
    // 14rem against the longest name at a generous 0.6em a letter, the field's padding (2 × 0.9rem), the arrow (1.5rem) and the border.
    const longest = Math.max(...Object.values(ROW_ELEMENT_NAMES).map((n) => n.length));
    is("14rem holds the longest name, \"Video in a window\"", [longest, longest * 0.6 + 1.8 + 1.5 + 0.125 <= 14], [17, true]);
  }
  is(
    "a video in a window is offered by its name, made from the address typed, and asks for its button words first",
    [
      ROW_ELEMENT_NAMES["video-window"],
      rowEditor.includes('kind === "video-window" ? { kind: "video-window", video, title: "", label: "" }'),
      /\{inWindow \? \(\s*<div>\s*\{label\(`\$\{id\}-a`, "Button words"/.test(rowEditor),
    ],
    ["Video in a window", true, true],
  );
  is("the Add button stays a 44 pixel target", rowEditor.includes('"inline-flex min-h-11 items-center gap-1.5 rounded-full'), true);
  is("after a change the keyboard goes to the new field once it is drawn, at a later frame if need be, never left on Add", rowEditor.includes("stopFocus.current = focusWhenDrawn(() => document.getElementById(id), browserFrames());") && !rowEditor.includes("document.getElementById(focusTo.current)?.focus();"), true);
  is("a copied row leaves its pictures out", editor.includes('if (block.kind === "row") block.columns = block.columns.map((column) => column.filter((element) => element.kind !== "image"));'), true);
}

done();
