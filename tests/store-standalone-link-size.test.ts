/**
 * A link or button a buyer presses on a store's own pages, drawn as `.st-footer-link`, is at least 44 by 44 CSS px
 * (WCAG 2.5.5 Target Size, AAA; 274 [AX1]), unless it sits inside a sentence, which the criterion exempts.
 *
 * Found by a browser audit of the buyer's pages on 13 November 2026 (Chromium, axe-core, the synthetic store of
 * tests/e2e/seed.ts at 320 and 1280 px): "Back to <store>" on the membership pages, the review and tip pages measured
 * 18 to 20 px tall, "Your membership" and "Back to your membership" 18 px. The 44 px rule in app/globals.css reached
 * only the store front ([data-store-layout]); every other page of a store drew the same link at its text's height.
 *
 * The cause is fixed once, in the stylesheet: on any store page (.st-page), such a link whose parent is a div (a row of
 * links, never running text) is an inline flex box 2.75rem tall, and a summary drawn as one opens from a 44 px row.
 * Where the parent is anything else, the element carries its own 44 px classes, or it is a link in a sentence.
 *
 * Checked by reading every .tsx of the store's pages and the components they draw with the TypeScript parser (the
 * element, its parent element, and that parent's other children). This keeps the cause from coming back; it is not a
 * conformance audit and certifies nothing else.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { done, is, part } from "./check";

const rule = (css: string, selector: RegExp) => css.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
/** A rule whose selector list holds this selector (as written), wherever in the list it is. */
const listed = (css: string, selector: string) => {
  // Comments dropped first, cut by index (no single-pass regex), so a selector list is read without the note above it.
  let bare = "";
  for (let at = 0; at < css.length; ) {
    const open = css.indexOf("/*", at);
    if (open < 0) {
      bare += css.slice(at);
      break;
    }
    bare += css.slice(at, open);
    const close = css.indexOf("*/", open + 2);
    at = close < 0 ? css.length : close + 2;
  }
  for (const block of bare.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (block[1].split(",").map((s) => s.trim()).includes(selector)) return block[2];
  }
  return "";
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

type Found = { where: string; tag: string; cls: string; parent: string; text: boolean; alone: boolean };

/** Every element with the class st-footer-link, with its parent element and what else that parent holds. */
function footerLinks(file: string): Found[] {
  const source = readFileSync(file, "utf8");
  if (!source.includes("st-footer-link")) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Found[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attr = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === "className");
      const cls = attr && ts.isJsxAttribute(attr) ? (attr.initializer?.getText() ?? "") : "";
      if (/\bst-footer-link\b/.test(cls)) {
        const element = ts.isJsxOpeningElement(node) ? node.parent : node;
        let parent: ts.Node | undefined = element.parent;
        while (parent && !ts.isJsxElement(parent)) parent = parent.parent;
        const others = parent && ts.isJsxElement(parent) ? parent.children.filter((c) => c !== element && !(ts.isJsxText(c) && !c.getText().trim())) : [];
        out.push({
          where: `${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          tag: node.tagName.getText(),
          cls,
          parent: parent && ts.isJsxElement(parent) ? parent.openingElement.tagName.getText() : "",
          // Running words beside it in the same parent: written text, or an expression that is not an element.
          // An expression is words when it draws no element and is more than a bare name (a call, a template, a string);
          // a comment, a condition that draws elements, or a name holding an element ({back}) is not.
          text: others.some((c) => ts.isJsxText(c) || (ts.isJsxExpression(c) && Boolean(c.expression) && !c.getText().includes("<") && !/^\{\s*\w+\s*\}$/.test(c.getText()))),
          alone: others.length === 0,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

const tall = (cls: string) => /\binline-flex\b/.test(cls) && /\bmin-h-(11\b|\[44px\])/.test(cls);
/** The way some pages already reached 44 px: a block of 20 px text with 12 px of padding above and below. */
const padded = (cls: string) => /\binline-block\b/.test(cls) && /\bpy-3\b/.test(cls) && /\btext-sm\b/.test(cls);

async function main(): Promise<void> {
  const css = readFileSync("app/globals.css", "utf8");

  part("2.5.5: the stylesheet gives a standalone link 44 px on every page of a store, not only its front");
  const row = listed(css, ".st-page div > .st-footer-link:not(summary)");
  is("a .st-footer-link whose parent is a div, on any store page, is an inline flex box 2.75rem tall, its words centered", [/display:\s*inline-flex/.test(row), /align-items:\s*center/.test(row), /min-height:\s*2\.75rem/.test(row)], [true, true, true]);
  const summary = listed(css, ".st-page summary.st-footer-link");
  is("a summary drawn as one (the product page's \"Or join the waitlist\") opens from a 44 px row on any store page, keeping its triangle", [/display:/.test(summary), /min-height:\s*2\.75rem/.test(summary), /calc\(\(2\.75rem - 1lh\) \/ 2\)/.test(summary)], [false, true, true]);
  is("the store front's own rule is still there (tests/store-front-accessibility.test.ts)", /min-height:\s*2\.75rem/.test(rule(css, /\[data-store-layout\] \.st-footer-link:not\(summary, figcaption > \*\)/)), true);

  const files = [...walk("app/[handle]"), ...walk("app/embed"), ...walk("components")];
  const found = files.flatMap(footerLinks).filter((f) => ["a", "Link", "button", "summary"].includes(f.tag));
  is("the parser found the links it is meant to check", found.length > 60, true);

  part("2.5.5: a link in a row of links is never beside running words, so the row's 44 px never tears a sentence");
  const inDiv = found.filter((f) => f.parent === "div" && f.tag !== "summary");
  is("links whose parent is a div, with words of their own beside them", inDiv.filter((f) => f.text).map((f) => f.where), []);

  part("2.5.5: every other one carries its own 44 px, or is a link inside a sentence (the criterion's exception)");
  // The store front's own links are covered by its own rule ([data-store-layout]), held by tests/store-front-accessibility.test.ts.
  const front = (f: Found) => f.where.startsWith(join("app", "[handle]", "page.tsx") + ":");
  const short = found.filter((f) => f.parent !== "div" && f.tag !== "summary" && !front(f) && !tall(f.cls) && !padded(f.cls) && !(f.parent === "p" && f.text) && f.parent !== "figcaption");
  is("links and buttons outside a sentence that are under 44 px", short.map((f) => `${f.where} <${f.tag}> in <${f.parent}>`), []);
  const summaries = found.filter((f) => f.tag === "summary" && !/\bpy-2\.5\b/.test(f.cls));
  is("summaries drawn as such a link are inside a .st-page page and keep their disclosure triangle (no flex of their own)", summaries.filter((f) => /\b(inline-)?flex\b/.test(f.cls)).map((f) => f.where), []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
