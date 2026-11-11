/**
 * The studio's section bar (components/studio-start.tsx, StudioNav): every
 * link in it is a 44 × 44 px target (WCAG 2.2 2.5.5 Target Size (Enhanced),
 * AAA, AX274 Part A item 4). The bar sits on every studio page and on a phone
 * is the way between sections, so a 36 px row (h-9) was too small to hit.
 */
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

done();
