/**
 * Adding a block at an exact place from the side menu beside the page
 * (lib/block-insert.ts, components/block-picker.tsx, components/page-editor.tsx;
 * queue item 375 [TB1], unit 4).
 *
 * What is checked, against the real code:
 *
 *   - what is offered is the editor's own rule: no form on a product's page,
 *     only a store page's own kinds there, one hero, one place for reviews;
 *   - the places are before the first block (under the hero when there is one),
 *     between every two and after the last, and none on a full page;
 *   - an insertion lands exactly where asked, a hero always on top, never
 *     above the hero, and is refused with nothing changed on a full page or
 *     for a kind not offered;
 *   - what the status region says names the block and its position from 1;
 *   - the gallery and the side menu draw one list with one search;
 *   - the editor's every place is "Add here" by press or keyboard, with a 44
 *     pixel target and its visible words in its name, dropping a dragged card
 *     goes through the same insertion, the new block's first field takes the
 *     focus, and the side menu stands only on a wide screen.
 *
 * Not checked here (needs a browser: tests/e2e): the drag itself, where the
 * focus really lands, a screen reader reading the status region, and the
 * three columns at 1280 pixels and wider.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { BLOCK_GROUPS, blockGroupsFor } from "@/components/block-picker";
import { addedSaying, chosenSaying, firstPlace, insertAt, insertionPlaces, offeredKinds, placeFor, placeWords } from "@/lib/block-insert";
import { BLOCK_KINDS, MAX_BLOCKS, type BlockKind } from "@/lib/sales-page";
import { SITE_KINDS } from "@/lib/site-page-rules";

type Item = { kind: BlockKind; id: string };
const items = (...kinds: BlockKind[]): Item[] => kinds.map((kind, i) => ({ kind, id: `b${i}` }));
const kindOf = (item: Item) => item.kind;
const kindsIn = (list: readonly Item[]) => list.map(kindOf);

async function main(): Promise<void> {
  part("What is offered: the editor's own rule");
  const all = BLOCK_KINDS.map((k) => k.kind);
  is("a product's page: every kind but the form, in the gallery's order", offeredKinds([]), all.filter((k) => k !== "form"));
  is("a store's own page: only its kinds", offeredKinds([], SITE_KINDS), all.filter((k) => SITE_KINDS.includes(k)));
  is("one hero", offeredKinds(["hero", "text"]).includes("hero"), false);
  is("one place for reviews", offeredKinds(["text", "reviews"]).includes("reviews"), false);
  is("a hero not on top does not count as the hero", offeredKinds(["text", "hero"]).includes("hero"), true);

  part("The places");
  is("an empty page: one place", insertionPlaces([]), [0]);
  is("before the first, between every two, after the last", insertionPlaces(["text", "faq", "cta"]), [0, 1, 2, 3]);
  is("never above the hero", insertionPlaces(["hero", "text"]), [1, 2]);
  is("first place under the hero", firstPlace(["hero"]), 1);
  is("a full page: none", insertionPlaces(Array.from({ length: MAX_BLOCKS }, () => "text" as BlockKind)), []);
  is("one short of full: still every place", insertionPlaces(Array.from({ length: MAX_BLOCKS - 1 }, () => "text" as BlockKind)).length, MAX_BLOCKS);
  is("a hero goes on top wherever asked", placeFor(["text", "faq"], "hero", 2), 0);
  is("left out: the end", placeFor(["text", "faq"], "cta", undefined), 2);
  is("past the end: the end", placeFor(["text"], "cta", 9), 1);
  is("above the hero: under it", placeFor(["hero", "text"], "cta", 0), 1);
  is("a fraction is a whole place", placeFor(["text", "faq", "cta"], "faq", 1.7), 1);

  part("Inserting");
  const page = items("hero", "benefits", "faq", "cta");
  const between = insertAt(page, kindOf, { kind: "text", id: "new" }, "text", 2);
  is("between the second and the third block", between.ok ? { at: between.at, kinds: kindsIn(between.items) } : between, {
    at: 2,
    kinds: ["hero", "benefits", "text", "faq", "cta"],
  });
  is("the page given is not changed", kindsIn(page), ["hero", "benefits", "faq", "cta"]);
  const first = insertAt(items("text", "faq"), kindOf, { kind: "video", id: "new" }, "video", 0);
  is("before the first block", first.ok ? kindsIn(first.items) : first, ["video", "text", "faq"]);
  const last = insertAt(items("text", "faq"), kindOf, { kind: "cta", id: "new" }, "cta", 2);
  is("after the last block", last.ok ? kindsIn(last.items) : last, ["text", "faq", "cta"]);
  const hero = insertAt(items("text", "faq"), kindOf, { kind: "hero", id: "new" }, "hero", 2);
  is("a hero asked for at the end goes on top", hero.ok ? { at: hero.at, kinds: kindsIn(hero.items) } : hero, { at: 0, kinds: ["hero", "text", "faq"] });
  is(
    "a full page refuses",
    insertAt(Array.from({ length: MAX_BLOCKS }, (_, i) => ({ kind: "text" as BlockKind, id: `${i}` })), kindOf, { kind: "faq", id: "new" }, "faq", 1),
    { ok: false, why: "full" },
  );
  is("a second hero is refused", insertAt(page, kindOf, { kind: "hero", id: "new" }, "hero", 1), { ok: false, why: "not_offered" });
  is("a second place for reviews is refused", insertAt(items("reviews"), kindOf, { kind: "reviews", id: "new" }, "reviews", 1), { ok: false, why: "not_offered" });
  is("a form on a product's page is refused", insertAt(items("text"), kindOf, { kind: "form", id: "new" }, "form", 1), { ok: false, why: "not_offered" });
  const siteOnly = all.find((k) => !SITE_KINDS.includes(k) && k !== "form");
  is(
    "a kind a store's own page cannot hold is refused there",
    siteOnly ? insertAt(items("text"), kindOf, { kind: siteOnly, id: "new" }, siteOnly, 1, { siteKinds: SITE_KINDS }) : "none",
    siteOnly ? { ok: false, why: "not_offered" } : "none",
  );
  is("a smaller limit is kept", insertAt(items("text", "faq"), kindOf, { kind: "cta", id: "new" }, "cta", 1, { max: 2 }), { ok: false, why: "full" });

  part("What is said");
  is("the place in words: an empty page", placeWords(0, 0), "to the page");
  is("the place in words: the top", placeWords(0, 3), "at the top");
  is("the place in words: between", placeWords(2, 4), "after block 2");
  is("the place in words: the end", placeWords(4, 4), "at the end");
  is("after adding: its name and position counted from 1", addedSaying("Text", 2), "Added Text at position 3.");
  is("after choosing a card: what to do next, and how to cancel", chosenSaying("Video"), "Video chosen. Now press Add here where it should go, or Escape to cancel.");

  part("One list, one search, in the gallery and in the side menu");
  is("no search: every group with what is allowed", blockGroupsFor(["faq", "cta"], "").map((g) => g.kinds), [["faq"], ["cta"]]);
  is("searched by name or by what it is for, among what is offered", blockGroupsFor(offeredKinds([]), "question").flatMap((g) => g.kinds), ["faq"]);
  is("with every kind allowed, the form's own words match too", blockGroupsFor(all, "question").flatMap((g) => g.kinds).sort(), ["faq", "form"]);
  is("nothing allowed: no group", blockGroupsFor([], ""), []);
  is("the groups are the gallery's own", blockGroupsFor(all, "").map((g) => g.title), BLOCK_GROUPS.map((g) => g.title));
  const picker = readFileSync("components/block-picker.tsx", "utf8");
  is("the side menu never takes the focus by itself", picker.includes("if (!menu) box.current?.focus();"), true);
  is("the two search boxes have their own ids", picker.includes('const findId = menu ? "menu-block-find" : "block-find";'), true);
  is("a card chosen says so as well as by its look", picker.includes("aria-pressed={menu && where === null ? on : undefined}") && picker.includes('name={on ? "check" : icons[kind]}'), true);
  is("the close button is a 44 pixel target", picker.includes('className="ml-auto inline-flex h-11 w-11'), true);
  is("a card's movement stops when motion is reduced", picker.includes("motion-reduce:hover:translate-y-0"), true);

  part("The editor uses them");
  const editor = readFileSync("components/page-editor.tsx", "utf8");
  is("what is offered comes from the one rule", editor.includes("const addable = offeredKinds(drafts.map((d) => d.block.kind), site?.kinds);"), true);
  is("every insertion goes through insertAt", editor.includes("insertAt(drafts, (d) => d.block.kind, { block, video: \"\" }, kind, at, { siteKinds: site?.kinds })"), true);
  is("a place before the first block", editor.includes("places.includes(0) ? <div className=\"mt-6\">{placeAt(0)}</div>"), true);
  is("a place between every two blocks", editor.includes("index < drafts.length - 1 ? placeAt(index + 1) : null"), true);
  is("each place is a 44 pixel button whose name holds its visible words", editor.includes('className={`inline-flex min-h-11 items-center gap-1 rounded-full') && editor.includes("aria-label={`Add here: ${armed"), true);
  is("a card dropped on a place goes through the same insertion", editor.includes("add(draggingKind, placeOf(event), true);"), true);
  is("the destination line is shape, not only color", editor.includes('className={`h-1 flex-1 rounded-full ${lit ? "bg-violet-brand forced-colors:bg-[Highlight] forced-colors:outline forced-colors:outline-2 forced-colors:outline-[Highlight]" : "bg-transparent"}`}'), true);
  is("the new block's first field takes the focus", editor.includes("focusNew.current = block.id;") && editor.includes('panel.querySelector<HTMLElement>("input:not([disabled])'), true);
  is("from the gallery too, at every place, through the same insertion", (editor.match(/onPick=\{\(kind\) => add\(kind, (?:at|drafts\.length), true\)\}/g) ?? []).length, 2);
  is("and from the side menu", editor.includes("add(kind, picking, true);") && editor.includes("add(armed, at, true);"), true);
  is("the focus waits for the panel to be drawn, frame by frame, instead of being dropped", editor.includes("stopFocusNew.current = focusWhenDrawn(() => {") && editor.includes("if (!panel) return null;"), true);
  is("the status region says where it went", editor.includes("setSaid(addedSaying(kindLabel(kind), result.at));") && editor.includes('<p role="status" aria-atomic="true" className="sr-only">\n        {said}'), true);
  is(
    "the side menu stands only on a wide screen, in the column it shares with the page (tests/side-panel.test.ts)",
    editor.includes('{sideBySide ? (\n        <div className="sticky top-24') && editor.includes('{sidePanel === "add" ? (\n        <aside id="side-panel" aria-label="Blocks to add"'),
    true,
  );
  is(
    "an Add here pressed while the page is shown there shows the menu, and its search takes the focus once drawn",
    editor.includes('showSidePanel("add");') && editor.includes('stopFocusMenu.current = focusWhenDrawn(() => document.getElementById("menu-block-find"), browserFrames());') && !editor.includes('document.getElementById("menu-block-find")?.focus();'),
    true,
  );
  is(
    "a new block's radio buttons are entered at the one checked, never at one a Space would check (a new row: Two columns)",
    editor.includes("return groupEntry(first, (name) => panel.querySelector<HTMLInputElement>(`input[type=radio][name=\"${CSS.escape(name)}\"]:checked:not([disabled])`));"),
    true,
  );
  is("the side menu is the same picker", editor.includes('layout="menu"'), true);
  is("saved sections lead the side menu, and stay under the blocks on a narrow screen", editor.includes("{savedSections}") && editor.includes("{sideBySide ? null : savedSections}"), true);
  is("closing goes back to the place it was opened from", editor.includes("document.querySelector<HTMLElement>(`[data-place=\"${at}\"]`)?.focus();"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
