/**
 * Links on the studio's start page whose words alone say where they go
 * (WCAG 2.2 2.4.9 Link Purpose (Link Only), AAA; AX274 Part A item 4). Seen in
 * Chromium on 11 November 2026, /studio at 1280 px: the store coach's "Do it"
 * led to four different places (the products, the pages, the answers, the
 * reviews), and each product card's "Its page" to three different products. A
 * screen reader's list of links read "Do it, Do it, Do it…" with no way to
 * tell them apart. Each link now carries, after its visible words and only for
 * screen readers, the step's or the product's own name.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StoreCoach } from "@/components/store-coach";
import { done, is } from "./check";

const html = renderToStaticMarkup(
  createElement(StoreCoach, {
    checks: [
      { id: "a", label: "Add a second product", why: "w", href: "#products", done: false, weight: 1 },
      { id: "b", label: "Build a sales page", why: "w", href: "/studio/pages", done: false, weight: 1 },
    ],
  } as never),
);
/**
 * The words of a link as a screen reader's list of links reads them: the text outside every tag, with nothing inside
 * an svg (an icon). It walks the markup once, tag by tag, so a tag can never be left half removed.
 */
function wordsOf(inner: string): string {
  let words = "";
  let inIcon = 0;
  let at = 0;
  while (at < inner.length) {
    if (inner[at] !== "<") {
      if (inIcon === 0) words += inner[at];
      at += 1;
      continue;
    }
    const end = inner.indexOf(">", at);
    if (end < 0) throw new Error("a tag that does not close in the rendered link");
    const tag = inner.slice(at + 1, end);
    if (/^svg[\s>]?/.test(tag) && !tag.endsWith("/")) inIcon += 1;
    else if (/^\/svg\b/.test(tag)) inIcon -= 1;
    at = end + 1;
  }
  return words.trim();
}
const links = [...html.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => wordsOf(m[1]));
is("each Do it says which step it does", links, ["Do it: Add a second product", "Do it: Build a sales page"]);
is("the step's name is for screen readers; the button still shows Do it", /Do it<span class="sr-only">: Add a second product<\/span>/.test(html), true);

// CodeQL js/incomplete-multi-character-sanitization (code-scanning #240, Claude 1's LEVE 6872826530 on #3782): this test
// read each link's words with a one-pass tag strip. It reads them without one (the pattern is built so that this
// line does not hold it either).
const ONE_PASS_STRIP = ".replace(/<" + "[^>]+>/g";
is("the link words are read without a one-pass tag strip", readFileSync("tests/studio-home-link-purpose.test.ts", "utf8").includes(ONE_PASS_STRIP), false);

const editor = readFileSync("components/product-editor.tsx", "utf8");
const at = editor.indexOf("Its page\n");
const link = editor.slice(editor.lastIndexOf("<a ", at), editor.indexOf("</a>", at));
is("each card's Its page names its product", /Its page\s*<span className="sr-only">\{`: \$\{product\.title\}`\}<\/span>/.test(link), true);

done();
