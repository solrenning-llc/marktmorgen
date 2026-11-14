/**
 * WCAG 3.3.2 (labels or instructions), read the more accessible way (AX274):
 * every studio field has a label of its own on the screen, not only a group
 * heading and words inside the field that vanish once typing starts. These
 * fields had their label for screen readers only (sr-only); the same words
 * now show. Each label is read from its source by the id of its field.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FIELDS: { file: string; id: string; words: string }[] = [
  { file: "components/studio-help.tsx", id: '"studio-help-question"', words: "Your question" },
  { file: "components/tips-editor.tsx", id: "{`tip-amount-${i}`}", words: "{`Amount ${i + 1}`}" },
  { file: "components/community-studio.tsx", id: "{`cm-question-${i}`}", words: "{`Question ${i + 1}`}" },
  { file: "components/community-studio.tsx", id: "{`cm-reward-${level}`}", words: "{`Course Level ${level} hands over`}" },
  { file: "components/community-studio.tsx", id: '"cm-space-name"', words: "Name of the new space" },
  { file: "components/community-studio.tsx", id: '"cm-space-about"', words: "One line about the new space" },
  { file: "components/course-editor.tsx", id: "{`new-lesson-${unit.id}`}", words: "{`New lesson in module ${index + 1}`}" },
];

for (const { file, id, words } of FIELDS) {
  const source = readFileSync(file, "utf8");
  const label = source.split("\n").find((line) => line.includes(`htmlFor=${id}`));
  assert.ok(label, `${file}: the field ${id} still has its label`);
  assert.ok(label.includes(words), `${file}: its label still says ${words}`);
  const classes = label.match(/className="([^"]*)"/)?.[1] ?? "";
  assert.ok(!/(^|\s)sr-only(\s|$)/.test(classes), `${file}: the label of ${id} (${words}) is on the screen, not for screen readers only`);
}

// The AI box: its one field, "What it should say".
const ai = readFileSync("components/ai-assist.tsx", "utf8");
const aiLabel = ai.match(/<span className="([^"]*)">What it should say<\/span>/);
assert.ok(aiLabel, "the AI box still names its field");
assert.ok(!/(^|\s)sr-only(\s|$)/.test(aiLabel[1]), "the AI box's \"What it should say\" is on the screen");

console.log(`Studio labels: ${FIELDS.length + 1} fields each with a label on the screen`);
