/**
 * The room the page editor offers for one more picture (components/
 * page-editor.tsx) counts every other block's pictures by the page's own
 * reading (lib/sales-page.ts, picturesOf), a row's (375 [TB1]) included.
 * Otherwise the editor offers room the save then refuses with "pictures".
 *
 * What fails here: the pictures counted elsewhere on the page leaving out a
 * row's; the editor counting them by a list of kinds of its own.
 */
import { readFileSync } from "node:fs";
import * as page from "@/lib/sales-page";
import { MAX_PAGE_PICTURES, type PageBlock } from "@/lib/sales-page";
import { done, is, part } from "./check";

const picture = (n: number) => ({ path: `images/${"a".repeat(24)}/${String(n).padStart(32, "b")}.webp`, width: 10, height: 10, alt: `Picture ${n}`, caption: "" });
const pictures: PageBlock = { id: "pics0001", kind: "pictures", heading: "", items: [picture(1), picture(2)] } as unknown as PageBlock;
const row: PageBlock = { id: "row00001", kind: "row", columns: [[{ kind: "image", picture: picture(3), decorative: false }], [{ kind: "image", picture: picture(4), decorative: true }]] };
const feature: PageBlock = { id: "feat0001", kind: "feature", heading: "", body: "Words", picture: picture(5), side: "left" } as unknown as PageBlock;
const blocks = [pictures, row, feature];
const outside = (all: PageBlock[], index: number) => (typeof page.picturesOutside === "function" ? page.picturesOutside(all, index) : -1);

part("Pictures elsewhere on the page");
is("beside the pictures block: the row's two and the feature's one", outside(blocks, 0), 3);
is("beside the feature: the pictures block's two and the row's two", outside(blocks, 2), 4);
is("beside the row: the others only", outside(blocks, 1), 3);
is("so the room left never counts a row's pictures as free", MAX_PAGE_PICTURES - outside(blocks, 0) - 2, MAX_PAGE_PICTURES - 5);

part("The editor counts them by that reading");
const editor = readFileSync("components/page-editor.tsx", "utf8");
const elsewhere = editor.match(/const elsewhere = [^\n]+/g) ?? [];
is("both places that offer room for a picture", elsewhere.length, 2);
is("each counts by picturesOutside", elsewhere.every((line) => /= picturesOutside\(drafts\.map\(\(d\) => d\.block\), index\);$/.test(line)), true);
is("none by a list of kinds of its own", /d\.block\.kind === "pictures" \? d\.block\.items\.length/.test(editor), false);

done();
