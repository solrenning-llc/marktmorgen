/**
 * 274 [AX1], WCAG 1.4.6 (AAA): the creator's colour as small text (accentText) is painted on the wash behind a picked or
 * highlighted thing (accentSoft: the buyer's own bubble in the store chat and the Store assistant, .sp-tick, .cm-pill-on,
 * .st-link-icon) and on a band (the Colour theme's band, a sales page's coloured sections). Both are derived from the
 * creator's choice, never the choice itself, so the derivation keeps 7:1 for every theme and every accent a creator may
 * pick. The review of #2907 measured 5.74 to 6.06:1 on accentSoft (the default violet on Light, 5.96:1) and a band that
 * only asked 4.5:1. Also guarded here: the open cart's Close and Remove keep a 44 x 44 px target (2.5.5 AAA).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCENTS, DEFAULT_LOOK, THEMES, contrast, lookColours } from "@/lib/store-look";
import { done, is, part } from "./check";

const hex = (n: number) => n.toString(16).padStart(2, "0");
const accents = new Set<string>([...ACCENTS.map((a) => a.hex), DEFAULT_LOOK.accent, "#5a36ee", "#ffff00", "#00ffff", "#ff00ff", "#00ff88", "#7f7f7f"]);
for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) accents.add(`#${hex(r)}${hex(g)}${hex(b)}`);

part("The creator's colour as text keeps 7:1 on every surface derived from it");
const soft: string[] = [];
const band: string[] = [];
let worstSoft = 99;
let worstBand = 99;
for (const theme of THEMES) {
  for (const accent of accents) {
    const c = lookColours({ theme: theme.id, accent });
    const s = contrast(c.accentText, c.accentSoft);
    const b = contrast(c.accentText, c.band);
    worstSoft = Math.min(worstSoft, s);
    worstBand = Math.min(worstBand, b);
    if (s < 7) soft.push(`${theme.id} ${accent}: ${c.accentText} on ${c.accentSoft} ${s.toFixed(2)}:1`);
    if (b < 7) band.push(`${theme.id} ${accent}: ${c.accentText} on ${c.band} ${b.toFixed(2)}:1`);
  }
}
const pairs = THEMES.length * accents.size;
is(`accentText on accentSoft reaches 7:1 for all ${pairs} pairs (worst ${worstSoft.toFixed(2)}:1)`, soft.slice(0, 5), []);
is(`accentText on a band reaches 7:1 for all ${pairs} pairs (worst ${worstBand.toFixed(2)}:1)`, band.slice(0, 5), []);

part("The default violet, on light and dark themes");
for (const theme of THEMES) {
  const c = lookColours({ theme: theme.id, accent: DEFAULT_LOOK.accent });
  is(`${theme.id}: the buyer's chat bubble (accentText on accentSoft) at 7:1`, contrast(c.accentText, c.accentSoft) >= 7, true);
}

part("The derivation never repaints the creator's choice, and the page's own words still read on the wash");
for (const theme of THEMES) {
  const c = lookColours({ theme: theme.id, accent: DEFAULT_LOOK.accent });
  is(`${theme.id}: text and muted on accentSoft stay at 7:1`, contrast(c.text, c.accentSoft) >= 7 && contrast(c.muted, c.accentSoft) >= 7, true);
  is(`${theme.id}: text and muted on a band stay at 7:1`, contrast(c.text, c.band) >= 7 && contrast(c.muted, c.band) >= 7, true);
}

part("The open cart's Close and Remove are 44 x 44 px targets (2.5.5)");
const cart = readFileSync(join(process.cwd(), "components/store-cart.tsx"), "utf8");
const buttons = [...cart.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
const remove = buttons.find((b) => b.includes("data-remove"));
const close = buttons.find((b) => /setOpen\(false\);\s*opener\.current\?\.focus\(\)/.test(b));
const big = (b: string | undefined) => Boolean(b && /\b(min-)?h-11\b/.test(b) && /\b(min-)?w-11\b/.test(b));
is("Remove is at least 44 x 44 px", big(remove), true);
is("Close is at least 44 x 44 px", big(close), true);
is("no 36 px (h-9 / w-9) button is left in the cart", buttons.filter((b) => /\b[hw]-9\b/.test(b)).length, 0);
done();
