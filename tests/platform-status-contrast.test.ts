/**
 * Small status text in the product illustrations of the /platform pages read at 5.1:1 to 6.6:1, under the 7:1
 * of WCAG 2.2 AAA 1.4.6 (#4649): mint-deep on white and on mint-soft, danger on danger-soft, amber on amber-soft
 * (.tag-next, "Coming to Studio" and "Waiting"), and white at 80% opacity on violet. Each now uses the text token
 * of its color (mint-text, danger-text, the new amber-text) or full white. This reads the class each place uses
 * from the source, takes the light value of its token from app/globals.css and holds the pair to 7:1.
 */
import { readFileSync } from "node:fs";
import { contrastRatio } from "@/lib/dark-tokens";
import { done, is, part } from "./check";

const css = readFileSync("app/globals.css", "utf8");
const visuals = readFileSync("components/feature-visuals.tsx", "utf8");
const light = css.slice(0, css.indexOf("/* 274 [AX1] dark mode"));
const token = (name: string): string => {
  const hit = light.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!hit) throw new Error(`no light value for --${name}`);
  return hit[1];
};
/** The token a text class draws in. */
const fgOf = (cls: string): string => {
  const named = cls.match(/^text-\[var\(--([a-z-]+)\)\]$/) ?? cls.match(/^text-([a-z-]+)$/);
  if (!named) throw new Error(`not a text color class: ${cls}`);
  return token(named[1]);
};
const ratio = (fg: string, bg: string) => Math.round(contrastRatio(fg, bg) * 100) / 100;
const pick = (pattern: RegExp, at = 1): string => {
  const hit = visuals.match(pattern);
  if (!hit) throw new Error(`not found: ${pattern}`);
  return hit[at];
};

const pickCss = (pattern: RegExp): string => {
  const hit = css.match(pattern);
  if (!hit) throw new Error(`not found: ${pattern}`);
  return hit[1];
};

part("Each status text, at its own color, is 7:1 or more");
const pairs: [string, string, string][] = [
  ["webhooks: \"Delivered (200)\" on white", fgOf(pick(/\$\{d\.ok \? "([^"]+)" : "text-ink-soft"\}/)), "#ffffff"],
  ["ways to pay: a paid/method pill on mint-soft", fgOf(pick(/rounded-full bg-mint-soft px-2\.5 py-0\.5 text-\[12px\] font-semibold (\S+?)">/)), token("mint-soft")],
  ["moving in: \"added to your list\" on mint-soft", fgOf(pick(/o === "added" \? "(text-[^"]+)"/)), token("mint-soft")],
  ["moving in: \"could not be read\" on danger-soft", fgOf(pick(/o === "error" \? "(text-[^"]+)"/)), token("danger-soft")],
  ["import done: the added tile on mint-soft", fgOf(pick(/tone: "bg-mint-soft", text: "([^"]+)"/)), token("mint-soft")],
  ["import done: the errors tile on danger-soft", fgOf(pick(/text: counts\.errors \? "([^"]+)"/)), token("danger-soft")],
  [".tag-next: \"Coming to Studio\", \"Waiting\"", token(pickCss(/\.tag-next \{\s*background: var\(--amber-soft\);\s*color: var\(--([a-z-]+)\);/)), token("amber-soft")],
];
is("below 7:1", pairs.filter(([, fg, bg]) => ratio(fg, bg) < 7).map(([what, fg, bg]) => `${what}: ${ratio(fg, bg)}`), []);

part("The open count on the violet pipeline button is full white");
const open = visuals.match(/<span className="([^"]*)">\{` · \$\{open\.length\} open`\}<\/span>/);
is("no opacity on it", open ? /opacity-/.test(open[1]) : "missing", false);
is("white on violet", ratio("#ffffff", token("violet")) >= 7, true);

done();
