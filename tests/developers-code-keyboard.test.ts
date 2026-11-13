/**
 * AX274 (the API documentation is in scope), WCAG 2.1.1 Keyboard and 2.4.6:
 * a code example wider than the screen can be scrolled from the keyboard and is
 * announced by what it shows. Chromium on 13 November 2026, /developers at 320
 * and 1280 px: axe's scrollable-region-focusable found the API examples
 * ("#keys > pre", "#answers-pages-and-limits > pre") scrolling sideways with
 * nothing in them a keyboard could reach, so their right-hand side could not be
 * read without a mouse. PR #3920 fixes the checkout-script page's examples the
 * same way; this is /developers' own Code.
 *
 * What must hold: Code's <pre> takes focus (tabIndex 0) and is a region named by
 * its label; every one of the page's examples passes a label, and no two labels
 * are the same, so each region can be told apart.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const source = readFileSync("app/developers/page.tsx", "utf8");

part("Code's <pre> is reachable and named");
const code = source.slice(source.indexOf("function Code("), source.indexOf("function Code(") + 600);
is("Code takes a label", /function Code\(\{ children, label \}: \{ children: string; label: string \}\)/.test(code), true);
is("its <pre> takes focus and is a region named by the label", /<pre tabIndex=\{0\} role="region" aria-label=\{label\}/.test(code), true);

part("Every example has its own label");
const uses = [...source.matchAll(/<Code(\s[^>]*)?>/g)].map((m) => m[1] ?? "");
const labels = uses.map((attrs) => attrs.match(/label="([^"]+)"/)?.[1] ?? null);
is("there are fifteen examples", uses.length, 15);
is("each one passes a label", labels.every((l) => l !== null && l.length > 0), true);
is("no two labels are the same", new Set(labels).size, labels.length);

done();
