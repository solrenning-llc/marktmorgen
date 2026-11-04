/**
 * The page editor's preview as on a computer or as on a phone, one press apart
 * (lib/preview-screen.ts, components/preview-frame.tsx, components/page-editor.tsx;
 * queue item 375 [TB1], unit 3).
 *
 * What is checked, against the real code:
 *
 *   - each preview is laid out at its screen's real width, and the width the
 *     page's container queries see there is on the right side of every line
 *     app/globals.css draws: on a phone a row of two or three columns is one
 *     column and a "Computers and tablets only" block is hidden; on a computer
 *     the columns stand side by side and a "Phones only" block is hidden;
 *   - the computer preview's text column is the live product page's own;
 *   - the shrinking to fit never widens, never leaves the shrunk page wider
 *     than its room, and the height follows it;
 *   - a tiny room never shrinks the page to nothing (review finding 3);
 *   - a room that grows by a scrollbar's width or less is not taken back, so
 *     a scrollbar that comes and goes as the page shrinks cannot loop, and the
 *     page beside the blocks keeps its scrollbar's room (finding 2);
 *   - until a choice is remembered, the page beside the blocks (a narrow
 *     column) shows Phone and the full preview Computer; once one is chosen,
 *     both show it (finding 5);
 *   - what is drawn later, or changed later, is taken out of the Tab order
 *     too, without looping on its own change (finding 4);
 *   - the switch is two buttons with aria-pressed, 44-pixel targets, the one
 *     on said with a check as well as its look, and does not move focus;
 *   - the preview region is named, takes nothing into the Tab order, and both
 *     the preview view and the page beside the blocks use the one switch.
 *
 * Not checked here (needs a browser: tests/e2e): the drawing itself at each
 * width, the ResizeObserver measuring, and a screen reader reading the region.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import {
  COMPUTER_BODY_MAX,
  PREVIEW_FRAME_WIDTH,
  PREVIEW_SCREENS,
  PREVIEW_SCREEN_LABEL,
  MIN_PREVIEW_SCALE,
  PREVIEW_DEFAULT,
  ROOM_TOLERANCE,
  fitScale,
  nextRoom,
  previewContainerWidth,
  screenFor,
  readPreviewScreen,
  shrunkHeight,
  shrunkNote,
} from "@/lib/preview-screen";

const css = readFileSync("app/globals.css", "utf8");

/** The pixel line of the @container rule holding `selector`, and whether it is a min- or max-width. */
function lineOf(selector: string): { kind: string; px: number } | null {
  const rules = [...css.matchAll(/@container \((min|max)-width: ([\d.]+)px\) \{([\s\S]*?)\n\}/g)];
  for (const [, kind, px, body] of rules) {
    if (body.includes(selector)) return { kind, px: Number(px) };
  }
  return null;
}

part("Each preview lays the page out as that screen does");
const phone = previewContainerWidth("phone");
const computer = previewContainerWidth("computer");
is("the phone preview is a common phone's width", PREVIEW_FRAME_WIDTH.phone, 390);
is("the page's container is .sp-body, so its width, not the window's, decides", /\.sp-body \{\s*container-type: inline-size;/.test(css), true);
const two = lineOf(".sp-row-2 {");
const three = lineOf(".sp-row-3 {");
const onlyComputer = lineOf(".sp-only-computer {");
const onlyPhone = lineOf(".sp-only-phone {");
is("the lines read from app/globals.css", [two, three, onlyComputer, onlyPhone], [
  { kind: "min", px: 560 },
  { kind: "min", px: 700 },
  { kind: "max", px: 699.98 },
  { kind: "min", px: 700 },
]);
is("on a phone a row of two columns is one column", two !== null && phone < two.px, true);
is("on a phone a row of three columns is one column", three !== null && phone < three.px, true);
is("on a phone a block for computers and tablets only is hidden", onlyComputer !== null && phone <= onlyComputer.px, true);
is("on a phone a block for phones only shows", onlyPhone !== null && phone < onlyPhone.px, true);
is("on a computer two columns stand side by side", two !== null && computer >= two.px, true);
is("on a computer three columns stand side by side", three !== null && computer >= three.px, true);
is("on a computer a block for phones only is hidden", onlyPhone !== null && computer >= onlyPhone.px, true);
is("on a computer a block for computers and tablets only shows", onlyComputer !== null && computer > onlyComputer.px, true);
const productPage = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
is("the computer's text column is the live product page's (max-w-3xl, 48rem, padded px-4)", COMPUTER_BODY_MAX === 48 * 16 && productPage.includes('${wide ? "max-w-3xl" : "max-w-2xl"} px-4'), true);
is("so the computer preview's page is as wide as the live page's", computer, 768 - 32);

part("Shrunk to fit, never cut and never wider than its room");
is("it fits: shown at its real size", fitScale(1200, 1024), 1);
is("exactly as wide: real size", fitScale(1024, 1024), 1);
is("not measured yet: real size, never zero", [fitScale(0, 1024), fitScale(Number.NaN, 1024), fitScale(-5, 390)], [1, 1, 1]);
is("a narrow room shrinks it", fitScale(392, 1024), 0.382);
is("the shrunk page is never wider than its room", [392, 360, 701, 1023, 333].every((room) => 1024 * fitScale(room, 1024) <= room && 390 * fitScale(room, 390) <= room), true);
is("a tiny room never shrinks it to nothing", [fitScale(1, 1024), fitScale(1, 390), fitScale(0.5, 1024)].every((scale) => scale >= MIN_PREVIEW_SCALE && scale > 0), true);
is("the smallest it is shown at is a tenth", MIN_PREVIEW_SCALE, 0.1);
is("the shrunk page is never wider than its room, for every room of a tenth of the frame or more", [103, 150, 200].every((room) => 1024 * fitScale(room, 1024) <= room) && [39, 40, 100].every((room) => 390 * fitScale(room, 390) <= room), true);
is("never enlarged", [500, 2000, 4000].every((room) => fitScale(room, 390) <= 1), true);
is("a phone fits the page drawn beside the blocks (24.5rem)", fitScale(24.5 * 16, PREVIEW_FRAME_WIDTH.phone), 1);
is("the height follows the shrinking, rounded up so nothing is cut", [shrunkHeight(1000, 0.382), shrunkHeight(1001, 0.5), shrunkHeight(-3, 0.5)], [382, 501, 0]);
is("a shrunk preview says so; one at its size says nothing", [shrunkNote(0.382), shrunkNote(1)], ["Shown at 38% of its size, to fit here.", null]);

part("The room it is measured in: no loop with a scrollbar that comes and goes");
is("the first measure is taken", nextRoom(0, 392), 392);
is("a measure of nothing keeps what was measured", [nextRoom(392, 0), nextRoom(392, Number.NaN), nextRoom(392, -1)], [392, 392, 392]);
is("a narrower room is always taken, so the page is never wider than it", [nextRoom(392, 377), nextRoom(392, 391)], [377, 391]);
is("a room wider by a scrollbar's width or less is not taken back", [nextRoom(377, 392), nextRoom(377, 377 + ROOM_TOLERANCE)], [377, 377]);
is("a room wider by more is taken", nextRoom(377, 377 + ROOM_TOLERANCE + 1), 377 + ROOM_TOLERANCE + 1);
is("the tolerance is a scrollbar's width, at most 20 pixels", ROOM_TOLERANCE > 0 && ROOM_TOLERANCE <= 20, true);
{
  // A scrollbar of 15 pixels appears when the page fits and goes when it shrinks: the room settles at once.
  let room = 0;
  const seen: number[] = [];
  for (const measured of [392, 377, 392, 377, 392]) {
    room = nextRoom(room, measured);
    seen.push(room);
  }
  is("a scrollbar coming and going settles after its first appearance", seen, [392, 377, 377, 377, 377]);
}

part("The choice: Phone beside the blocks and Computer in the full preview until one is chosen, then that one, remembered in this browser only");
is("Computer, then Phone", PREVIEW_SCREENS.map((s) => PREVIEW_SCREEN_LABEL[s]), ["Computer", "Phone"]);
is("a remembered choice is read back", [readPreviewScreen("phone"), readPreviewScreen("computer")], ["phone", "computer"]);
is("anything else, or nothing, is no choice yet", [readPreviewScreen(null), readPreviewScreen(undefined), readPreviewScreen("wide"), readPreviewScreen("")], [null, null, null, null]);
is("with no choice: Phone in the narrow column beside the blocks, Computer in the full preview", [screenFor("beside", null), screenFor("full", null)], ["phone", "computer"]);
is("the defaults", PREVIEW_DEFAULT, { beside: "phone", full: "computer" });
is("a choice holds in both places", [screenFor("beside", "computer"), screenFor("full", "phone"), screenFor("beside", "phone"), screenFor("full", "computer")], ["computer", "phone", "phone", "computer"]);
is("a phone shown beside the blocks is at its real size there (24.5rem column)", fitScale(24.5 * 16, PREVIEW_FRAME_WIDTH[screenFor("beside", null)]), 1);

part("The switch and the preview region");
const frame = readFileSync("components/preview-frame.tsx", "utf8");
is("two buttons that say which is on with aria-pressed, in a named group", frame.includes("aria-pressed={on}") && frame.includes('role="group" aria-labelledby={label}') && frame.includes("Preview on"), true);
is("each a 44-pixel target", frame.includes("min-h-11 min-w-11"), true);
is("the one on is marked with a check, not by its look alone", frame.includes('{on ? <Icon name="check" size={16} /> : null}'), true);
is("switching does not move focus", !/\.focus\(/.test(frame), true);
is("the storage is wrapped, read and written, so a blocked one keeps the default", (frame.match(/try \{/g) ?? []).length, 2);
is("the region is named by its screen", frame.includes('role="region"') && frame.includes("aria-label={`Preview: ${screen}`}"), true);
is("nothing in it is in the Tab order, including what is drawn later", frame.includes('setAttribute("tabindex", "-1")') && frame.includes("new MutationObserver(still)") && /FOCUSABLE = '[^']*summary[^']*'/.test(frame), true);
is("nor what is changed later: a tabindex, a link, a button enabled, an editable part, controls", /attributes: true,\s*attributeFilter: \["tabindex", "href", "disabled", "contenteditable", "controls"\]/.test(frame), true);
is("an element already out of the Tab order is not written again, so its own change ends the watching", frame.includes('if (el.getAttribute("tabindex") !== "-1") el.setAttribute("tabindex", "-1");'), true);
is("the room is measured with its tolerance", frame.includes("setRoom((was) => nextRoom(was, outer.clientWidth))"), true);
is("the hook keeps no choice until one is read or made", frame.includes("useState<PreviewScreen | null>(null)"), true);
is("laid out at the frame's width and shrunk from its top left corner", frame.includes("style={{ width: frame,") && frame.includes('transformOrigin: "top left"'), true);
is("no animation", !/transition|animate/.test(frame), true);

const editor = readFileSync("components/page-editor.tsx", "utf8");
is("the preview view and the page beside the blocks share one choice, each with its own default", editor.includes("const [chosenScreen, setScreen] = usePreviewScreen();") && editor.includes('const screen = screenFor("beside", chosenScreen);') && editor.includes('const fullScreen = screenFor("full", chosenScreen);') && editor.includes("<ScreenSwitch value={fullScreen} onChange={setScreen} />") && editor.includes("{pagePreview(fullScreen)}") && editor.includes("<ScreenSwitch value={screen} onChange={setScreen} />") && editor.includes("{pagePreview(screen)}"), true);
is("the page beside the blocks keeps its scrollbar's room, so its width does not change when one appears", /className="sp-beside [^"]*overflow-y-auto [^"]*\[scrollbar-gutter:stable\]/.test(editor), true);
is("the editor no longer keeps a width of its own", !/\bsetWide\b|"Wide"/.test(editor), true);
is("the page is drawn inside the frame, with the computer's column", editor.includes("<PreviewFrame screen={on}>") && editor.includes("style={on === \"computer\" ? { maxWidth: COMPUTER_BODY_MAX } : undefined}"), true);
is("the page beside the blocks says which screen it shows", editor.includes(", on a ${screen} · press a part to edit it"), true);
is("its links stay inert: the blocks are drawn with the preview context", /const ctx: BlockContext = \{[\s\S]{0,300}?preview: true,/.test(editor), true);

done();
