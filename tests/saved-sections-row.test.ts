/**
 * A row of columns never goes into a saved section (lib/saved-blocks.ts,
 * NOT_IN_SECTIONS; queue item 375 [TB1]). A row may hold pictures, which
 * belong to the one page that shows them, and a section kept with a row in
 * it would fit no page.
 *
 * What fails here: the studio offering a row under "Save as a section" by a
 * list of its own instead of the library's rule; a row taken in at any entry
 * point of lib/saved-blocks.ts (reading what the studio sends, keeping,
 * reading what is stored, fitting, putting on a page, updating a page in
 * place); a page whose row from a section has pictures updated over them.
 */
import { readFileSync } from "node:fs";
import * as saved from "@/lib/saved-blocks";
import { BLOCK_KINDS, emptyBlock, parsePage, type PageBlock } from "@/lib/sales-page";
import { done, is, part } from "./check";

const picture = { path: `images/${"a".repeat(24)}/${"b".repeat(32)}.webp`, width: 10, height: 10, alt: "A loaf on a board", caption: "" };
const row = (saved?: string): PageBlock => ({
  id: "row00001",
  kind: "row",
  columns: [[{ kind: "image", picture, decorative: false }], [{ kind: "paragraph", text: "Words" }]],
  ...(saved ? { saved } : {}),
});
const faq: PageBlock = { ...(emptyBlock("faq") as Extract<PageBlock, { kind: "faq" }>), items: [{ q: "Is it for me?", a: "Yes." }] };
const everyKind = BLOCK_KINDS.map((k) => k.kind);

part("One rule, shared by the studio and the library");
is("a row is among the kinds a section never holds", saved.NOT_IN_SECTIONS.includes("row"), true);
is("the library says so per block", [typeof saved.savable === "function" && saved.savable(row()), typeof saved.savable === "function" && saved.savable(faq)], [false, true]);
const component = readFileSync("components/saved-sections.tsx", "utf8");
is("the studio offers blocks by the library's rule", /blocks\.filter\(savable\)/.test(component) && /\bsavable\b[^;]*from "@\/lib\/saved-blocks"/.test(component.replace(/\n\s*/g, " ")), true);
is("and keeps no list of kinds of its own", /"(?:hero|reviews|row)"/.test(component), false);

part("Every entry point refuses a row");
is("what the studio sends", (saved.readSectionInput("Look", [row()]) as { error?: string }).error, "kind");
const kept = saved.sectionBlocks([row(), faq]);
is("what is kept: no row, its picture counted as left", [kept.blocks.map((b) => b.kind), kept.picturesLeft], [["faq"], 1]);
is("what is stored: a row is dropped on reading", saved.parseSection({ id: "sect000001", name: "Old", blocks: [row(), faq] })?.blocks.map((b) => b.kind), ["faq"]);
is("a section holding a row fits no page, whatever the page allows", saved.fitsPage({ blocks: [row()] }, everyKind), false);
is("put on a page, a row is left out", saved.blocksForPage({ id: "sect000001", blocks: [row(), faq] }).map((b) => b.kind), ["faq"]);
const page = parsePage({ blocks: [faq] });
is("an update in place never brings a row", saved.withSection(page, { id: "sect000001", blocks: [row()] }, everyKind), null);

part("A page whose blocks from a section hold a row's pictures is left to the creator");
const withRow = parsePage({ blocks: [row("sect000001")] });
is("the row is kept on the page with its mark", withRow.blocks.map((b) => [b.kind, b.saved ?? ""]), [["row", "sect000001"]]);
is("and the update is not written over its pictures", saved.updateProblem(withRow, "sect000001"), "pictures");

done();
