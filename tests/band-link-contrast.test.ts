/**
 * 274 [AX1], links on the colored bands of a sales page (the owner's coordinator's decision C1-20261106-0100-TODOS-1):
 * a link on a band is black or white, whichever reaches 7:1 on that band (WCAG 1.4.6 at AAA), and always underlined
 * (1.4.1: never told apart by color alone). Checked over every theme and a grid of accent colors a creator may pick:
 * if any band had no black or white at 7:1, the studio would have to warn; the test proves it never happens, because
 * every band already keeps the page's text, which is near black or near white, at 7:1.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, lookColours, lookStyle } from "@/lib/store-look";
import { done, is, part } from "./check";

const THEMES = ["light", "sand", "night", "bold"] as const;
const hex = (n: number) => n.toString(16).padStart(2, "0");
const accents: string[] = [];
for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) accents.push(`#${hex(r)}${hex(g)}${hex(b)}`);

part("A link on a band is black or white at 7:1, for every theme and accent");
const failing: string[] = [];
for (const theme of THEMES) {
  for (const accent of accents) {
    const c = lookColours({ theme, accent });
    const link = (c as { bandLink?: string }).bandLink;
    if (link !== "#000000" && link !== "#ffffff") failing.push(`${theme} ${accent}: ${String(link)}`);
    else if (contrast(link, c.band) < 7) failing.push(`${theme} ${accent}: ${contrast(link, c.band).toFixed(2)}:1`);
  }
}
is(`every one of ${THEMES.length * accents.length} pairs reaches 7:1 with black or white`, failing.slice(0, 5), []);

part("The page carries it, and the band sections use it, underlined");
is("the page's style names the band link color", Object.keys(lookStyle({ theme: "light", accent: "#7c3aed" })).includes("--st-band-link"), true);
const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const rules = [...css.matchAll(/\.sp-style-bands \.sp-band-(phone|computer) > \.sp-section a:not\(\.btn\)[^{]*\{([^}]*)\}/g)];
is("both band layouts (phone and computer) paint their links", rules.map((m) => m[1]).sort(), ["computer", "phone"]);
is("in the band link color, always underlined", rules.every((m) => /color:\s*var\(--st-band-link\)/.test(m[2]) && /text-decoration-line:\s*underline/.test(m[2])), true);
done();
