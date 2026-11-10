/**
 * Dark mode, stage 1 (complement WG (a) of 274 [AX1]): the dormant dark tokens of lib/dark-tokens.ts. Each part fails
 * on the wrong behavior it names: a pair under its AAA threshold, a token nobody proved, a CSS block that drifted
 * from the module, a block that applies without the attribute or off the covered pages, an unexpected file that sets
 * the attribute, a link and a button sharing one color, and a contrast formula that is not WCAG's. Stage 2's switch,
 * script and page-by-page proof are held by tests/dark-scheme-switch.test.ts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";
import {
  DARK_BLOCK_END, DARK_BLOCK_START, DARK_PAIRS, DARK_TOKENS, DECORATIVE_TOKENS, ROLE_MINIMUM, type DarkToken, contrastRatio, darkTokensCss,
} from "@/lib/dark-tokens";

const round = (n: number) => Math.round(n * 100) / 100;

part("The contrast formula is WCAG 2.2's");
is("black on white is 21:1, a color on itself 1:1", [round(contrastRatio("#000000", "#ffffff")), round(contrastRatio("#4946a6", "#4946a6"))], [21, 1]);
is("the light palette's own reference pairs (app/globals.css comments): navy on ivory 16.3, muted on ivory 9.42", [contrastRatio("#111827", "#f7f5f0").toFixed(1), round(contrastRatio("#394150", "#f7f5f0"))], ["16.3", 9.42]);
is("order does not matter", contrastRatio("#10151d", "#f4f2ed") === contrastRatio("#f4f2ed", "#10151d"), true);
let threw = false;
try { contrastRatio("#fff", "#000000"); } catch { threw = true; }
is("only #rrggbb is read; anything else is refused, never guessed", threw, true);

part("Every pair meets the AAA threshold of its role");
is("thresholds: 7:1 text, 4.5:1 large text, 3:1 interface parts", ROLE_MINIMUM, { text: 7, "large-text": 4.5, ui: 3 });
const failing = DARK_PAIRS.filter((p) => contrastRatio(DARK_TOKENS[p.fg], DARK_TOKENS[p.bg]) < ROLE_MINIMUM[p.role])
  .map((p) => `${p.fg} on ${p.bg} (${p.role}): ${round(contrastRatio(DARK_TOKENS[p.fg], DARK_TOKENS[p.bg]))}`);
is("no pair under its threshold", failing, []);
const weakest = (role: "text" | "large-text" | "ui") => round(Math.min(...DARK_PAIRS.filter((p) => p.role === role).map((p) => contrastRatio(DARK_TOKENS[p.fg], DARK_TOKENS[p.bg]))));
is("the weakest pair of each role, recorded so a change is seen", [weakest("text"), weakest("large-text"), weakest("ui")], [8.02, 5.77, 4.24]);
is("each role is checked at least once", (["text", "large-text", "ui"] as const).map((r) => DARK_PAIRS.some((p) => p.role === r)), [true, true, true]);
is("text on every surface it can sit on: ink, ink-soft, ink-mute and link on the five surfaces", (["ink", "ink-soft", "ink-mute", "link"] as const)
  .map((fg) => DARK_PAIRS.filter((p) => p.fg === fg && p.role === "text").length), [5, 5, 5, 5]);

part("No token goes unproved");
const used = new Set<DarkToken>(DARK_PAIRS.flatMap((p) => [p.fg, p.bg]));
const unproved = (Object.keys(DARK_TOKENS) as DarkToken[]).filter((t) => !used.has(t) && !DECORATIVE_TOKENS.includes(t));
is("every token is in a pair, or listed as decorative", unproved, []);
is("only the two separator lines are decorative", DECORATIVE_TOKENS, ["line", "line-strong"]);
is("every value is #rrggbb", Object.values(DARK_TOKENS).every((v) => /^#[0-9a-f]{6}$/.test(v)), true);

part("A button and a link no longer share one color");
is("the roles are separate tokens", ["action-bg", "action-on", "action-border", "link", "focus-ring"].every((t) => t in DARK_TOKENS), true);
is("a link is only ever text; a button's fill is a background for its label and an interface part, never text", [
  DARK_PAIRS.filter((p) => p.fg === "link").every((p) => p.role === "text"),
  DARK_PAIRS.some((p) => p.bg === "link"),
  DARK_PAIRS.some((p) => p.fg === "action-bg" && p.role === "text"),
], [true, false, false]);
is("the button's label reads on the button at 7:1", contrastRatio(DARK_TOKENS["action-on"], DARK_TOKENS["action-bg"]) >= 7, true);

part("app/globals.css carries the block exactly, and only under the attribute");
const css = readFileSync("app/globals.css", "utf8").replace(/\r\n/g, "\n");
is("the block is there, byte for byte as the module makes it", css.includes(darkTokensCss()), true);
is("once", css.split(DARK_BLOCK_START).length - 1, 1);
const block = css.slice(css.indexOf(DARK_BLOCK_START), css.indexOf(DARK_BLOCK_END));
const selectors = [...block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
is("its tokens apply only under the attribute, on a covered page", selectors[0], ':root[data-color-scheme="dark"]:has(.legal-body)');
is("every other rule in it too", selectors.slice(1).filter((s) => !s.startsWith(':where(:root[data-color-scheme="dark"]:has(.legal-body)) ')), []);
is("no prefers-color-scheme rule anywhere: the device's setting counts only when the reader chose \"Match my device\"", /prefers-color-scheme/.test(css), false);

const sources: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|mjs|js)$/.test(name)) sources.push(p);
  }
};
["app", "components", "lib"].forEach(walk);
const setters = sources.map((p) => p.replace(/\\/g, "/")).filter((p) => p !== "lib/dark-tokens.ts" && /data-color-scheme|colorScheme\s*=\s*["']dark|dataset\.colorScheme/.test(readFileSync(p, "utf8")));
is("only the script and the switch set the attribute (stage 2); the layout only names it", setters.sort(), ["app/layout.tsx", "components/color-scheme-switch.tsx", "lib/color-scheme.ts"]);

done();
