/**
 * A box made focusable so the keyboard can scroll it (`tabIndex={0}`: a wide table's region, a long text, a numbers
 * section; about fifty in the site and studio) showed only the browser's own focus ring: the site's 3 px ring
 * (app/globals.css) named only links, buttons and form fields. Under AX274 (WCAG 2.4.7, and 2.4.13 Focus
 * Appearance at AAA) every keyboard stop gets the site's ring, so the rule now names `[tabindex="0"]` too. It is
 * inside `:where()`, with no specificity, so a box with a ring of its own keeps it. Found reviewing #4641.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio } from "@/lib/dark-tokens";
import { done, is, part } from "./check";

const css = readFileSync("app/globals.css", "utf8");
const rule = /:where\(([^)]*)\):focus-visible,\s*:where\(input\[type="radio"\]\):focus \{\s*outline: 3px solid var\(--focus\);/.exec(css);

part("The site's focus ring");
is("is found", Boolean(rule), true);
const named = (rule?.[1] ?? "").split(",").map((s) => s.trim());
is("names a focusable box as well as the controls", ["a", "button", "input", "select", "textarea", "summary", '[tabindex="0"]'].filter((s) => !named.includes(s)), []);
const focus = /--focus:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1] ?? "";
is("and its color stands out 3:1 against the page (2.4.13)", focus !== "" && contrastRatio(focus, "#f7f5f0") >= 3 && contrastRatio(focus, "#ffffff") >= 3, true);

part("The boxes it reaches");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []));
const boxes = [...files("components"), ...files("app")].reduce((n, f) => n + (readFileSync(f, "utf8").match(/tabIndex=\{0\}/g)?.length ?? 0), 0);
is("there are such boxes in the site and studio", boxes >= 10, true);

done();
