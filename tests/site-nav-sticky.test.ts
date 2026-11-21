/**
 * The MEDIUM on #3997 (Claude 1 cloud, Claude 2 cloud I, Claude 3 cloud E, Claude 2 L; 12-13/11/2026): wrapping
 * <SiteNav /> in a page's own <header> (app/help/buyers/page.tsx, app/not-found.tsx, and already app/library/page.tsx)
 * stopped the site menu from staying on screen. The menu is `sticky top-0`, and a sticky box only sticks inside its
 * parent: inside a <header> as tall as the preview bar plus the menu, it scrolled away with it (measured in Chromium:
 * the menu's top at -1444 px after a 1,500 px scroll, 0 without the wrapper). The wrapper was there so the preview bar
 * sits in a landmark (axe "region"). Now SiteNav gives the landmarks itself: the preview bar is a named region and the
 * sticky menu is the <header>, a direct child of the page's own column, so it sticks for the whole page.
 * tests/e2e/site-nav-sticky.mjs scrolls the real markup in a browser; tests/e2e/accessibility-buyer-actions.mjs does it
 * on the built pages.
 *
 * Also the two LOWs: the preview bar's line spacing is at least 1.5 (WCAG 1.4.8, AAA), not leading-snug (1.375).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BuyerHelpPage from "@/app/help/buyers/page";
import NotFound from "@/app/not-found";
import { done, is, part } from "./check";

/** The tags between the page's column and the sticky menu: none when the menu is the column's own child. */
function wrappersOfSticky(html: string): string[] | null {
  const sticky = html.search(/<[a-z]+ class="sticky top-0 z-50"/);
  if (sticky < 0) return null;
  const column = html.indexOf('<div class="flex min-h-screen flex-col');
  const between = html.slice(html.indexOf(">", column) + 1, sticky);
  // Tags opened and not closed between the column and the menu.
  const open: string[] = [];
  for (const tag of between.matchAll(/<(\/?)([a-z]+)[^>]*?(\/?)>/g)) {
    if (tag[3] === "/" || ["br", "img", "input", "meta", "link"].includes(tag[2])) continue;
    if (tag[1] === "/") open.pop();
    else open.push(tag[2]);
  }
  return open;
}

for (const [name, page] of [["the help for buyers", BuyerHelpPage], ["the site's own not-found page", NotFound]] as const) {
  part(name);
  const html = renderToStaticMarkup(createElement(page as () => React.ReactElement));
  is("the sticky menu is the page column's own child, never inside a wrapper", wrappersOfSticky(html), []);
  is("and it is the page's banner (a <header>)", /<header class="sticky top-0 z-50"/.test(html), true);
  is("the preview bar is in a landmark of its own, named", /<section aria-label="[^"]+" class="bg-ink text-white" data-preview-bar="">/.test(html), true);
  is("only one banner", (html.match(/<header[ >]/g) ?? []).length, 1);
}

part("The library page keeps no wrapper either");
const library = readFileSync("app/library/page.tsx", "utf8");
is("no <header> around <SiteNav />", /<header>\s*<SiteNav/.test(library), false);

part("The preview bar's line spacing (1.4.8)");
const nav = readFileSync("components/site-nav.tsx", "utf8");
const bar = nav.slice(nav.indexOf("data-preview-bar"), nav.indexOf("{PREVIEW_LINE}"));
is("never leading-snug (1.375) or tighter", /leading-(snug|tight|none)/.test(bar), false);
is("1.5 or more", /leading-(normal|relaxed|loose)/.test(bar), true);
done();
