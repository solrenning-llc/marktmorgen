/**
 * The page editor's right-hand column on a wide screen: the side menu of
 * blocks to add and the page as visitors see it share it, switched at its top
 * (lib/side-panel.ts, components/side-panel-switch.tsx,
 * components/page-editor.tsx; queue item 375 [TB1]).
 *
 * Seen in a browser at 1280 pixels: with the menu (15rem) and the page
 * (24.5rem) as two columns of their own, the blocks were edited in 182
 * pixels; "Add to column 1" cut "Smaller heading", a row's first field was
 * 31 pixels and the button opening a row had no width.
 *
 * What is checked, against the real code: one column beside the blocks,
 * the arithmetic that leaves the blocks at least 420 pixels at 1280, the
 * switch (two buttons saying which is on, as the editor's other switches),
 * the choice remembered in this browser only with the page as default, and
 * an "Add here" that shows the menu. Not checked here (needs a browser):
 * the widths drawn, and the focus landing in the search.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import {
  EDITOR_WIDTH_AT_1280,
  EDIT_COLUMN_MIN_PX,
  SIDE_COLUMN_PX,
  SIDE_GAP_PX,
  SIDE_PANELS,
  SIDE_PANEL_DEFAULT,
  SIDE_PANEL_KEY,
  SIDE_PANEL_LABEL,
  editColumnWidth,
  readSidePanel,
} from "@/lib/side-panel";

part("The choice");
is("two panels, in the switch's order", SIDE_PANELS, ["add", "preview"]);
is("their names", SIDE_PANELS.map((p) => SIDE_PANEL_LABEL[p]), ["Add blocks", "Preview"]);
is("until a choice is made, the page", SIDE_PANEL_DEFAULT, "preview");
is("a remembered choice is read back", [readSidePanel("add"), readSidePanel("preview")], ["add", "preview"]);
is("nothing, or anything else, is the default", [readSidePanel(null), readSidePanel(undefined), readSidePanel(""), readSidePanel("menu")], ["preview", "preview", "preview", "preview"]);
is("remembered under a key of its own", SIDE_PANEL_KEY, "mm:page-side-panel");

part("The room left to the blocks");
is("the shared column is a phone's width (24.5rem)", SIDE_COLUMN_PX, 392);
is("the gap between the two columns (gap-5)", SIDE_GAP_PX, 20);
is("at 1280 pixels the blocks have 442 pixels, at least 420", [editColumnWidth(EDITOR_WIDTH_AT_1280), editColumnWidth(EDITOR_WIDTH_AT_1280) >= EDIT_COLUMN_MIN_PX], [442, true]);
is("where the three columns left them 182", EDITOR_WIDTH_AT_1280 - 240 - 392 - 2 * 20, 182);
is("never below nothing", editColumnWidth(100), 0);

const editor = readFileSync("components/page-editor.tsx", "utf8");
part("The editor: one column beside the blocks");
is("two columns on a wide screen, the blocks and the shared one", editor.includes('<div className={sideBySide ? "grid grid-cols-[minmax(0,1fr)_24.5rem] items-start gap-5" : ""}>'), true);
is("no third column of its own for the menu", !editor.includes("_15rem_24.5rem"), true);
is("the shared column's width is the one counted here", `${SIDE_COLUMN_PX / 16}rem`, "24.5rem");
is(
  "the switch at its top, then the menu or the page, never both",
  editor.includes('<SidePanelSwitch value={sidePanel} onChange={chooseSidePanel} controls="side-panel" />\n        {sidePanel === "add" ? (\n        <aside id="side-panel" aria-label="Blocks to add"') &&
    editor.includes('        ) : (\n        <aside\n          id="side-panel"\n          ref={beside}\n          aria-label="The page as visitors see it"'),
  true,
);
is("the column stays in view as the blocks scroll, its switch always there and its panel scrolling under it", editor.includes('<div className="sticky top-24 mt-6 flex max-h-[calc(100vh-7rem)] flex-col gap-3">') && editor.includes('aria-label="Blocks to add" className="min-h-0 overflow-y-auto rounded-2xl"'), true);
is("the choice is remembered; the switch made by Add here is not", editor.includes("const [sidePanel, chooseSidePanel, showSidePanel] = useSidePanel();") && editor.includes('showSidePanel("add");'), true);
is("a card chosen in the menu still waits for its place while the page is shown", editor.includes("const armed = sideBySide ? chosenKind : null;"), true);

const panelSwitch = readFileSync("components/side-panel-switch.tsx", "utf8");
part("The switch");
is("two buttons in a named group, each saying whether it is on", panelSwitch.includes('role="group" aria-label="Beside the blocks"') && panelSwitch.includes("aria-pressed={on}") && panelSwitch.includes("aria-controls={controls}"), true);
is("on says so in words and with a check, not by color alone", panelSwitch.includes('{on ? <Icon name="check" size={16} /> : null}'), true);
is("each a 44 pixel target", panelSwitch.includes("min-h-11 min-w-11"), true);
is("remembered in this browser only, never failing when storage is blocked", (panelSwitch.match(/try \{/g) ?? []).length, 2);
is("read after the first drawing, so the server and the browser draw the same", panelSwitch.includes("useState<SidePanel>(SIDE_PANEL_DEFAULT)") && panelSwitch.includes("window.setTimeout(() => {"), true);
is("no animation", !/transition|animate/.test(panelSwitch), true);

done();
