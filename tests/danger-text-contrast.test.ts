/**
 * WCAG 1.4.6 (7:1 for text, AAA; AX274 Part A item 4) on the site's red for
 * error words: `.field-error` and the `text-danger` utility (with
 * `hover:text-danger`), read from the real stylesheet built by Tailwind from
 * app/globals.css. They drew `--danger` (#c2261f), 5.85:1 on white and less on
 * ivory, sand and the tinted notes; they now draw `--danger-text` (#8e211b),
 * the shade the site already uses for error copy. The classes keep their
 * names, so no component changes. `--danger` itself stays for fills, borders
 * and dots, which need 3:1 (1.4.11).
 *
 * Checked on every light surface error words are drawn on: white, ivory,
 * sand, lilac, the mint, amber and danger notes, and the light store themes'
 * page, card and item. The Night store theme has its own red (`.cm-danger`
 * #ff8a80), checked at 7:1 on its page, card and item too.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { THEMES, lookColours } from "@/lib/store-look";
import { done, is, part } from "./check";

const hex = (value: string) => value.trim().toLowerCase();
function luminance(color: string): number {
  const v = hex(color).replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

async function main(): Promise<void> {
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const source = readFileSync("app/globals.css", "utf8");
  const compiler = await compile(source, { base: process.cwd(), onDependency() {} });
  const css = compiler.build(["text-danger", "hover:text-danger", "field-error"]);
  const token = (name: string): string => {
    const found = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
    if (!found) throw new Error(`no --${name} in the built stylesheet`);
    const value = found[1].trim();
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    return ref ? token(ref[1]) : value;
  };
  const colorOf = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, (c) => `\\${c}`);
    const rule = new RegExp(`${escaped}\\s*\\{[^}]*?color:\\s*([^;}]+)`).exec(css);
    if (!rule) throw new Error(`no color for ${selector}`);
    const value = rule[1].trim();
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    return hex(ref ? token(ref[1]) : value);
  };

  const surfaces: Record<string, string> = {
    white: "#ffffff",
    ivory: token("paper"),
    sand: token("sand"),
    lilac: token("lilac"),
    "mint note": token("mint-soft"),
    "amber note": token("amber-soft"),
    "danger note": token("danger-soft"),
  };
  const palettes = THEMES.map((theme) => [theme.id, lookColours({ theme: theme.id, accent: "#5a36ee" })] as const);
  for (const [id, palette] of palettes) {
    if (palette.dark) continue;
    surfaces[`${id} store page`] = palette.bg;
    surfaces[`${id} store card`] = palette.card;
    surfaces[`${id} store item`] = palette.item;
  }

  part("Error words keep 7:1 on every light surface");
  const fieldError = colorOf(".field-error");
  const textDanger = colorOf(".text-danger");
  for (const [name, color] of [["`.field-error`", fieldError], ["`text-danger`", textDanger]] as const) {
    const low = Object.entries(surfaces).filter(([, bg]) => ratio(color, bg) < 7).map(([where, bg]) => `${where} ${ratio(color, bg)}:1`);
    is(`${name} (${color}) is 7:1 or more on every light surface`, low, []);
  }
  is("`hover:text-danger` draws the same red as `text-danger`", colorOf(".hover\\:text-danger:hover"), textDanger);
  is("`--danger` itself stays for fills, borders and dots", token("danger"), "#c2261f");

  part("The Night store theme's own red keeps 7:1");
  const night = /\.st-theme-night \.cm-danger\s*\{\s*color:\s*([^;]+);/.exec(source)?.[1].trim() ?? "";
  const dark = palettes.find(([, p]) => p.dark)![1];
  is("`.cm-danger` on Night's page, card and item", [dark.bg, dark.card, dark.item].map((bg) => ratio(night, bg) >= 7), [true, true, true]);
  done();
}

void main();
