/**
 * AX274 Part A, item 4 (WCAG 2.2 AAA) on the public site's shared header (components/site-nav.tsx), every public
 * page except the home page, which draws its own. The footer's links are #3749's (claude4/ax-site-footer-target-size).
 *
 * - 2.5.5 Target Size (Enhanced): every menu button and link in the header is at least 44 px tall (it was 40 px,
 *   `h-10`).
 * - 1.3.1 / landmarks: the logo, "Log in" and "Start your store" sit inside the header landmark (`<header>`), not
 *   in a plain `div` beside the "Main" navigation; the line about what is built today is a named region of its own.
 *   The sticky part of the header is the `<header>` itself, so it still sticks for the whole page.
 *
 * Rendered from the real components (no browser): the classes that give the size and the elements that give the
 * landmarks are read from the markup they draw.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// The server menu: the same markup as the client SiteNav, handed the plans' real state (its required opening prop, since dcf463a65f).
import { SiteNav } from "@/components/site-nav-server";
import { done, is, part } from "./check";

const nav = renderToStaticMarkup(createElement(SiteNav));

/** Drops every tag until none is left, so a tag cut in two cannot rebuild one (CodeQL js/incomplete-multi-character-sanitization). */
function withoutTags(text: string): string {
  let before: string;
  let after = text;
  do {
    before = after;
    after = before.replace(/<[^>]*>/g, "");
  } while (after !== before);
  return after;
}

/** Every opening tag of an interactive element (a, button) in the markup, with its class list. */
function targets(html: string): { tag: string; classes: string[]; text: string }[] {
  const out: { tag: string; classes: string[]; text: string }[] = [];
  const pattern = /<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const cls = /class="([^"]*)"/.exec(match[2])?.[1] ?? "";
    out.push({ tag: match[1], classes: cls.split(/\s+/).filter(Boolean), text: withoutTags(match[3]).trim() });
  }
  return out;
}

part("2.5.5: header targets are at least 44 px tall");
const headerTargets = targets(nav).filter((t) => !t.classes.includes("sr-only"));
is("the header draws its menu buttons and links", headerTargets.length > 5, true);
is("no header target is 40 px tall (h-10)", headerTargets.filter((t) => t.classes.includes("h-10")).map((t) => t.text), []);
is(
  "the menu buttons, Pricing, Blog and Log in are 44 px tall (h-11)",
  headerTargets.filter((t) => /^(Product|Creators|Why Marktmorgen|Pricing|Blog|Log in)$/.test(t.text)).every((t) => t.classes.includes("h-11")),
  true,
);

part("Landmarks: everything in the header is inside the header");
const headerOpen = nav.indexOf("<header");
const headerClose = nav.lastIndexOf("</header>");
is("the header is a <header> element", headerOpen >= 0 && headerClose > headerOpen, true);
const inside = (needle: string) => {
  const at = nav.indexOf(needle);
  return at > headerOpen && at < headerClose;
};
is("the logo is inside it", inside('aria-label="Marktmorgen, home"'), true);
is("the main navigation is inside it", inside('aria-label="Main"'), true);
is("Log in is inside it", inside('href="/signin?to=login"'), true);
is("the header is the sticky part, so it sticks for the whole page", /<header\b[^>]*class="[^"]*\bsticky\b/.test(nav), true);
const bar = /<(\w+)\b([^>]*)data-preview-bar=""([^>]*)>/.exec(nav);
if (bar) {
  const attrs = bar[2] + bar[3];
  is("the line about what is built today is a named region", (bar[1] === "section" || /role="region"/.test(attrs)) && /aria-label="[^"]+"/.test(attrs), true);
}

part("No page wraps the header in a landmark of its own (Claude 6's and Claude 7's MÉDIO on #4610)");
// SiteNav draws the page's one <header> (banner). A caller that wraps it in <header>, <nav>, <section>, <aside> or
// <main> nests a banner in another landmark: on /library that gave axe landmark-banner-is-top-level,
// landmark-no-duplicate-banner and landmark-unique, and two banners for a screen reader.
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
const wrapped = [...sources("app"), ...sources("components")].filter((file) =>
  /<(header|nav|section|aside|main)\b[^>]*>\s*(\{[^}]*\}\s*)*<SiteNav\b/.test(readFileSync(file, "utf8")),
);
is("every <SiteNav /> is drawn outside any other landmark", wrapped, []);

done();
