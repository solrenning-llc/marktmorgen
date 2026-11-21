/**
 * WCAG 2.2 1.4.10 Reflow and 1.4.12 Text Spacing (274 [AX1]): the studio's
 * numbers per product show each product's whole title.
 *
 * Found by Claude 3 (cloud D)'s AAA audit of main @7b04206e7 (11 November
 * 2026, production build, Chromium): the first cell of each row of the table
 * "per product" (components/stats-panel.tsx) was cut to an ellipsis at 7rem
 * (`truncate`). With WCAG's text spacing a title as short as "Weekend Batch
 * Cooking Plan" lost its end, and on a phone most titles did: the row's
 * numbers then belonged to a product the creator could not name. The table
 * already scrolls sideways inside its own focusable region, so nothing needs
 * cutting: the title wraps, with a minimum width so its column is never
 * squeezed to a letter a line.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const panel = readFileSync("components/stats-panel.tsx", "utf8");
/** The class of the cell that holds each product's title in the table per product. */
const cell = /<td className="([^"]*)">\s*\{index < 3 && product\.cents !== null/.exec(panel)?.[1] ?? null;
const classes = new Set((cell ?? "").split(/\s+/));

part("The numbers per product name every product in full (WCAG 1.4.10, 1.4.12)");
is("the table's first cell holds the product's title", cell !== null, true);
is("the title is never cut to an ellipsis", ["truncate", "text-ellipsis", "whitespace-nowrap", "overflow-hidden"].some((c) => classes.has(c)), false);
is("a long word in the title breaks where it must, so the whole title shows", classes.has("[overflow-wrap:anywhere]"), true);
is("the column keeps a readable width while it wraps", [...classes].some((c) => /^min-w-\[\d+(\.\d+)?rem\]$/.test(c)), true);

done();
