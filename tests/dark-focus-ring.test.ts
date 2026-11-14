/**
 * MEDIUM of the reviews at de8c262ae7 (#3557) and be153df039 (#3561): in dark mode the keyboard focus ring stayed the
 * light indigo. Every focusable control draws its ring from the global rule `outline: 3px solid var(--focus)`; the
 * dark block set --focus-ring (#c3c1f7, proved at 3:1) but never --focus, which stayed #4946a6 (light). Reads the
 * real app/globals.css: the ring rule, and what --focus resolves to inside the dark block, held to 3:1 (1.4.11) on
 * every dark background, with the room 2.4.13 asks for.
 */
import { readFileSync } from "node:fs";
import { DARK_BLOCK_END, DARK_BLOCK_START, DARK_TOKENS, contrastRatio } from "@/lib/dark-tokens";
import { done, is, part } from "./check";

const css = readFileSync("app/globals.css", "utf8").replace(/\r\n/g, "\n");
const block = css.slice(css.indexOf(DARK_BLOCK_START), css.indexOf(DARK_BLOCK_END));
const declared = new Map([...block.matchAll(/^ {2}--([a-z-]+): ([^;]+);$/gm)].map((m) => [m[1], m[2].trim()]));
/** What a custom property is inside the dark block: its own value, a var() followed, or the light value outside. */
function darkValue(name: string, depth = 0): string | null {
  if (depth > 5) return null;
  const v = declared.get(name);
  if (v === undefined) return [...css.matchAll(new RegExp(`^ {2}--${name}: (#[0-9a-f]{6});$`, "gm"))][0]?.[1] ?? null;
  const ref = /^var\(--([a-z-]+)\)$/.exec(v);
  return ref ? darkValue(ref[1], depth + 1) : v;
}

part("The ring every control draws reads --focus");
is("the global ring rule is outline: 3px solid var(--focus)", /outline: 3px solid var\(--focus\)/.test(css), true);

part("In dark, --focus is the proved dark ring, at 3:1 or more on every dark background");
const ring = darkValue("focus");
is("--focus is the dark ring color", ring, DARK_TOKENS["focus-ring"]);
for (const bg of ["paper", "sand", "sand-deep", "lilac", "lilac-deep"] as const) {
  const hex = DARK_TOKENS[bg as keyof typeof DARK_TOKENS];
  is(`on --${bg} it is 3:1 or more`, ring !== null && /^#[0-9a-f]{6}$/.test(ring) && contrastRatio(ring, hex) >= 3, true);
}
done();
