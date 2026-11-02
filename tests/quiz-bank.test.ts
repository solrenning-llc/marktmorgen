/**
 * 630 [HN6](7), unit 1: a quiz's question bank (lib/quiz-bank-rules.ts,
 * lib/quiz.ts). The same try always draws the same questions in the same
 * order, so grading can draw them again; another try or student draws
 * others; the wait counts from the last try; the settings are kept only
 * within bounds.
 */
import { MAX_WAIT_MINUTES, drawn, trySeed, waitLeft } from "@/lib/quiz-bank-rules";
import { parseQuiz, readQuiz } from "@/lib/quiz";
import { done, is, part } from "./check";

part("Drawing questions for a try");
const seed = trySeed("course1", "lesson1", "ana", 1);
is("no bank: every question, in order", drawn(5, 0, false, seed), [0, 1, 2, 3, 4]);
is("draw 3 of 10: three, in the quiz's order", (() => { const d = drawn(10, 3, false, seed); return [d.length, [...d].sort((a, b) => a - b).join() === d.join(), new Set(d).size]; })(), [3, true, 3]);
is("the same try draws the same set again (for grading)", drawn(10, 3, true, seed), drawn(10, 3, true, seed));
const others = new Set(Array.from({ length: 12 }, (_, t) => drawn(10, 3, false, trySeed("course1", "lesson1", "ana", t + 1)).join()));
is("other tries draw other sets", others.size > 4, true);
is("another student's first try differs", drawn(10, 3, false, trySeed("course1", "lesson1", "ben", 1)).join() === drawn(10, 3, false, seed).join(), false);
const shuffled = drawn(8, 0, true, seed);
is("shuffle alone: every question, an order of its own", [[...shuffled].sort((a, b) => a - b).join(), shuffled.join() === "0,1,2,3,4,5,6,7"], ["0,1,2,3,4,5,6,7", false]);
is("draw at or above the total is every question", drawn(4, 9, false, seed), [0, 1, 2, 3]);

part("Waiting between tries");
const t0 = Date.UTC(2026, 10, 2, 12);
is("no wait set: try now", waitLeft(0, t0, t0 + 1000), 0);
is("never tried: try now", waitLeft(30, null, t0), 0);
is("thirty minutes, ten gone: twenty left", waitLeft(30, t0, t0 + 10 * 60_000), 20 * 60);
is("after the wait: try now", waitLeft(30, t0, t0 + 31 * 60_000), 0);

part("Kept only within bounds");
const question = (id: string) => ({ id, text: `Q ${id}`, choices: ["Yes", "No"], correct: [0] });
const raw = { passPercent: 70, attempts: 3, questions: ["q1", "q2", "q3", "q4"].map(question) };
const read = (extra: Record<string, unknown>) => { const r = readQuiz({ ...raw, ...extra }); return r.ok ? { draw: r.quiz.draw, shuffle: r.quiz.shuffle, waitMinutes: r.quiz.waitMinutes } : null; };
is("draw, shuffle and wait kept", read({ draw: 2, shuffle: true, waitMinutes: 60 }), { draw: 2, shuffle: true, waitMinutes: 60 });
is("draw of every question or more: not kept (it would be no bank)", read({ draw: 4 }).draw, undefined);
is("a wait past one day: not kept", read({ waitMinutes: MAX_WAIT_MINUTES + 1 }).waitMinutes, undefined);
is("none set: none kept", read({}), { draw: undefined, shuffle: undefined, waitMinutes: undefined });
const saved = readQuiz({ ...raw, draw: 2, waitMinutes: 15 });
is("read back from storage the same", saved.ok ? [parseQuiz(JSON.stringify(saved.quiz))?.draw, parseQuiz(JSON.stringify(saved.quiz))?.waitMinutes] : null, [2, 15]);

done();
