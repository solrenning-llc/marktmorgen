/**
 * WCAG 2.2 1.4.10 Reflow (274 [AX1]): /studio/outreach fits a 320 px wide
 * screen without scrolling sideways.
 *
 * Found by Claude 3 (cloud D)'s AAA audit of main @7b04206e7 (11 November
 * 2026, production build, Chromium at 320 px): the page was 339 px wide. The
 * empty list's sentence carries the store's address ("Each one ends with your
 * name, https://marktmorgen.com/@… and your postal address"), a long word that
 * does not break, and the cards are grid items, whose minimum width is their
 * longest word: every card of the grid grew past the screen with it.
 *
 * The grid's cards may never be wider than its column, and a long word in
 * them breaks where it must, so an address of any length fits.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutreachStudio } from "@/components/outreach-studio";
import { done, is, part } from "./check";

const storeUrl = "https://marktmorgen.com/@a-store-with-a-very-long-handle-0123456789";
const html = renderToStaticMarkup(
  createElement(OutreachStudio, { sender: { name: "", address: "" }, pitches: [], left: 5, on: true, storeUrl }),
);

/** The class of the element that holds the page's cards (the grid). */
const gridClass = (/<div class="([^"]*\bgrid\b[^"]*)"><section class="card/.exec(html)?.[1] ?? "").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

part("The outreach studio's cards fit a 320 px screen (WCAG 1.4.10)");
is("the page draws its cards in a grid, with the store's address in the empty list's sentence", [gridClass !== "", html.includes(storeUrl)], [true, true]);
is("no card of the grid is wider than its column: each of its children may shrink below its longest word", /(^|\s)\[&>\*\]:min-w-0(\s|$)/.test(gridClass), true);
is("a word longer than the column, such as the store's address, breaks where it must", /(^|\s)\[overflow-wrap:anywhere\](\s|$)/.test(gridClass), true);

done();
