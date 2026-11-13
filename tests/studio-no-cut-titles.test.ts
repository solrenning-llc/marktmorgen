/**
 * AX274, WCAG 1.4.10 Reflow and 1.4.12 Text Spacing: no words are lost when the
 * page is zoomed to 400% or its text is spaced out. Chromium on 13 November 2026,
 * at 320 CSS px with 4x scale and at 1280 px with the 1.4.12 spacing (line height
 * 1.5, letters 0.12em, words 0.16em, paragraphs 2em): the product lists beside
 * /studio/pages, /studio/funnels and /studio/bundles cut each product's name at
 * 14rem with an ellipsis ("Weekend Batch Cooking Pl…"), and each block's summary
 * line in the page editor was cut the same way, down to the share of visitors who
 * reach it. Nothing else on those screens gives the whole name or line.
 *
 * What must hold: these lines wrap instead of being cut (break-words, no
 * truncate). The numbers table's cut titles are PR #3863.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const spanBefore = (file: string, text: string) => {
  const source = readFileSync(file, "utf8");
  const at = source.indexOf(text);
  const open = source.lastIndexOf("<span", at);
  return at < 0 || open < 0 ? "" : (source.slice(open, at).match(/className="([^"]*)"/)?.[1] ?? "");
};

part("Product names in the side lists wrap");
for (const [file, text] of [
  ["app/studio/pages/page.tsx", "{p.title}</span>"],
  ["app/studio/funnels/page.tsx", "{p.title}</span>"],
  ["app/studio/bundles/page.tsx", "{b.title}</span>"],
] as const) {
  const c = spanBefore(file, text).split(/\s+/);
  is(`${file}: the name is found`, c.length > 1, true);
  is(`${file}: the name wraps instead of being cut`, !c.includes("truncate") && c.includes("break-words") && c.includes("min-w-0"), true);
}

part("A block's summary line in the page editor wraps");
const editor = spanBefore("components/page-editor.tsx", '{block.saved ? "Saved section · " : ""}').split(/\s+/);
is("the summary line is found", editor.length > 1, true);
is("it wraps instead of being cut", !editor.includes("truncate") && editor.includes("break-words"), true);

done();
