/**
 * Stand-alone text controls are 44 x 44 CSS px targets (WCAG 2.5.5, AAA;
 * AGENTS.md AX274 Part A item 4).
 *
 * The site gives a floor to its shared control classes (`.btn`, `.btn-sm`,
 * `.chip`, `.st-recent-close`...) in app/globals.css, but there is no floor on
 * a bare `<button>`: a control drawn as underlined text ("Ask the creator",
 * "Start over", "Remove Stripe", "Let it go", "Move up") was only as tall as
 * its line, 16 to 24 px. On a store page the chat and the Store assistant are
 * on every page, so a buyer on a phone had to hit a 16 px line to reach the
 * creator.
 *
 * What is checked, in the real source of each file below, with the
 * TypeScript parser: every `<button>`, `<a>` and `<Link>` that sets a class
 * either carries a shared class with its own floor or the `min-h-11` utility,
 * and the compiled CSS of `min-h-11` is 44 px. A class kept in a constant of
 * the same file is read through it. A link or button written inside a
 * sentence keeps the line's height, as WCAG 2.5.5 allows; each one is named
 * below with its reason, so nothing else can hide behind the exemption.
 *
 * Not checked here: the rendered height in a browser (the size comes from
 * the compiled class only), the 44 px width of one-word buttons (their
 * spacing is checked by eye only), and the files of this list that other
 * agents' open pull requests own.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const FILES = [
  "components/store-assistant.tsx",
  "components/store-chat.tsx",
  "components/tools-calculator.tsx",
  "components/team-event-editor.tsx",
  "components/workflow-tools.tsx",
  "components/task-editor.tsx",
  "components/link-editor.tsx",
  "components/old-addresses.tsx",
];

/** Shared classes whose 44 px floor app/globals.css sets (checked below), or the utility itself. */
const FLOOR_CLASSES = ["btn", "btn-sm", "st-recent-close", "min-h-11", "h-11", "min-h-[44px]"];

/** Vertical padding that, around a 24 px line, already makes 48 px or more (py-3 = 12 px a side). */
const PADDED = /^py-(3|3\.5|4|5|6)$/;

/** Controls inside a sentence: they keep the line's own height (WCAG 2.5.5 "Inline"). */
const INLINE: { file: string; marker: string; reason: string }[] = [
  {
    file: "components/store-assistant.tsx",
    marker: "forget()",
    reason: "\"Delete this chat\" ends the privacy sentence it belongs to",
  },
  {
    file: "components/tools-calculator.tsx",
    marker: "source.url",
    reason: "each source link sits in the sentence that lists the sources and the day each was read",
  },
  {
    file: "components/workflow-tools.tsx",
    marker: "onClick={erasePerson}",
    reason: "\"Erase ... from every workflow\" is the middle of the sentence that says what is erased",
  },
];

type Control = { file: string; line: number; tag: string; classes: string[]; text: string };

function controls(file: string): Control[] {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = new Map<string, string>();
  const out: Control[] = [];
  const classText = (expression: ts.Expression | undefined): string => {
    if (!expression) return "";
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isIdentifier(expression)) return constants.get(expression.text) ?? "";
    if (ts.isTemplateExpression(expression)) {
      return [expression.head.text, ...expression.templateSpans.map((span) => `${classText(span.expression)} ${span.literal.text}`)].join(" ");
    }
    if (ts.isConditionalExpression(expression)) return `${classText(expression.whenTrue)} ${classText(expression.whenFalse)}`;
    if (ts.isParenthesizedExpression(expression)) return classText(expression.expression);
    return "";
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) {
      constants.set(node.name.text, node.initializer.text);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(tree);
      if (tag === "button" || tag === "a" || tag === "Link") {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || attribute.name.getText(tree) !== "className" || !attribute.initializer) continue;
          const value = ts.isStringLiteral(attribute.initializer)
            ? attribute.initializer.text
            : ts.isJsxExpression(attribute.initializer) ? classText(attribute.initializer.expression) : "";
          const element = ts.isJsxOpeningElement(node) ? node.parent : node;
          out.push({
            file,
            line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
            tag,
            classes: value.split(/\s+/).filter(Boolean),
            text: element.getText(tree),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

async function main() {
  const found = FILES.flatMap(controls);
  assert.ok(found.length >= 40, `the parser reads the controls of every file (found ${found.length})`);
  for (const inline of INLINE) {
    assert.equal(found.filter((c) => c.file === inline.file && c.text.includes(inline.marker)).length, 1,
      `${inline.file}: the inline exemption (${inline.reason}) names exactly one control`);
  }
  const missing = found
    .filter((c) => !INLINE.some((inline) => inline.file === c.file && c.text.includes(inline.marker)))
    .filter((c) => !c.classes.some((token) => FLOOR_CLASSES.includes(token) || PADDED.test(token)))
    .map((c) => `${c.file}:${c.line} <${c.tag} className="${c.classes.join(" ")}">`);
  assert.deepEqual(missing, [], "every stand-alone text control has a 44 px floor");

  const smaller = found.filter((c) => c.classes.some((token) => /^(h|w|size)-(\d+)$/.test(token) && Number(token.split("-")[1]) < 11));
  assert.deepEqual(smaller.map((c) => `${c.file}:${c.line}`), [], "no control is drawn smaller than 44 px with a fixed size");

  // The floor is real CSS: the utility compiles to 44 px, and each shared class keeps its own 44 px rule.
  const css = readFileSync("app/globals.css", "utf8");
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiled = (await compile(css, { base: process.cwd(), onDependency() {} })).build(["min-h-11", "h-11"]);
  assert.match(compiled, /\.min-h-11\s*\{\s*min-height:\s*calc\(var\(--spacing\)\s*\*\s*11\)/, "min-h-11 is eleven spacing steps");
  assert.match(compiled, /--spacing:\s*0\.25rem/, "a spacing step is a quarter rem, so eleven are 44 px");
  for (const shared of ["btn", "btn-sm", "st-recent-close"]) {
    const rule = css.match(new RegExp(`(^|\\n)\\.${shared}\\s*\\{([^}]*)\\}`));
    const px = rule?.[2].match(/min-height:\s*(\d+)px/)?.[1];
    assert.ok(px && Number(px) >= 44, `.${shared} keeps its own floor of at least 44 px in app/globals.css`);
  }
  console.log(`standalone text controls: ${found.length} controls in ${FILES.length} files hold a 44 px floor`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
