/**
 * WCAG 2.4.10 (section headings) and 1.3.1 on the start of a new sales page
 * in the studio (components/page-editor.tsx): "Start the page" and "Or start
 * from a template" look like headings and head long parts of the page (the
 * templates, each with its blocks), so they are headings, one level under
 * the page's own ("Sales page for ..."), and each template's name heads its
 * card. The look does not change. The editor needs a signed-in creator, so
 * the markup is read from its source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("components/page-editor.tsx", "utf8");
assert.match(source, /<h2 id="page-title"/, "the page's own heading is level 2");
assert.match(source, /<h3 className="font-semibold text-ink">Start the page<\/h3>/, "\"Start the page\" is a level-3 heading, with the same look");
assert.match(source, /<h3 className="field-label">Or start from a template<\/h3>/, "\"Or start from a template\" is a level-3 heading, with the same look");
assert.match(source, /<h4 className="text-sm font-semibold text-ink">\{t\.label\}<\/h4>/, "each template's name heads its card at level 4, with the same look");
console.log("Page editor: the start of a new page is in headings under the page's own");
