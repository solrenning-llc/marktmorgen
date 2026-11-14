/**
 * AX274, WCAG 1.4.6 Contrast (Enhanced): the amber status tag, "Waiting",
 * "Waiting for you", "Uncertain", "Cannot be reached", "Not built yet", reads at
 * 7:1. Chromium on 13 November 2026: axe's color-contrast-enhanced measured it at
 * 5.96:1 (#8a4f00 on #fdf3e1, 12.48 px) on the public feature pages, and the same
 * class draws real status tags in the studio's team, Discord, workflow, course
 * work and affiliates screens. The home page had already worked round it with an
 * inline ink colour.
 *
 * What must hold: .tag-next's text uses --amber-text, a darker amber kept for
 * copy (as --mint-text and --danger-text are), at 7:1 or more on --amber-soft;
 * --amber itself, used for borders and accents, is unchanged.
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
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

part("The amber status tag reads at 7:1");
const text = token("amber-text");
const soft = token("amber-soft");
is("--amber-text is defined", text !== null, true);
is(".tag-next's text uses it", /color:\s*var\(--amber-text\)/.test(rule(".tag-next")), true);
is(".tag-next keeps its amber background", /background:\s*var\(--amber-soft\)/.test(rule(".tag-next")), true);
is(`--amber-text on --amber-soft is at least 7:1 (now ${text && soft ? ratio(text, soft).toFixed(2) : "?"})`, text !== null && soft !== null && ratio(text, soft) >= 7, true);
is("--amber itself is unchanged", token("amber"), "#8a4f00");

done();
