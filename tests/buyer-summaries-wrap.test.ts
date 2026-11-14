/**
 * AX274, WCAG 1.4.10 Reflow and 1.4.12 Text Spacing, on the buyer's side: a
 * product's one-line summary under its name is read whole. Chromium on
 * 13 November 2026, a product page of the synthetic store at 320 px, at 1280 px,
 * at 400% zoom and with the 1.4.12 spacing: the "More from" list cut each other
 * product's summary with an ellipsis ("Two hours on the weekend for four easier
 * weeknight dinners: …"), and a collection on the store page draws its products
 * the same way. The summary is the creator's own words and is not given whole
 * anywhere else on that page.
 *
 * What must hold: the summary wraps (break-words) instead of being cut; the
 * creator's words, the link and the price are unchanged.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("A product's summary in a list wraps, never cut");
for (const file of ["components/more-from.tsx", "components/store-collections.tsx"]) {
  const source = readFileSync(file, "utf8");
  const at = source.indexOf("{product.summary}</span>");
  const open = source.lastIndexOf("<span", at);
  const classes = (source.slice(open, at).match(/className="([^"]*)"/)?.[1] ?? "").split(/\s+/);
  is(`${file}: the summary is found`, classes.length > 1, true);
  is(`${file}: it wraps instead of ending in an ellipsis`, !classes.includes("truncate") && classes.includes("break-words"), true);
}

done();
