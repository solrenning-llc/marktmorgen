/**
 * WCAG 2.2 1.4.8 Visual Presentation, AAA (#4653, Claude 2 cloud T; AX274 Part A item 4): lines of at most 80
 * characters and line spacing of at least 1.5. On the /platform pages the questions' answers ran about 125-132
 * characters a line and the feature lists about 120, and every `text-sm` paragraph of the site kept Tailwind's
 * default line height of 1.43. The topic page now caps both at 72ch (`ch` follows the font and the text size), and
 * the theme sets `text-sm`'s line height to 1.5. /pricing has its own cap (tests/pricing-line-length.test.ts).
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const topic = readFileSync("components/topic-page.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");
const capOf = (className: string): number | null => {
  const m = /max-w-\[(\d+(?:\.\d+)?)ch\]/.exec(className);
  return m ? Number(m[1]) : null;
};

part("The /platform pages' long text is held to 80 characters or fewer");
const feature = /<li key=\{item\} className="([^"]*text-\[0\.9375rem\][^"]*)"/.exec(topic)?.[1] ?? "";
const answer = /<p className="([^"]*px-5 pb-5 text-\[0\.9375rem\][^"]*)">\{item\.a\}<\/p>/.exec(topic)?.[1] ?? "";
is("the feature list's items are capped at 80ch or less", (capOf(feature) ?? 999) <= 80, true);
is("the questions' answers are capped at 80ch or less", (capOf(answer) ?? 999) <= 80, true);

part("Small text has a line height of at least 1.5");
const themes = [...css.matchAll(/@theme(?:\s+inline)?\s*\{([^}]*)\}/g)].map((m) => m[1]).join("\n");
const sm = /--text-sm--line-height:\s*([0-9.]+)\s*;/.exec(themes)?.[1];
is("a theme block sets --text-sm--line-height to 1.5 or more", sm !== undefined && Number(sm) >= 1.5, true);

done();
