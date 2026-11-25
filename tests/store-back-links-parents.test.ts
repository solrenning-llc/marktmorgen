/**
 * WCAG 2.2 2.5.5 Target Size (Enhanced), AAA (274 [AX1]), the two LEVE notes left open on #3746 (owner's item 4, board
 * #5285): app/globals.css gives a store page's stand-alone way back a 44 px box with `.st-page :is(div, nav) >
 * a.st-footer-link`, and two things rested on reading by hand.
 *
 * 1. That every <div> or <nav> holding such a link directly holds no words beside it (a link inside a sentence keeps
 *    its line, which 2.5.5 exempts): read here, for every .tsx under app/ and components/.
 * 2. That a stand-alone link the rule does not reach (its parent is not a <div> or <nav>, as on the embed pages) has
 *    a 44 px box of its own: it did not on app/embed/[handle]/join (inline-block text-sm, about 20 px) nor on the
 *    community page's way back to the store (app/[handle]/community/about). Both now carry min-h-11, and every such
 *    link must carry a height of its own, or be one 2.5.5 exempts (a quote's caption, a summary).
 *
 * Static: the JSX is read with the TypeScript parser; nothing is drawn. What the box measures in a browser is held by
 * the classes and by the rule's own test (tests/store-back-links-target.test.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { done, is, part } from "./check";

type Hit = { where: string; parent: string; className: string; words: string[] };

const LINKS = new Set(["a", "Link", "NewTabLink"]);
const nameOf = (n: ts.Node): string | null =>
  ts.isJsxElement(n) ? n.openingElement.tagName.getText() : ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : null;
const classOf = (n: ts.Node): string => {
  const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
  const attribute = open?.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === "className");
  return attribute ? attribute.getText() : "";
};
/** Words written straight into a parent: JSX text, or a string literal in braces. */
const wordsOf = (parent: ts.JsxElement): string[] =>
  parent.children.flatMap((c) =>
    ts.isJsxText(c) && c.getText().trim() ? [c.getText().trim()] :
    ts.isJsxExpression(c) && c.expression && (ts.isStringLiteral(c.expression) || ts.isNoSubstitutionTemplateLiteral(c.expression)) && c.expression.text.trim() ? [c.expression.text.trim()] : []);

function hits(): Hit[] {
  const out: Hit[] = [];
  for (const root of ["app", "components"]) {
    for (const f of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!f.endsWith(".tsx")) continue;
      const file = `${root}/${f}`;
      const text = readFileSync(file, "utf8");
      if (!text.includes("st-footer-link")) continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const walk = (node: ts.Node, parent: ts.JsxElement | null) => {
        const tag = nameOf(node);
        if (tag && LINKS.has(tag) && classOf(node).includes("st-footer-link")) {
          out.push({
            where: `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
            parent: parent ? nameOf(parent) ?? "?" : "none",
            className: classOf(node),
            words: parent ? wordsOf(parent) : [],
          });
        }
        ts.forEachChild(node, (child) => walk(child, ts.isJsxElement(node) ? node : parent));
      };
      walk(source, null);
    }
  }
  return out;
}

/** A height of its own: min-h-11 (2.75rem), min-h-[44px], or py-3 with text-sm (24 + 20 px). */
const ownHeight = (className: string) => /(^|[\s"`])min-h-(11|\[44px\]|\[2\.75rem\])(?=[\s"`]|$)/.test(className) || (/\bpy-3\b/.test(className) && /\btext-sm\b/.test(className));

async function main(): Promise<void> {
  const found = hits();
  part("Every link styled as a store's way back is found");
  is("there are such links to check", found.length > 40, true);

  part("1. A <div> or <nav> the 44 px rule reaches holds no words beside its link");
  const inRule = found.filter((h) => h.parent === "div" || h.parent === "nav");
  is("links the rule reaches", inRule.length > 30, true);
  is("none has words beside it in the same parent", inRule.filter((h) => h.words.length).map((h) => `${h.where} ${JSON.stringify(h.words)}`), []);

  part("2. A stand-alone link the rule does not reach has a 44 px box of its own, or is exempt");
  // Inside a <p> or <span> a link sits in a sentence (exempt); a quote's caption is not a way back (exempt by the rule's design).
  const outside = found.filter((h) => !["div", "nav", "p", "span", "figcaption"].includes(h.parent));
  is("each carries its own height", outside.filter((h) => !ownHeight(h.className)).map((h) => `${h.where} parent=${h.parent}`), []);
  is("the embed form's way back is one of them", outside.some((h) => h.where.startsWith("app/embed/[handle]/join/page.tsx")), true);
  is("and the community page's way back to the store", outside.some((h) => h.where.startsWith("app/[handle]/community/about/page.tsx")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
