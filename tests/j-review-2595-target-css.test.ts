import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const requireFromProject = createRequire(resolve("package.json"));
const { compile } = requireFromProject("@tailwindcss/node") as typeof import("@tailwindcss/node");
const postcss = requireFromProject("postcss") as typeof import("postcss");
const source = readFileSync("components/quiz-editor.tsx", "utf8");
const old = execFileSync("git", ["show", "d8b75ae6e3fa8705a93aa59d726285d564aee65d:components/quiz-editor.tsx"], { encoding: "utf8" });
const ast = ts.createSourceFile("quiz-editor.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const buttons: ts.JsxOpeningElement[] = [];
function visit(node: ts.Node): void {
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === "button"
    && node.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(ast) === "aria-label"
      && p.initializer?.getText(ast).includes("Remove answer"))) buttons.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(buttons.length, 1);
const button = buttons[0];
function attribute(name: string): ts.JsxAttribute {
  const value = button.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === name);
  assert.ok(value && ts.isJsxAttribute(value), name);
  return value;
}
const classesNode = attribute("className").initializer;
assert.ok(classesNode && ts.isStringLiteral(classesNode));
const classes = classesNode.text.split(/\s+/);
const css = compile(readFileSync("app/globals.css", "utf8"), { base: resolve("app"), onDependency() {} })
  .then(result => result.build(classes));

function declaration(text: string, selector: string, property: string): string {
  const values: string[] = [];
  postcss.parse(text).walkRules(selector, rule => {
    rule.walkDecls(property, decl => { values.push(decl.value); });
  });
  assert.equal(values.length, 1, `${selector} ${property}`);
  return values[0];
}

for (const [prefix, property] of [["h", "height"], ["w", "width"]] as const) {
  test(`real Tailwind ${property} reaches the 44 CSS-pixel target at a 16px root`, async () => {
    const text = await css;
    const spacing = text.match(/--spacing:\s*([\d.]+)rem\s*;/);
    assert.ok(spacing);
    const token = classes.find(c => new RegExp(`^${prefix}-[0-9]+$`).test(c));
    assert.ok(token);
    const multiplier = Number(token.split("-")[1]);
    assert.equal(declaration(text, `.${token}`, property), `calc(var(--spacing) * ${multiplier})`);
    const px = Number(spacing[1]) * multiplier * 16;
    assert.ok(px >= 44, `${property}: ${px}px`);
  });
}

test("the actual target cannot flex-shrink away its declared width", async () => {
  assert.equal(declaration(await css, ".shrink-0", "flex-shrink"), "0");
  assert.equal(attribute("type").initializer?.getText(ast), '"button"');
  assert.equal(attribute("aria-label").initializer?.getText(ast), '{`Remove answer ${ci + 1}`}');
});

test("only size classes change; the original disable and answer-index handler remain executable", () => {
  const normalize = (text: string) => text.replace(/grid h-(?:9|11) w-(?:9|11) shrink-0/, "grid REVIEW_SIZE shrink-0");
  assert.equal(normalize(source), normalize(old));
  const min = readFileSync("lib/quiz.ts", "utf8").match(/export const MIN_CHOICES\s*=\s*(\d+)/);
  assert.ok(min);
  const disabled = attribute("disabled").initializer;
  const onClick = attribute("onClick").initializer;
  assert.ok(disabled && ts.isJsxExpression(disabled) && disabled.expression);
  assert.ok(onClick && ts.isJsxExpression(onClick) && onClick.expression);
  for (const length of [2, 3, 5]) {
    const question = { choices: Array.from({ length }, (_, i) => `Choice ${i}`), correct: [0, 1, length - 1] };
    assert.equal(runInNewContext(disabled.expression.getText(ast), { question, MIN_CHOICES: Number(min[1]) }), length <= Number(min[1]));
    for (let ci = 0; ci < length; ci++) {
      let captured: unknown;
      const callback = runInNewContext(`(${onClick.expression.getText(ast)})`, {
        question, ci, qi: 0, change: (qi: number, next: unknown) => { assert.equal(qi, 0); captured = next; },
      }) as () => void;
      callback();
      assert.deepEqual(JSON.parse(JSON.stringify(captured)), {
        choices: question.choices.filter((_, i) => i !== ci),
        correct: question.correct.filter(i => i !== ci).map(i => i > ci ? i - 1 : i),
      });
    }
  }
});
