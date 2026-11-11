/**
 * The studio's section bar (components/studio-start.tsx, StudioNav): every
 * link in it is a 44 × 44 px target (WCAG 2.2 2.5.5 Target Size (Enhanced),
 * AAA, AX274 Part A item 4). The bar sits on every studio page and on a phone
 * is the way between sections, so a 36 px row (h-9) was too small to hit.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioNav } from "@/components/studio-start";
import { done, is } from "./check";

const items = [
  { href: "/studio?store=s1", label: "Store" },
  { href: "/studio?store=s1#products", label: "Products" },
  { href: "/studio/team?store=s1", label: "API" },
];
const html = renderToStaticMarkup(createElement(StudioNav, { items }));
const classes = [...html.matchAll(/<a [^>]*class="([^"]*)"/g)].map((m) => m[1].split(/\s+/));

is("one link per section", classes.length, 3);
is("every link is at least 44px tall (min-h-11)", classes.every((c) => c.includes("min-h-11")), true);
is("and at least 44px wide, even with a short label like \"API\" (min-w-11)", classes.every((c) => c.includes("min-w-11")), true);
is("no fixed height caps it below 44px", classes.some((c) => c.some((k) => /^h-(\d+|\[)/.test(k))), false);
is("its words stay centered in the larger target", classes.every((c) => c.includes("inline-flex") && c.includes("items-center") && c.includes("justify-center")), true);
is("the bar is still named for screen readers", html.startsWith('<nav aria-label="Studio sections"'), true);

// The header (64px) and this bar (60px with its 44px links) stay on top while the page scrolls: 124px. A control the
// keyboard reaches is scrolled to scroll-padding-top, which was 88px (5.5rem), so it could land under the bar, partly
// or wholly hidden (WCAG 2.4.11 AA, 2.4.12 AAA; Claude 3's LOW on this PR). Measured in Chromium on main: 2 controls
// wholly and 25 partly hidden in 200 Shift+Tab steps on /studio at 1280px. A page that draws the bar keeps 136px
// (8.5rem): 124px plus room for the focus ring.
is("the bar marks itself, so the page's scroll padding can make room for it", /<nav [^>]*data-studio-nav=""/.test(html), true);
const css = readFileSync("app/globals.css", "utf8");
const rule = /html:has\(\[data-studio-nav\]\)\s*\{\s*scroll-padding-top:\s*([\d.]+)rem;\s*\}/.exec(css);
is("a page with the bar keeps a scroll padding as tall as the header, the bar and the focus ring", rule !== null && Number(rule[1]) * 16 >= 64 + 60 + 12, true);
is("and it comes after the site's own html scroll padding, so it wins", rule !== null && css.indexOf(rule[0]) > css.indexOf("scroll-padding-top: 5.5rem;"), true);

done();
