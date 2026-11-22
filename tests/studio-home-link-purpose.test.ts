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
const links = [...html.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1].replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim());
is("each Do it says which step it does", links, ["Do it: Add a second product", "Do it: Build a sales page"]);
is("the step's name is for screen readers; the button still shows Do it", /Do it<span class="sr-only">: Add a second product<\/span>/.test(html), true);

const editor = readFileSync("components/product-editor.tsx", "utf8");
const at = editor.indexOf("Its page\n");
const link = editor.slice(editor.lastIndexOf("<a ", at), editor.indexOf("</a>", at));
is("each card's Its page names its product", /Its page\s*<span className="sr-only">\{`: \$\{product\.title\}`\}<\/span>/.test(link), true);

done();
