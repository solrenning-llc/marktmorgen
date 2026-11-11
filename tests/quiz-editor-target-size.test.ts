import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const source = readFileSync("components/quiz-editor.tsx", "utf8");
const removeAnswer = source.match(
  /<button\s+type="button"\s+className="([^"]+)"\s+aria-label=\{`Remove answer \$\{ci \+ 1\}`\}/,
);
const classes = removeAnswer?.[1]?.split(/\s+/) ?? [];

assert.ok(removeAnswer, "the answer editor keeps one named remove control");
assert.ok(classes.includes("h-11") || classes.includes("min-h-11"), "the remove control is at least 44px tall");
assert.ok(classes.includes("w-11") || classes.includes("min-w-11"), "the remove control is at least 44px wide");
assert.match(source, /disabled=\{question\.choices\.length <= MIN_CHOICES\}/, "the last two answers still cannot be removed");
console.log("Quiz answer removal target: 4 checks passed");
