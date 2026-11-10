/**
 * The color pairs a page really draws, read from its source, so tests/dark-scheme-switch.test.ts can hold every one
 * of them to AAA with the dark tokens on (lib/dark-tokens.ts, stage 2 of dark mode, 274 [AX1]).
 *
 * It reads app/globals.css (the tokens, the rules and the dark block) and the JSX of each page that dark mode covers
 * and of every component those pages import, and for each element works out the text colors it can have and the
 * backgrounds it can sit on: its own classes (a Tailwind color utility or a class of app/globals.css), else the
 * nearest ancestor's in the same file, else the page's surfaces. It is deliberately suspicious:
 *   - every state counts (hover, focus, open, pressed), each conditional branch of a className counts, and a class's
 *     text color is checked against every background the element can show, never only the matching one;
 *   - a color it cannot read (a palette name nobody defined, a function it does not know) is a failure, never a pass;
 *   - a translucent color is blended over each background beneath it before it is measured.
 * What it cannot see is said in the test: colors set by a script or a creator's theme, and images.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import * as ts from "typescript";
import { contrastRatio } from "@/lib/dark-tokens";

export type Rgba = { r: number; g: number; b: number; a: number };
export type Pair = { where: string; fg: string; bg: string; ratio: number; min: number };

const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------- CSS

type Rule = { selector: string; decls: Record<string, string>; at: string[] };

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every style rule with the at-rules around it. Keyframes are not style rules and are left out. */
export function parseRules(css: string, at: string[] = []): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  const text = stripComments(css);
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    const inner = text.slice(open + 1, j - 1);
    const semi = head.lastIndexOf(";");
    const cleanHead = semi >= 0 ? head.slice(semi + 1).trim() : head;
    if (cleanHead.startsWith("@")) {
      if (!/^@keyframes|^@font-face|^@property|^@theme|^@custom-variant|^@utility/.test(cleanHead)) out.push(...parseRules(inner, [...at, cleanHead]));
    } else if (/\{/.test(inner)) {
      // Nested rules (CSS nesting): read them with the parent selector in front.
      for (const r of parseRules(inner, at)) out.push({ ...r, selector: `${cleanHead} ${r.selector.replace(/^&/, "")}`.trim() });
    } else {
      const decls: Record<string, string> = {};
      for (const d of inner.split(";")) {
        const k = d.indexOf(":");
        if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim().replace(/\s*!important$/, "");
      }
      out.push({ selector: cleanHead, decls, at });
    }
    i = j;
  }
  return out;
}

/** Split a selector list at its top-level commas. */
export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The class names in a selector, unescaped (`.hover\:text-ink` is `hover:text-ink`). */
export function classesOf(selector: string): string[] {
  const out: string[] = [];
  const re = /\.((?:\\.|[\w-])+)/g;
  for (const m of selector.replace(/:(?:not|is|where|has)\([^)]*\)/g, "").matchAll(re)) out.push(m[1].replace(/\\(.)/g, "$1"));
  return out;
}

/** A selector that is one class and pseudo-classes only: its class and its state, else null. */
export function simpleClass(selector: string): { cls: string; state: string } | null {
  const m = /^\.((?:\\.|[\w-])+)((?::{1,2}[\w-]+(?:\([^()]*\))?)*)$/.exec(selector);
  if (!m) return null;
  return { cls: m[1].replace(/\\(.)/g, "$1"), state: m[2] };
}

// ---------------------------------------------------------------- colors

export function hexOf(c: Rgba): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function fromHex(h: string): Rgba | null {
  let s = h.slice(1).toLowerCase();
  if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(s)) return null;
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16), a: s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1 };
}

/** `top` drawn over the opaque `under`. */
export function over(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

export type Palette = { tokens: Map<string, string>; theme: Map<string, string> };

/** The tokens in force: the light :root, then the dark block's own declarations over it. */
export function palette(css: string, darkSelector: string | null): Palette {
  const rules = parseRules(css);
  const tokens = new Map<string, string>();
  for (const r of rules) if (r.selector === ":root" && r.at.length === 0) for (const [k, v] of Object.entries(r.decls)) if (k.startsWith("--")) tokens.set(k.slice(2), v);
  if (darkSelector) for (const r of rules) if (r.selector === darkSelector) for (const [k, v] of Object.entries(r.decls)) if (k.startsWith("--")) tokens.set(k.slice(2), v);
  const theme = new Map<string, string>();
  const t = /@theme inline \{([\s\S]*?)\n\}/.exec(stripComments(css));
  if (t) for (const m of t[1].matchAll(/--color-([\w-]+):\s*([^;]+);/g)) theme.set(m[1], m[2].trim());
  return { tokens, theme };
}

const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000" };

/**
 * Every color a CSS value can paint, or null when any part of it cannot be read. "transparent", "inherit",
 * "currentColor" and "none" paint nothing of their own and give an empty list.
 */
export function colorsOf(value: string, p: Palette, depth = 0): Rgba[] | null {
  if (depth > 12) return null;
  const v = value.trim();
  if (!v || /^(transparent|inherit|currentcolor|none|initial|unset)$/i.test(v)) return [];
  const varM = /^var\(--([\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(v);
  if (varM) {
    const t = p.tokens.get(varM[1]);
    if (t !== undefined) return colorsOf(t, p, depth + 1);
    return varM[2] ? colorsOf(varM[2], p, depth + 1) : null;
  }
  if (v.startsWith("#")) {
    const c = fromHex(v);
    return c ? [c] : null;
  }
  if (NAMED[v.toLowerCase()]) return [fromHex(NAMED[v.toLowerCase()])!];
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return [{ r: +rgb[1], g: +rgb[2], b: +rgb[3], a }];
  }
  const mix = /^color-mix\(in srgb,\s*([\s\S]+?)(?:\s+([\d.]+)%)?,\s*([\s\S]+?)(?:\s+([\d.]+)%)?\)$/.exec(v);
  if (mix) {
    const a = colorsOf(mix[1], p, depth + 1);
    const b = mix[3] === "transparent" ? [{ r: 0, g: 0, b: 0, a: 0 }] : colorsOf(mix[3], p, depth + 1);
    if (!a || !b || a.length !== 1 || b.length !== 1) return null;
    const pa = mix[2] ? +mix[2] / 100 : mix[4] ? 1 - +mix[4] / 100 : 0.5;
    const [x, y] = [a[0], b[0]];
    const alpha = x.a * pa + y.a * (1 - pa);
    if (alpha === 0) return [];
    const ch = (k: "r" | "g" | "b") => (x[k] * x.a * pa + y[k] * y.a * (1 - pa)) / alpha;
    return [{ r: ch("r"), g: ch("g"), b: ch("b"), a: alpha }];
  }
  // A list of backgrounds or a gradient: every color stop in it.
  if (/gradient\(|,/.test(v) || /\s/.test(v)) {
    const parts: Rgba[] = [];
    const tokens = v.match(/var\(--[\w-]+(?:\s*,[^)]*)?\)|#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|color-mix\((?:[^()]|\([^()]*\))*\)|\b(?:white|black|transparent)\b/g) ?? [];
    for (const t of tokens) {
      const c = colorsOf(t, p, depth + 1);
      if (c === null) return null;
      parts.push(...c);
    }
    if (/url\(/.test(v) && parts.length === 0) return [];
    return parts;
  }
  return null;
}

// ---------------------------------------------------------------- Tailwind

const VARIANT_STATE: Record<string, string> = { hover: ":hover", focus: ":focus", "focus-visible": ":focus-visible", "focus-within": ":focus-within", active: ":active", disabled: ":disabled", visited: ":visited" };

/** A Tailwind token's variants and its utility. */
function splitVariants(token: string): { variants: string[]; utility: string } {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of token) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === ":" && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const utility = parts.pop()!.replace(/^!/, "");
  return { variants: parts, utility };
}

/** The color a Tailwind color utility sets, as a CSS value, or undefined when the token is no color utility. */
export function utilityColor(utility: string, prefix: "text" | "bg", p: Palette): string | null | undefined {
  if (!utility.startsWith(`${prefix}-`)) return undefined;
  let rest = utility.slice(prefix.length + 1);
  let alpha: number | null = null;
  const op = /^(.*)\/(\d+|\[[\d.]+\])$/.exec(rest);
  if (op) {
    rest = op[1];
    alpha = op[2].startsWith("[") ? parseFloat(op[2].slice(1, -1)) : +op[2] / 100;
  }
  let value: string | undefined;
  if (rest.startsWith("[")) {
    const inner = rest.slice(1, -1).replace(/_/g, " ").replace(/^color:/, "");
    if (/^(#|rgb|var\(--(?!font|text|leading|r-)|color-mix)/.test(inner)) value = inner;
    else return undefined;
  } else if (p.theme.has(rest)) value = p.theme.get(rest)!;
  else if (NAMED[rest] || rest === "transparent" || rest === "current" || rest === "inherit") value = NAMED[rest] ?? (rest === "current" ? "currentColor" : rest);
  else if (/^(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}$/.test(rest)) return null;
  else return undefined;
  return alpha === null ? value : `color-mix(in srgb, ${value} ${Math.round(alpha * 100)}%, transparent)`;
}

// ---------------------------------------------------------------- the model of the classes

type Look = { fg?: string; bg?: string; state: string; from: string };

export type Model = {
  palette: Palette;
  /** The looks each class token can give an element. */
  looks: (token: string) => Look[];
  /** Rules with more than one part (`.legal-body a`), with the overrides already applied. */
  complex: { selector: string; decls: Record<string, string> }[];
  /** The page's own surfaces and text, from body. */
  page: { fg: string; bg: string[] };
};

const SKIP_AT = /forced-colors|print|prefers-contrast|inverted-colors/;

export function model(css: string, darkSelector: string | null): Model {
  const p = palette(css, darkSelector);
  const rules = parseRules(css).filter((r) => !r.at.some((a) => SKIP_AT.test(a)));
  const simple = new Map<string, Map<string, Look>>();
  const complex: { selector: string; decls: Record<string, string> }[] = [];
  const overrides = new Map<string, Record<string, string>>();
  const put = (cls: string, state: string, decls: Record<string, string>, from: string, replace: boolean) => {
    const fg = decls.color;
    const bg = decls.background ?? decls["background-color"];
    if (fg === undefined && bg === undefined) return;
    const byState = simple.get(cls) ?? new Map<string, Look>();
    const old = byState.get(state);
    byState.set(state, { fg: fg ?? old?.fg, bg: bg ?? old?.bg, state, from: replace && old ? `${old.from}, dark ${from}` : from });
    simple.set(cls, byState);
  };
  for (const r of rules) {
    if (darkSelector && r.selector === darkSelector) continue;
    for (const sel of splitSelectors(r.selector)) {
      const prefix = darkSelector ? `:where(${darkSelector}) ` : null;
      if (prefix && sel.startsWith(prefix)) {
        overrides.set(sel.slice(prefix.length), r.decls);
        continue;
      }
      if (/^:root\[data-color-scheme|^:where\(:root\[data-color-scheme/.test(sel)) continue;
      const s = simpleClass(sel);
      if (s) put(s.cls, s.state, r.decls, sel, false);
      else complex.push({ selector: sel, decls: r.decls });
    }
  }
  const utilityOverrides = new Map<string, Record<string, string>>();
  for (const [sel, decls] of overrides) {
    const s = simpleClass(sel);
    if (s && simple.has(s.cls)) put(s.cls, s.state, decls, sel, true);
    else if (s) utilityOverrides.set(s.cls, decls);
    else {
      const at = complex.findIndex((c) => c.selector === sel);
      if (at >= 0) complex[at] = { selector: sel, decls: { ...complex[at].decls, ...decls } };
      else complex.push({ selector: sel, decls });
    }
  }
  const looks = (token: string): Look[] => {
    const out: Look[] = [];
    const own = simple.get(token);
    if (own) out.push(...own.values());
    const { variants, utility } = splitVariants(token);
    const state = variants.map((v) => VARIANT_STATE[v] ?? `(${v})`).join("");
    const o = utilityOverrides.get(token);
    const fg = utilityColor(utility, "text", p);
    const bg = utilityColor(utility, "bg", p);
    if (fg !== undefined) out.push({ fg: o?.color ?? (fg === null ? `?${utility}` : fg), state, from: o ? `${token}, dark override` : token });
    if (bg !== undefined) out.push({ bg: o?.["background-color"] ?? o?.background ?? (bg === null ? `?${utility}` : bg), state, from: o ? `${token}, dark override` : token });
    return out;
  };
  const body = rules.find((r) => r.selector === "body" && (r.decls.background || r.decls["background-color"]));
  const page = { fg: body?.decls.color ?? "var(--foreground)", bg: [body?.decls.background ?? body?.decls["background-color"] ?? "var(--background)", "var(--sand)", "var(--sand-deep)"] };
  return { palette: p, looks, complex, page };
}

// ---------------------------------------------------------------- JSX

/** The files a page is drawn from: the page and every component it imports, followed through. */
export function closure(entries: string[]): string[] {
  const seen = new Set<string>();
  const todo = [...entries];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = read(f);
    for (const m of src.matchAll(/from "(@\/components\/[^"]+|\.\.?\/[^"]+)"/g)) {
      const base = m[1].startsWith("@/") ? m[1].slice(2) : normalize(join(dirname(f), m[1])).replace(/\\/g, "/");
      for (const ext of [".tsx", ".ts"]) if (existsSync(base + ext) && /^(components|app)\//.test(base)) {
        todo.push(base + ext);
        break;
      }
    }
  }
  return [...seen].filter((f) => f.endsWith(".tsx")).sort();
}

/** Every page.tsx under app/ that draws itself with the given component. */
export function pagesUsing(component: string, dir = "app"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const f = `${dir}/${name}`;
    if (statSync(f).isDirectory()) out.push(...pagesUsing(component, f));
    else if (name === "page.tsx" && read(f).includes(`from "${component}"`)) out.push(f);
  }
  return out.sort();
}

type Ctx = { fg: string[]; bg: Rgba[]; large: boolean; line: string };

const LARGE = new Set(["t-display", "t-h1", "t-h2", "t-h3", "t-section"]);

/** The class sets a className expression can give, one per branch. */
function variantsOf(node: ts.Node | undefined, consts: Map<string, ts.Node>, depth = 0): string[][] {
  if (!node || depth > 8) return [[]];
  const words = (s: string) => s.split(/\s+/).filter(Boolean);
  const product = (lists: string[][][]): string[][] => {
    let acc: string[][] = [[]];
    for (const l of lists) {
      const next: string[][] = [];
      for (const a of acc) for (const b of l) next.push([...a, ...b]);
      acc = next.length > 64 ? [[...new Set(next.flat())]] : next;
    }
    return acc;
  };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [words(node.text)];
  if (ts.isTemplateExpression(node)) {
    const lists: string[][][] = [[words(node.head.text)]];
    for (const s of node.templateSpans) {
      lists.push(variantsOf(s.expression, consts, depth + 1));
      lists.push([words(s.literal.text)]);
    }
    return product(lists);
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return variantsOf(node.expression, consts, depth + 1);
  if (ts.isConditionalExpression(node)) return [...variantsOf(node.whenTrue, consts, depth + 1), ...variantsOf(node.whenFalse, consts, depth + 1)];
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return [[], ...variantsOf(node.right, consts, depth + 1)];
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return [...variantsOf(node.left, consts, depth + 1), ...variantsOf(node.right, consts, depth + 1)];
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return product([variantsOf(node.left, consts, depth + 1), variantsOf(node.right, consts, depth + 1)]);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "join" && ts.isArrayLiteralExpression(callee.expression)) return product(callee.expression.elements.map((e) => variantsOf(e, consts, depth + 1)));
    return product(node.arguments.map((a) => variantsOf(a, consts, depth + 1)));
  }
  if (ts.isArrayLiteralExpression(node)) return product(node.elements.map((e) => variantsOf(e, consts, depth + 1)));
  if (ts.isIdentifier(node)) {
    const init = consts.get(node.text);
    return init ? variantsOf(init, consts, depth + 1) : [[]];
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    let base: ts.Node = node.expression;
    while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) base = base.expression;
    const init = ts.isIdentifier(base) ? consts.get(base.text) : undefined;
    if (!init) return [[]];
    const all: string[][] = [];
    const walk = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) all.push(words(n.text));
      ts.forEachChild(n, walk);
    };
    walk(init);
    return all.length ? all : [[]];
  }
  return [[]];
}

/** The pairs one file draws, given the context its root sits in. */
export function filePairs(file: string, m: Model, root: Ctx): { pairs: Pair[]; classes: Set<string>; unread: string[] } {
  const src = read(file);
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts = new Map<string, ts.Node>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const pairs: Pair[] = [];
  const classes = new Set<string>();
  const unread: string[] = [];
  const resolve = (value: string, where: string): Rgba[] => {
    if (value.startsWith("?")) {
      unread.push(`${where}: ${value.slice(1)} is not a color this site defines`);
      return [];
    }
    const c = colorsOf(value, m.palette);
    if (c === null) {
      unread.push(`${where}: cannot read ${value}`);
      return [];
    }
    return c;
  };
  const check = (where: string, fgs: string[], bgs: Rgba[], large: boolean) => {
    for (const fv of fgs) for (const f of resolve(fv, where)) for (const b of bgs) {
      const shown = f.a < 1 ? over(f, b) : f;
      const ratio = contrastRatio(hexOf(shown), hexOf(b));
      pairs.push({ where, fg: `${fv} = ${hexOf(shown)}`, bg: hexOf(b), ratio, min: large ? 4.5 : 7 });
    }
  };
  const elementOf = (n: ts.Node): ts.JsxOpeningLikeElement | null => (ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null);
  const visit = (n: ts.Node, ctx: Ctx) => {
    const el = elementOf(n);
    if (!el) {
      ts.forEachChild(n, (c) => visit(c, ctx));
      return;
    }
    const line = sf.getLineAndCharacterOfPosition(el.getStart()).line + 1;
    const where = `${file}:${line}`;
    const attr = el.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === "className");
    const init = attr?.initializer;
    const expr = init && ts.isJsxExpression(init) ? init.expression : init;
    const variants = attr ? variantsOf(expr, consts) : [[]];
    const hasText = ts.isJsxElement(n) && n.children.some((c) => (ts.isJsxText(c) && c.text.trim() !== "") || ts.isJsxExpression(c) || ts.isJsxElement(c));
    const fgAll = new Set<string>();
    const bgAll: Rgba[] = [];
    let large = ctx.large;
    let ownFg = false;
    for (const v of variants) {
      for (const c of v) classes.add(c);
      if (v.some((c) => LARGE.has(c))) large = true;
      const looks = v.flatMap((c) => m.looks(c));
      const fgs = looks.filter((l) => l.fg !== undefined).map((l) => l.fg!);
      const bgs = looks.filter((l) => l.bg !== undefined).map((l) => l.bg!);
      const fgUse = fgs.length ? fgs : ctx.fg;
      if (fgs.length) ownFg = true;
      let bgUse = ctx.bg;
      if (bgs.length) {
        const painted: Rgba[] = [];
        for (const bv of bgs) for (const c of resolve(bv, where)) for (const under of ctx.bg) painted.push(c.a < 1 ? over(c, under) : c);
        if (painted.length) bgUse = painted;
      }
      const via = looks.map((l) => l.from).join(", ");
      if (fgs.length || (bgs.length && hasText)) check(via ? `${where} (${via})` : where, fgUse, bgUse, large);
      for (const f of fgUse) fgAll.add(f);
      for (const b of bgUse) if (!bgAll.some((x) => hexOf(x) === hexOf(b))) bgAll.push(b);
    }
    const next: Ctx = { fg: [...fgAll], bg: bgAll.length ? bgAll : ctx.bg, large, line: where };
    void ownFg;
    ts.forEachChild(n, (c) => {
      if (c === el) return;
      visit(c, next);
    });
  };
  visit(sf, root);
  return { pairs, classes, unread };
}

/** The pairs of the rules with more than one part whose classes the pages use. */
export function complexPairs(m: Model, used: Set<string>, root: Ctx): { pairs: Pair[]; unread: string[] } {
  const pairs: Pair[] = [];
  const unread: string[] = [];
  for (const r of m.complex) {
    const fgv = r.decls.color;
    const bgv = r.decls.background ?? r.decls["background-color"];
    if (fgv === undefined && bgv === undefined) continue;
    const cls = classesOf(r.selector);
    if (cls.length === 0 && !/^(body|html|a|::selection|[a-z]+(:[\w-]+)?)$/.test(r.selector)) continue;
    if (!cls.every((c) => used.has(c))) continue;
    if (/:root\[|\[data-color-scheme|\.dark\b/.test(r.selector)) continue;
    const where = `app/globals.css ${r.selector}`;
    const read = (v: string): Rgba[] => {
      const c = colorsOf(v, m.palette);
      if (c === null) unread.push(`${where}: cannot read ${v}`);
      return c ?? [];
    };
    // The surface under it: its own, else the background of the nearest class in the selector that has one.
    let bgs: Rgba[] = [];
    if (bgv !== undefined) for (const c of read(bgv)) for (const u of root.bg) bgs.push(c.a < 1 ? over(c, u) : c);
    if (!bgs.length) {
      for (const c of [...cls].reverse()) {
        const own = m.looks(c).filter((l) => l.bg !== undefined);
        if (own.length) {
          for (const l of own) for (const x of read(l.bg!)) for (const u of root.bg) bgs.push(x.a < 1 ? over(x, u) : x);
          if (bgs.length) break;
        }
      }
    }
    if (!bgs.length) bgs = root.bg;
    let fgs: string[] = fgv !== undefined ? [fgv] : [];
    if (!fgs.length) for (const c of [...cls].reverse()) {
      const own = m.looks(c).filter((l) => l.fg !== undefined).map((l) => l.fg!);
      if (own.length) {
        fgs = own;
        break;
      }
    }
    if (!fgs.length) fgs = root.fg;
    const large = cls.some((c) => LARGE.has(c));
    for (const fv of fgs) for (const f of read(fv)) for (const b of bgs) {
      const shown = f.a < 1 ? over(f, b) : f;
      pairs.push({ where, fg: `${fv} = ${hexOf(shown)}`, bg: hexOf(b), ratio: contrastRatio(hexOf(shown), hexOf(b)), min: large ? 4.5 : 7 });
    }
  }
  return { pairs, unread };
}

/** The page's root context: body's text on the page's surfaces. */
export function rootCtx(m: Model): Ctx {
  const bg: Rgba[] = [];
  for (const v of m.page.bg) for (const c of colorsOf(v, m.palette) ?? []) bg.push(c);
  return { fg: [m.page.fg], bg, large: false, line: "body" };
}

/** Every pair the given pages draw. */
export function pagePairs(css: string, darkSelector: string | null, files: string[]) {
  const m = model(css, darkSelector);
  const root = rootCtx(m);
  const used = new Set<string>();
  const pairs: Pair[] = [];
  const unread: string[] = [];
  for (const f of files) {
    const r = filePairs(f, m, root);
    pairs.push(...r.pairs);
    unread.push(...r.unread);
    for (const c of r.classes) used.add(c);
  }
  const c = complexPairs(m, used, root);
  pairs.push(...c.pairs);
  unread.push(...c.unread);
  return { pairs, unread, used };
}
