import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readDrafted } from "@/lib/quiz-draft";
const q = (choices: unknown[], correct: unknown[]) => ({ text: "Which are true?", choices, correct, explanation: "" });
test("a correct list naming a position that is not among the answers leaves the question out (docstring)", () => {
  assert.deepEqual(readDrafted([q(["A true thing", "Another true thing", "A false thing", "Another false thing"], [0, 9])], 1), []);
});
test("a multiple-answer question whose second right answer is beyond MAX_CHOICES is not silently turned into single", () => {
  const choices = ["c0", "c1", "c2", "c3", "c4", "c5", "c6 also right"];
  assert.deepEqual(readDrafted([q(choices, [0, 6])], 1), []);
});
test("a non-integer correct entry is not silently dropped", () => {
  assert.deepEqual(readDrafted([q(["Right", "Also right", "Wrong", "Wrong too"], [0, "1"])], 1), []);
});
test("control: a clean multiple-answer question still passes", () => {
  assert.deepEqual(readDrafted([q(["Right", "Also right", "Wrong", "Wrong too"], [0, 1])], 1).map((x) => [x.kind, x.correct]), [["multiple", [0, 1]]]);
});
