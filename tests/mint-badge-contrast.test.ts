/**
 * AX274, WCAG 1.4.6 Contrast (Enhanced): words on the light mint badge read at
 * 7:1. Chromium on 13 November 2026: axe's color-contrast-enhanced measured
 * text-mint-deep (#0b6a4d) on bg-mint-soft (#e5f6ef) at 5.89:1. The same pair
 * draws words in studio badges: the funnel's "Yes" (twice), "Paid" on a buyer's
 * path, the ways to pay, a product's offer count on /studio/funnels and a
 * bundle's "N in it" on /studio/bundles. The site keeps --mint-text (#07553e)
 * for exactly this: copy on mint-soft.
 *
 * What must hold: text-mint-text exists (the theme maps it to --mint-text), each
 * of those badges uses it, and --mint-text on --mint-soft is at least 7:1.
 * Badges that hold only an icon keep mint-deep: a graphic needs 3:1 (1.4.11).
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const css = readFileSync("app/globals.css", "utf8");
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? null;
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

part("The mint text colour is a class, at 7:1 on mint");
is("the theme maps text-mint-text to --mint-text", /--color-mint-text:\s*var\(--mint-text\)/.test(css), true);
const t = token("mint-text"), s = token("mint-soft");
is(`--mint-text on --mint-soft is at least 7:1 (now ${t && s ? ratio(t, s).toFixed(2) : "?"})`, t !== null && s !== null && ratio(t, s) >= 7, true);

part("Each badge with words uses it");
for (const [file, near, count] of [
  ["components/funnel-editor.tsx", 'kind === "yes" ? "bg-mint-soft', 2],
  ["components/buyer-path.tsx", ">Paid</span>", 1],
  ["components/payments-panel.tsx", "the 44px floor is for things a thumb presses", 1],
  ["app/studio/funnels/page.tsx", 'count ? "bg-mint-soft', 1],
  ["app/studio/bundles/page.tsx", "in it`}", 1],
] as const) {
  const src = readFileSync(file, "utf8");
  const spots: string[] = [];
  for (let at = src.indexOf(near); at >= 0; at = src.indexOf(near, at + 1)) spots.push(src.slice(Math.max(0, at - 260), at + 260));
  is(`${file}: found ${count} time(s)`, spots.length, count);
  is(`${file}: the words use text-mint-text, not text-mint-deep`, spots.every((x) => /bg-mint-soft[^"`]*text-mint-text|text-mint-text[^"`]*bg-mint-soft/.test(x) && !/bg-mint-soft[^"`]*text-mint-deep/.test(x)), true);
}

done();
