/**
 * The site's keyboard ring reaches every element made focusable with tabindex.
 *
 * A table or a long list that scrolls sideways gets tabindex="0" so a keyboard
 * can scroll it (WCAG 2.1.1). There are more than forty of them, most of them
 * role="region" with a name. The global ring in app/globals.css listed links,
 * buttons, fields and summaries only, so a scroll region fell back to the
 * browser's own outline: thin, in the browser's color, and not measured
 * against WCAG 2.2 2.4.13 Focus Appearance (AAA, required by AX274).
 *
 * The fix is once, where the ring is defined, not in forty places. These
 * tests read the stylesheet and hold that:
 *  - the ring's selector covers [tabindex] (not -1) and named regions, with
 *    the same width, color and offset as the ring on links and buttons;
 *  - nothing in the stylesheet takes that ring away from them, including in
 *    forced colors (where the browser keeps a solid outline in a system color);
 *  - every element in app/ and components/ with tabindex="0" leaves the
 *    outline alone (no outline-none, no class whose :focus zeroes it without
 *    drawing its own ring on :focus-visible).
 *
 * What these tests do not do: draw anything. Contrast of --focus is held by
 * the contrast tests; the ring on real pages in a real browser is not
 * measured here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Rule = { selector: string; body: string; at: string[] };

/** Every style rule in the sheet, with the @-blocks it sits in. */
function rulesOf(source: string): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      const head = css.slice(start, i).trim();
      if (head.startsWith("@")) {
        stack.push(head);
        start = i + 1;
        continue;
      }
      const end = css.indexOf("}", i);
      rules.push({ selector: head.replace(/\s+/g, " "), body: css.slice(i + 1, end), at: [...stack] });
      i = end;
      start = end + 1;
    } else if (ch === "}") {
      stack.pop();
      start = i + 1;
    }
  }
  return rules;
}

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const rules = rulesOf(css);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const decl = (body: string, prop: string) => (body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`)) ?? [])[1]?.trim();
const zeroes = (body: string) => /(?:^|;)\s*outline\s*:\s*(?:none|0)\b|(?:^|;)\s*outline-style\s*:\s*none\b|(?:^|;)\s*outline-width\s*:\s*0\b/.test(body);

// The ring links and buttons get: the reference for "the same ring".
const base = rules.find((r) => r.at.length === 0 && r.selector.includes(":where(a, button,") && r.selector.includes(":focus-visible"));

test("the stylesheet still has the site's ring on links and buttons", () => {
  assert.ok(base, "the global :where(a, button, …):focus-visible rule is missing from app/globals.css");
  assert.equal(decl(base.body, "outline"), "3px solid var(--focus)");
  assert.equal(decl(base.body, "outline-offset"), "3px");
});

test("the same ring reaches every element focusable through tabindex, and named regions", () => {
  const reach = rules.filter((r) => r.at.length === 0 && r.selector.includes(":focus-visible"));
  const covers = (needle: string) =>
    reach.find((r) => r.selector.split(/,(?![^()]*\))/).some((part) => part.includes(needle) && part.includes(":focus-visible")));
  for (const needle of ['[tabindex]:not([tabindex="-1"])', '[role="region"][tabindex]']) {
    const rule = covers(needle);
    assert.ok(rule, `no top-level :focus-visible rule in app/globals.css covers ${needle}; a scroll region keeps the browser's own outline`);
    // Specificity zero (inside :where), so a component's own ring still wins.
    assert.match(rule.selector, /:where\(/, `${needle}: the ring must sit inside :where() so a component's own ring keeps winning`);
    assert.equal(decl(rule.body, "outline"), decl(base!.body, "outline"), `${needle}: not the site's ring`);
    assert.equal(decl(rule.body, "outline-offset"), decl(base!.body, "outline-offset"), `${needle}: not the site's offset`);
  }
});

test("on the dark sections the ring turns white for every focused element, tabindex ones included", () => {
  const dark = rules.find((r) => r.at.length === 0 && r.selector.startsWith(".on-dark :is(:focus-visible"));
  assert.ok(dark, "the dark-section ring rule is missing");
  assert.equal(decl(dark.body, "outline-color"), "#fff");
});

test("nothing in the stylesheet takes the ring away from tabindex elements or regions, in any mode", () => {
  const offenders = rules
    .filter((r) => /\[tabindex|\[role="region"\]|(?:^|[\s,(])\*?:focus(?:-visible)?\b/.test(r.selector) && zeroes(r.body))
    .map((r) => `${r.at.join(" ")} ${r.selector}`.trim());
  assert.deepEqual(offenders, []);
  // Forced colors: the browser forces outline-color to a system color but keeps
  // a solid outline; no forced-colors block may remove it for these elements.
  const forced = rules.filter((r) => r.at.some((a) => a.includes("forced-colors")) && /tabindex|region|:focus/.test(r.selector) && zeroes(r.body));
  assert.deepEqual(forced.map((r) => r.selector), []);
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir))) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const rel = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(rel)) out.push(rel);
  }
  return out;
}

/** The whole opening tag around position `at`: from its `<` to its own `>`. */
function tagAround(src: string, at: number): string {
  let start = at;
  while (start > 0 && !(src[start] === "<" && /[A-Za-z]/.test(src[start + 1] ?? ""))) start--;
  let depth = 0;
  let quoted = false;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (depth === 0 && ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Classes whose :focus or :focus-visible zeroes the outline, unless the same class draws its own ring on :focus-visible. */
function classesThatHideTheRing(): Set<string> {
  const hide = new Set<string>();
  const draw = new Set<string>();
  for (const r of rules) {
    for (const m of r.selector.matchAll(/\.([\w-]+)(?::[\w-]+(?:\([^)]*\))?)*?:focus(-visible)?\b/g)) {
      if (zeroes(r.body)) hide.add(m[1]);
      const width = Number((decl(r.body, "outline") ?? decl(r.body, "outline-width") ?? "").match(/(\d+)px/)?.[1] ?? 0);
      if (m[2] && width >= 2 && !zeroes(r.body)) draw.add(m[1]);
    }
  }
  for (const c of draw) hide.delete(c);
  return hide;
}

test("every element with tabindex=\"0\" in app/ and components/ leaves the outline alone", () => {
  const hidden = classesThatHideTheRing();
  const found: string[] = [];
  const bad: string[] = [];
  for (const file of [...walk("app"), ...walk("components")]) {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    for (const m of src.matchAll(/tabIndex=\{0\}|tabIndex="0"|tabindex="0"|tabindex=\\"0\\"/g)) {
      const tag = tagAround(src, m.index!);
      const line = src.slice(0, m.index!).split("\n").length;
      const where = `${file}:${line}`;
      found.push(where);
      const classes = flat((tag.match(/class(?:Name)?=(?:"([^"]*)"|\{([\s\S]*?)\}(?=\s+[\w-]+=|\s*\/?>))/) ?? []).slice(1).join(" "))
        .split(/[\s"'`]+/)
        .filter(Boolean);
      const tw = classes.filter((c) => /(?:^|:)!?(?:outline-(?:none|0|hidden)|\[outline:(?:none|0)\])!?$/.test(c));
      if (tw.length) bad.push(`${where}: ${tw.join(" ")}`);
      if (/outline:\s*["']?(?:none|0)\b|outlineStyle:\s*["']none|outlineWidth:\s*0\b/.test(tag)) bad.push(`${where}: inline style zeroes the outline`);
      const css = classes.filter((c) => hidden.has(c));
      if (css.length) bad.push(`${where}: .${css.join(", .")} zeroes the outline on focus in app/globals.css`);
    }
  }
  // The inventory has to find them, or this test proves nothing.
  assert.ok(found.length >= 40, `expected at least 40 elements with tabindex="0", found ${found.length}`);
  assert.deepEqual(bad, []);
});
