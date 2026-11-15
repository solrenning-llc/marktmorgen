/**
 * Example text inside a creator's input is never faded below 7:1 (WCAG 1.4.6 Contrast (Enhanced), AAA; #4597,
 * Claude 6). The product editor's price boxes and "None" boxes and the store-address rename box used
 * `placeholder:text-ink-soft/50`, #343d4a at half opacity on white: 2.69:1, under even 1.4.3's 4.5:1. They now use
 * `placeholder:text-ink-mute` at full opacity (#394150, 10.26:1 on white), as the open PR for the handle form does.
 * Read in the sources: no `placeholder:text-*` utility with an opacity modifier is left in these files.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const FADED = /placeholder:text-[a-z-]+\/\d+/g;
/** WCAG relative luminance and contrast, the W3C formula. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

part("No faded placeholder in the product editor or the rename box");
for (const file of ["components/product-editor.tsx", "components/rename-form.tsx"]) {
  const source = readFileSync(file, "utf8");
  is(`${file}: no placeholder with an opacity modifier`, source.match(FADED) ?? [], []);
}
const editor = readFileSync("components/product-editor.tsx", "utf8");
is("the editor's four boxes (price, suggested price, two \"None\") use the full ink-mute", (editor.match(/placeholder:text-ink-mute\b/g) ?? []).length >= 4, true);

part("The colour they use is at least 7:1 on the white card");
const css = readFileSync("app/globals.css", "utf8");
const mute = /--ink-mute:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1] ?? "";
is(`--ink-mute (${mute}) on #ffffff is at least 7:1`, contrast(mute, "#ffffff") >= 7, true);

done();
