/**
 * AX274 Part A / 310 [AX2] (WCAG 1.4.10 Reflow, 1.4.12 Text Spacing), found in the measured browser sweep outside
 * the studio (Claude 4 cloud AA, 15 November 2026): /platform's "Where a $27 sale goes" picture
 * (components/feature-visuals.tsx, StripeVisual) laid its steps in a `grid` with no column size. An implicit grid
 * column is as wide as its widest item's min-content, and a truncated line (`white-space: nowrap`) has the whole
 * line as its min-content. So at 320 px the column grew to 301 px inside a window that clips (`overflow-hidden`):
 * "$27.00" and "On the payout schedule you set at Stripe" were cut off by 16 to 35 px, and by up to 106 px with
 * 1.4.12's spacing.
 *
 * The column is now `grid-cols-1` (minmax(0, 1fr): no wider than the window), and the two steps' lines wrap instead
 * of being cut, so every word of the picture stays in view.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const source = readFileSync("components/feature-visuals.tsx", "utf8");
const start = source.indexOf("function StripeVisual()");
const body = source.slice(start, source.indexOf("\nfunction ", start + 10));

part("1.4.10: the money picture on /platform fits a 320 px screen");
is("StripeVisual is found", start > 0, true);
const grid = /<div className="(grid\b[^"]*)">/.exec(body)?.[1] ?? "";
is("its steps' grid has a column no wider than the window (grid-cols-1)", /(?<![\w-])grid-cols-1\b/.test(grid), true);
const rows = [...body.matchAll(/<Row\b[^>]*\/>/g)].map((row) => row[0]);
is("it draws two steps as rows", rows.length, 2);
is("each step's lines wrap instead of being cut", rows.every((row) => /\bwrap\b/.test(row)), true);

done();
