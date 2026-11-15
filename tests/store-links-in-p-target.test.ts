/**
 * #4613, increment on #3746 (AX274 Part A, WCAG 2.5.5 Target Size (Enhanced), AAA). #3746 makes a store's standalone
 * way back a 44 px target when it sits directly in a <div> or <nav> (`.st-page :is(div, nav) > a.st-footer-link`) and
 * leaves a <p> out on purpose, so that a link inside a sentence keeps its line. But a <p> that holds the link alone,
 * with no words around it, is the same standalone way back: "Back to <store>" on /discord, the product's way back on
 * /renew and /move, the course from a lesson, the store from the media kit, "Manage" under a product, "More reviews".
 * Measured on main they stay 20 px tall.
 *
 * A link alone in its <p> carries `st-solo-link` (or its own `min-h-11`), and `.st-solo-link` is a 44 px target.
 * RED is recorded first, on #3746's head; the fix follows once #3746 is in main (coordinator, 15 November 2026).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

part("A store link alone in its paragraph is a 44 px target");
const alone: string[] = [];
const small: string[] = [];
// The store front (app/[handle]/page.tsx) carries data-store-layout, whose own rule already makes these 44 px.
// components/store-resting.tsx's three are #3760's (claude4/ax-resting-links-target, min-h-11 on each).
const FRONT = join("app", "[handle]", "page.tsx");
for (const file of [...tsxFiles(join("app", "[handle]")), ...tsxFiles("components")].filter((f) => f !== FRONT)) {
  const source = readFileSync(file, "utf8");
  // A <p> whose only content is one st-footer-link (an expression or words inside the link only).
  const pattern = /<p\b[^>]*>\s*<(Link|a)\b([^>]*\bclassName="([^"]*\bst-footer-link\b[^"]*)"[^>]*)>[\s\S]*?<\/\1>\s*<\/p>/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const where = `${file}:${source.slice(0, match.index).split("\n").length}`;
    alone.push(where);
    const classes = match[3].split(/\s+/);
    if (!classes.includes("st-solo-link") && !classes.includes("min-h-11")) small.push(where);
  }
}
is("links alone in a paragraph are found (discord, renew, move, lesson, media kit, manage, more reviews ...)", alone.length >= 7, true);
is("every one is a 44 px target (st-solo-link or min-h-11)", small, []);

const css = readFileSync(join("app", "globals.css"), "utf8");
const rule = /\n\.st-solo-link\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
is(".st-solo-link is a 44 px box", [/display:\s*inline-flex/.test(rule), /min-height:\s*2\.75rem/.test(rule)], [true, true]);

done();
