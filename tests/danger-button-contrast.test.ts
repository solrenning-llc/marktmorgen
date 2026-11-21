// WCAG 1.4.6 Contrast (Enhanced), AAA (274 [AX1]): the solid red button that deletes (`.btn-danger-solid`) keeps
// at least 7:1 between its white words and its red, at rest and under the pointer. Found walking the buyer path
// (Claude 1, 12/11/2026): "Delete my data from <store>" on /privacy/delete, the last step of a buyer deleting what a
// store keeps about them, was white on --danger (#c2261f), 5.85:1 (axe color-contrast-enhanced). The same class is
// the delete button in the studio (components/person-erase.tsx, product-editor.tsx, link-editor.tsx and others).
// Reads the real app/globals.css; the colours are its own tokens.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
function token(name: string): string {
  const value = css.match(new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})"))?.[1];
  if (!value) throw Error("Missing colour token " + name);
  return value;
}
/** A colour as a rule writes it: a hex, `#fff`, or `var(--token)`. */
function colour(value: string): string {
  const v = value.trim();
  const named = v.match(/^var\(--([a-z0-9-]+)\)$/)?.[1];
  if (named) return token(named);
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("");
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  throw Error("Unreadable colour " + v);
}
function luminance(hex: string): number {
  const values = (hex.slice(1).match(/../g) ?? []).map((value) => parseInt(value, 16) / 255).map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
  const body = css.match(new RegExp("(?:^|\\n)" + escaped + "\\s*\\{([^}]+)\\}"))?.[1];
  if (!body) throw Error("Missing rule " + selector);
  return Object.fromEntries(body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));
}

part("The solid delete button keeps 7:1 (1.4.6), at rest and under the pointer");
const rest = rule(".btn-danger-solid");
const hover = rule(".btn-danger-solid:hover");
const words = colour(rest.color);
const atRest = contrast(words, colour(rest["background-color"]));
const underPointer = contrast(hover.color ? colour(hover.color) : words, colour(hover["background-color"]));
is(`at rest, its words on its red reach 7:1 (${atRest.toFixed(2)})`, atRest >= 7, true);
is(`under the pointer, too (${underPointer.toFixed(2)})`, underPointer >= 7, true);
is("the red used for error words and borders is unchanged", token("danger"), "#c2261f");
done();
