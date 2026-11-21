/**
 * The studio's blog page (app/studio/blog/page.tsx) opens with a sentence that
 * holds the blog's address, "marktmorgen.com/@<handle>/blog". An address has no
 * spaces, so the browser kept it on one line: at 320 px wide (WCAG 2.2 1.4.10
 * Reflow, AX274 Part A item 4) the whole page scrolled sideways to 394 px with a
 * synthetic store's handle. The paragraph now lets a long address break anywhere
 * ([overflow-wrap:anywhere]), so it wraps inside the screen.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const page = readFileSync("app/studio/blog/page.tsx", "utf8");
const at = page.indexOf("What you know, at marktmorgen.com/@${store.handle}/blog");
const open = page.lastIndexOf("<p", at);
const className = /className="([^"]*)"/.exec(page.slice(open, at))?.[1] ?? "";

is("the opening sentence still names the blog's address", at > 0 && open > 0, true);
is("a long address in it wraps inside a 320px screen", /\[overflow-wrap:anywhere\]/.test(className), true);
is("the paragraph keeps its line length cap", /\bmax-w-2xl\b/.test(className), true);

done();
