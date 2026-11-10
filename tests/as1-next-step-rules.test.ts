/**
 * 560 [AS1], points 1 and 2, unit 2: the rules of a course's "Next step"
 * (lib/course-next-step-rules.ts), pure. Each case below fails on the wrong
 * behavior: a line that presses or promises a deal saved, the course offered
 * as its own next step, a product of another store, or the card shown to a
 * student who has the product, said "No thanks", or whose purchases could
 * not be read.
 *
 * Synthetic values only: nothing is read, written or sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_NEXT_STEP_LINE, NEXT_STEP_PROBLEMS, type NextStepProduct, lineProblem, nextStepPlace, nextStepShown, readNextStep } from "@/lib/course-next-step-rules";

const COURSE = "course000001";
const NEXT = "advanced0001";
const context = { courseProductId: COURSE, products: new Set([COURSE, NEXT, "other0000001"]) };

test("the creator's choice is a product of their own store, never the course itself, and an empty one takes it away", () => {
  assert.deepEqual(readNextStep({ productId: NEXT, line: "  When you are ready,\n go deeper with the advanced course.  " }, context), {
    ok: true,
    step: { productId: NEXT, line: "When you are ready, go deeper with the advanced course." },
  });
  assert.deepEqual(readNextStep({ productId: NEXT }, context), { ok: true, step: { productId: NEXT, line: "" } }, "the line may be left empty");
  assert.deepEqual(readNextStep({ productId: "" }, context), { ok: true, step: null });
  assert.deepEqual(readNextStep(null, context), { ok: true, step: null });
  assert.deepEqual(readNextStep({ productId: COURSE, line: "" }, context), { ok: false, why: "self" });
  assert.deepEqual(readNextStep({ productId: "elsewhere001", line: "" }, context), { ok: false, why: "product" }, "a product of another store");
});

test("the line is refused, never cut or rewritten, when it presses, promises a deal, counts, quotes, links or shouts", () => {
  const cases: [string, keyof typeof NEXT_STEP_PROBLEMS][] = [
    ["Get 20% off the advanced course", "deal"],
    ["Use the code SPRING for a discount", "deal"],
    ["Join now, before it's gone", "pressure"],
    ["Only a few spots left", "pressure"],
    ["Ahora es el momento", "pressure"],
    ["Over 300 students took it next", "number"],
    ["“The best course I took” says Ana", "quote"],
    ["See it at example.com", "link"],
    ["Write to me at hello@example.test", "link"],
    ["You will love it!", "exclaim"],
    ["a".repeat(MAX_NEXT_STEP_LINE + 1), "long"],
  ];
  for (const [line, why] of cases) {
    assert.deepEqual(readNextStep({ productId: NEXT, line }, context), { ok: false, why }, line);
    assert.equal(lineProblem(line), why, line);
    assert.ok(NEXT_STEP_PROBLEMS[why].length > 0 && !/[!]/.test(NEXT_STEP_PROBLEMS[why]), "each refusal says why, calmly");
  }
  // Characters that draw nothing never carry a word past the checks (review of #3523, MEDIUM): refused when they hide,
  // read through when they only join.
  for (const hidden of ["​", "⁠", "­", "‮", "‪", "⁦", "⁩"]) {
    assert.equal(lineProblem(`Join n${hidden}ow`), "hidden", `U+${hidden.codePointAt(0)!.toString(16)} is refused`);
    assert.deepEqual(readNextStep({ productId: NEXT, line: `A calm line${hidden}` }, context), { ok: false, why: "hidden" });
  }
  assert.equal(lineProblem("Join n‍ow"), "pressure", "a joiner inside a word does not hide it");
  assert.equal(lineProblem("Join n‌ow"), "pressure");
  assert.equal(lineProblem("Join ｎｏｗ"), "pressure", "fullwidth letters are read as letters");
  assert.equal(lineProblem("Get a dis‍count"), "deal");
  assert.equal(lineProblem("Última clase del curso"), "pressure", "an accented first letter is still a word");
  assert.equal(lineProblem("la última vez"), "pressure");
  for (const address of ["Visit janesmith.dev", "See coach.academy/join", "On site.de", "At café.example"]) assert.equal(lineProblem(address), "link", address);
  assert.equal(lineProblem("Go deeper, e.g. with the advanced module, when you are ready."), null, "an abbreviation is not an address");
  assert.equal(lineProblem("ادامه بده‌با دوره‏"), null, "a Persian joiner and a direction mark are kept");
  assert.equal(lineProblem("x".repeat(MAX_NEXT_STEP_LINE * 16 + 1)), "long", "bounded before it is counted");
  assert.ok(NEXT_STEP_PROBLEMS.hidden.length > 0);
  // Counted as a reader counts: an emoji made of several code points is one character.
  assert.equal(lineProblem("\u{1F469}‍\u{1F3EB}".repeat(MAX_NEXT_STEP_LINE)), null);
  assert.equal(lineProblem("Go deeper with the advanced course, at your own pace."), null);
});

const onSale = (left: number | null | "unknown" = null): NextStepProduct => ({ id: NEXT, onSale: true, left });
const base = { step: { productId: NEXT, line: "" }, courseProductId: COURSE, product: onSale() as NextStepProduct | null | "unknown", owned: false as boolean | "unknown", dismissed: false as boolean | "unknown" };

test("the card is shown only when nothing is in doubt: product on sale and in stock, not owned, not turned down", () => {
  assert.deepEqual(nextStepShown(base), { shown: true });
  assert.deepEqual(nextStepShown({ ...base, step: null }), { shown: false, why: "none" }, "no choice, nothing; no AI picks");
  assert.deepEqual(nextStepShown({ ...base, step: { productId: COURSE, line: "" } }), { shown: false, why: "self" });
  assert.deepEqual(nextStepShown({ ...base, product: null }), { shown: false, why: "gone" });
  assert.deepEqual(nextStepShown({ ...base, product: "unknown" }), { shown: false, why: "gone" });
  assert.deepEqual(nextStepShown({ ...base, product: { ...onSale(), id: "other0000001" } }), { shown: false, why: "gone" }, "a product read under another id");
  assert.deepEqual(nextStepShown({ ...base, product: { ...onSale(), onSale: false } }), { shown: false, why: "not_on_sale" }, "a draft or one no longer sold");
  assert.deepEqual(nextStepShown({ ...base, product: onSale(0) }), { shown: false, why: "sold_out" });
  assert.deepEqual(nextStepShown({ ...base, product: onSale(-1) }), { shown: false, why: "sold_out" });
  assert.deepEqual(nextStepShown({ ...base, product: onSale(Number.NaN) }), { shown: false, why: "sold_out" });
  assert.deepEqual(nextStepShown({ ...base, product: onSale("unknown") }), { shown: false, why: "stock_unknown" });
  assert.deepEqual(nextStepShown({ ...base, product: onSale(3) }), { shown: true }, "a limited one with some left");
  assert.deepEqual(nextStepShown({ ...base, owned: true }), { shown: false, why: "owned" });
  assert.deepEqual(nextStepShown({ ...base, owned: "unknown" }), { shown: false, why: "owned_unknown" }, "purchases not read: never offered");
  assert.deepEqual(nextStepShown({ ...base, dismissed: true }), { shown: false, why: "dismissed" });
  assert.deepEqual(nextStepShown({ ...base, dismissed: "unknown" }), { shown: false, why: "dismissed" }, "a No thanks not read is taken as said");
});

test("the card sits on the course's home and after the last lesson, never in the middle of the lessons", () => {
  assert.equal(nextStepPlace({ page: "course", finishedNow: false }), true);
  assert.equal(nextStepPlace({ page: "lesson", finishedNow: true }), true);
  assert.equal(nextStepPlace({ page: "lesson", finishedNow: false }), false);
});
