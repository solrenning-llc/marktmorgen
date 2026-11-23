/**
 * Five pages say what each part is, in words a screen reader can reach
 * (WCAG 1.3.1, 2.4.6, 2.4.10, and 2.4.9 at AAA; 1.4.10 for names cut short;
 * AGENTS.md AX274 Part A item 4):
 *
 *   - a member who cannot switch tiers or plans (app/[handle]/manage/switch)
 *     got a page with no heading at all: the problem's title is now its h1,
 *     as the page's other states have;
 *   - each request to talk in the community's messages showed "Accept" and
 *     "Decline, and hear no more from them" with nothing saying whose
 *     request: each button now carries the person's name, after its visible
 *     words (2.5.3 keeps the visible words first);
 *   - a private conversation's heading cut a long name with an ellipsis, the
 *     only place on that page the name is written: it now wraps;
 *   - a payment request's table of items had no name: it is named by the
 *     page's heading;
 *   - the affiliate hub cut each store's name with an ellipsis and did not
 *     make it a heading, so its cards were one undivided run, and every card
 *     repeated "Open your numbers" and "Visit the store": the name is now
 *     each card's h2, written in full, and both links say which store.
 *
 * Checked in the real source with the TypeScript parser; the pages need a
 * store, a session and Stripe to render, which other tests set up for their
 * own states. Not checked here: a real screen reader's reading.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { done, is, part } from "./check";

type El = { tag: string; attrs: Record<string, string>; text: string; node: ts.JsxElement | ts.JsxSelfClosingElement };

function elements(file: string): El[] {
  const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: El[] = [];
  const visit = (node: ts.Node) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (opening) {
      const attrs: Record<string, string> = {};
      for (const a of opening.attributes.properties) {
        if (ts.isJsxAttribute(a) && a.initializer) attrs[a.name.getText(tree)] = a.initializer.getText(tree).replace(/^["{]|["}]$/g, "");
      }
      out.push({ tag: opening.tagName.getText(tree), attrs, text: node.getText(tree), node: node as ts.JsxElement });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}
const classes = (e: El) => (e.attrs.className ?? "").split(/\s+/);

part("A tier or plan switch that cannot be made has a heading");
{
  const els = elements("app/[handle]/manage/switch/page.tsx");
  // The notes that say why the switch cannot be made (the other notes explain a switch that can).
  const notes = els.filter((e) => e.tag === "div" && classes(e).includes("st-note") && /(switchProblems\[result\.reason\]|problem)\.title/.test(e.text));
  is("both problem notes are found", notes.length, 2);
  is("each problem's title is the page's h1", notes.map((n) => /^<div[^>]*>\s*<h1\b/.test(n.text)), [true, true]);
  is("four h1 in all: two for the switch, two for its problem", els.filter((e) => e.tag === "h1").length, 4);
}

part("Each request to talk says whose it is");
{
  const els = elements("app/[handle]/community/messages/page.tsx");
  const buttons = els.filter((e) => e.tag === "button" && e.attrs.type === "submit");
  is("the accept and decline buttons are found", buttons.length, 2);
  is("each carries the person's name for a screen reader", buttons.map((b) => /<span className="sr-only">: \{nameOf\(c\.other\)\}<\/span>/.test(b.text)), [true, true]);
  is("each says its visible words first", buttons.map((b) => b.text.indexOf("{w.") < b.text.indexOf("sr-only")), [true, true]);
}

part("A private conversation's heading writes the whole name");
{
  const h1 = elements("app/[handle]/community/messages/[pair]/page.tsx").filter((e) => e.tag === "h1");
  is("one heading", h1.length, 1);
  is("never cut with an ellipsis", classes(h1[0]).includes("truncate"), false);
  is("long words wrap", classes(h1[0]).includes("[overflow-wrap:anywhere]"), true);
}

part("A payment request's table is named");
{
  const els = elements("app/[handle]/pay/[request]/page.tsx");
  const table = els.filter((e) => e.tag === "table");
  is("one table", table.length, 1);
  const by = table[0].attrs["aria-labelledby"];
  is("named by the page's heading", els.filter((e) => e.tag === "h1" && e.attrs.id && e.attrs.id === by).length, 1);
}

part("The affiliate hub: each store is a heading, and its links say which store");
{
  const els = elements("app/affiliate/page.tsx");
  const names = els.filter((e) => e.text.includes("{store.name}") && /^<(p|h2|h3)\b[^>]*>\{store\.name\}<\//.test(e.text));
  is("each store's name is its card's h2", names.map((e) => e.tag), ["h2"]);
  is("written in full, never cut", names.map((e) => classes(e).includes("truncate")), [false]);
  const links = els.filter((e) => e.tag === "a" && /Open your numbers|Visit the store/.test(e.text));
  is("both links are found", links.length, 2);
  is("both name the store for a screen reader", links.map((l) => /sr-only[^>]*>[^<]*\{store\.name\}/.test(l.text)), [true, true]);
  const headings = els.filter((e) => /^h[1-6]$/.test(e.tag)).map((e) => e.tag);
  is("headings go h1, then h2 for each store and the closing panel, with no level skipped", headings, ["h1", "h2", "h2"]);
}

done();
