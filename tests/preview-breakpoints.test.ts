/**
 * The page editor's Phone and Computer previews draw what a phone and a
 * computer draw (375 [TB1], unit 3, review finding 1). The preview lays the
 * page out at 390 or 1024 pixels inside the editor, so a style that reads the
 * WINDOW's width (a viewport media query, or Tailwind's sm:/md:/lg:) would
 * draw the computer's layout in "Phone" whenever the editor itself is open on
 * a computer. Every line that changes how a store page's blocks look must
 * therefore read the page's own width: .sp-body, the container the row block
 * already reads (app/globals.css).
 *
 * What is checked, against the real files:
 *
 *   - no viewport breakpoint utility is left in the files that draw a page's
 *     blocks (components/sales-blocks.tsx and what it draws, the reviews
 *     section drawn in a reviews block) or in the editor's page preview;
 *   - every viewport width rule in app/globals.css that styles a class those
 *     files draw (or the buy box's price comparison, drawn inside .sp-body on
 *     the live page) applies only outside .sp-body, and has a twin container
 *     rule inside .sp-body with the same declarations, at the window's line
 *     less the live page column's side padding (px-4, 16 pixels a side), so
 *     the live page changes at the very same window width as before;
 *   - the page-sm: variant does the same for utilities (Tailwind's sm:,
 *     40rem, becomes 38rem of page);
 *   - with those lines, the phone preview draws the phone's layout and the
 *     computer preview the computer's.
 *
 * Not checked here (needs a browser): the drawing itself. A desktop browser
 * whose scrollbar takes room counts it in the window's width but not in the
 * page's, so there the live page changes up to a scrollbar's width (about
 * 15 pixels) later than before; on phones, whose scrollbars take no room, at
 * the same width.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { PREVIEW_BODY_PADDING, previewContainerWidth } from "@/lib/preview-screen";

const css = readFileSync("app/globals.css", "utf8");

/** The files whose markup is drawn inside .sp-body as a page's blocks. */
const DRAWN = [
  "components/sales-blocks.tsx",
  "components/video-embed.tsx",
  "components/countdown.tsx",
  "components/form-keep.tsx",
  "components/form-branching.tsx",
  "components/new-tab.tsx",
  "components/review-list.tsx",
];
const VIEWPORT_UTILITY = /(?<![\w@-])(?:max-)?(?:sm|md|lg|xl|2xl):[\w[]/;

part("No window-width utility where a page's blocks are drawn");
for (const file of DRAWN) {
  const source = readFileSync(file, "utf8");
  const found = source.split("\n").filter((line) => VIEWPORT_UTILITY.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("//"));
  is(`${file} reads the page's width, not the window's`, found, []);
}
const editor = readFileSync("components/page-editor.tsx", "utf8");
const previewStart = editor.indexOf("const buyPreview = (");
const previewEnd = editor.indexOf("const field = (", previewStart);
is("the editor's page preview is found", previewStart > 0 && previewEnd > previewStart, true);
const previewSource = editor.slice(previewStart, previewEnd);
is("the editor's page preview reads the page's width, not the window's", previewSource.split("\n").filter((line) => VIEWPORT_UTILITY.test(line)), []);
is("the preview's own title, without a hero, grows as the live page's does", previewSource.includes("tracking-[-0.025em] page-sm:text-5xl"), true);

part("The page-sm: variant: the window outside a page, the page's own width inside it");
const variant = /@custom-variant page-sm \{\s*@media \(min-width: 40rem\) \{\s*&:where\(:not\(\.sp-body \*\)\) \{\s*@slot;\s*\}\s*\}\s*@container \(min-width: 38rem\) \{\s*:where\(\.sp-body\) & \{\s*@slot;\s*\}\s*\}\s*\}/;
is("defined once in app/globals.css", variant.test(css) && (css.match(/@custom-variant page-sm/g) ?? []).length === 1, true);
is("Tailwind's sm: line (40rem) less the column's padding (2 × 1rem) is the page's line", 40 - (2 * PREVIEW_BODY_PADDING) / 16, 38);
const used = DRAWN.map((file) => readFileSync(file, "utf8")).join("\n");
is("the blocks use it where they used sm:", (used.match(/page-sm:/g) ?? []).length >= 9, true);

part("Every window-width rule for a page's classes has its twin inside .sp-body");

/** The classes the page's blocks draw: sp-, st-, rv- and the button. */
const drawnClasses = new Set<string>(["btn", "st-compare-2", "st-compare-3"]);
const prefixes: string[] = [];
for (const token of used.match(/\b(?:sp|st|rv)-[a-z0-9-]*/g) ?? []) {
  if (token.endsWith("-")) {
    if (token.length > 4) prefixes.push(token);
  } else drawnClasses.add(token);
}
const isDrawn = (name: string) => drawnClasses.has(name) || prefixes.some((prefix) => name.startsWith(prefix));

/** Each at-rule whose condition matches, with its rules (selector, declarations). */
function atRules(kind: "media" | "container"): { condition: string; rules: { selector: string; body: string }[] }[] {
  const out: { condition: string; rules: { selector: string; body: string }[] }[] = [];
  const head = new RegExp(`@${kind} (\\((?:min|max)-width: [^)]+\\)) \\{`, "g");
  for (const match of css.matchAll(head)) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    const start = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    const inner = css.slice(start, i - 1).replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
      selector: selector.trim().replace(/\s+/g, " "),
      body: body.trim().replace(/\s+/g, " "),
    }));
    out.push({ condition: match[1], rules });
  }
  return out;
}

const OUTSIDE = ":where(:not(.sp-body *))";
const INSIDE = ":where(.sp-body) ";
/** The window's line in pixels, less the live page column's side padding. */
const pageLine = (condition: string) => {
  const [, kind, px] = /\((min|max)-width: ([\d.]+)px\)/.exec(condition) ?? [];
  return kind ? `(${kind}-width: ${Number(px) - 2 * PREVIEW_BODY_PADDING}px)` : null;
};
const containers = atRules("container");
const checked: string[] = [];
for (const { condition, rules } of atRules("media")) {
  for (const { selector, body } of rules) {
    const classes = [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(([, name]) => name);
    if (!classes.some(isDrawn) || classes.includes("sp-wide")) continue;
    checked.push(`${condition} ${selector}`);
    const parts = selector.split(",").map((s) => s.trim());
    is(`${condition} ${selector}: only outside a page's .sp-body`, parts.every((s) => s.endsWith(OUTSIDE) || s.includes(`${OUTSIDE} `) || s.includes(`${OUTSIDE}:`)), true);
    const line = pageLine(condition);
    const twinSelector = parts.map((s) => INSIDE + s.replace(OUTSIDE, "")).join(", ");
    const twin = containers.some((c) => c.condition === line && c.rules.some((r) => r.selector === twinSelector && r.body === body));
    is(`${condition} ${selector}: its twin at ${line} inside .sp-body draws the same`, twin, true);
  }
}
is("the rules found are the button's, the bio's, the price comparison's and the reviews summary's", ["btn", "sp-bio", "st-compare-2", "st-compare-3", "rv-summary"].every((name) => checked.some((c) => c.includes(`.${name}:where`))), true);
is(".sp-wide (the live product page's hero reaching past its column on a wide window) is drawn nowhere else, so it keeps the window", /sp-wide/.test(used) || /sp-wide/.test(previewSource), false);

part("So the phone preview draws a phone's layout, and the computer preview a computer's");
const phone = previewContainerWidth("phone");
const computer = previewContainerWidth("computer");
is("phone: the page is narrower than every page line (608px, 38rem = 608px at the default size)", phone < 608, true);
is("phone: and narrower than the button's wrapping line (447px), so a long label wraps as on a phone", phone <= 447, true);
is("computer: the page is wider than the page line, so two benefits stand side by side and headings grow", computer >= 608, true);
is("computer: and wider than the button's wrapping line", computer > 447, true);

part("The live page's column is what the lines assume");
const productPage = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
const sitePage = readFileSync("app/[handle]/[slug]/page.tsx", "utf8");
is("the product page's .sp-body sits in a column padded px-4, at most 42rem or 48rem wide", productPage.includes('${wide ? "max-w-3xl" : "max-w-2xl"} px-4') && productPage.includes("<div className={`sp-body sp-wide"), true);
is("the site page's .sp-body sits in a column padded px-4, at most 48rem wide", sitePage.includes('max-w-3xl px-4 pb-16') && sitePage.includes("<div className={`sp-body sp-style-"), true);
is("both columns reach the 608-pixel line (672 − 32 and 768 − 32)", [672 - 32, 768 - 32].every((w) => w >= 608), true);
is(".sp-body itself has no padding of its own on the live page, so its width is the column's", !/\.sp-body \{[^}]*padding/.test(css), true);

done();
